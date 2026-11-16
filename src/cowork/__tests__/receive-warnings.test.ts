// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCoworkSession, type CoworkSession } from "../session";
import { createServerTransport, type PresenceChannelLike } from "../transport";

/*
 * MOIC on 0.65.0: Bob's socket received the admin's relayed `cowork.intent` frames,
 * yet his page never applied the value, was never held, and logged NOTHING. Every
 * place a received intent can be dropped returned silently. Each now warns on the
 * console once (per reason), like the sender side, and a transport whose `self` is not
 * the session's `self` (which drops every intent from the person it names as "own")
 * is warned the moment the session starts.
 */

function channelDouble() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const channel: PresenceChannelLike = {
    here() { return channel; },
    joining() { return channel; },
    leaving() { return channel; },
    whisper() { return channel; },
    listenForWhisper() { return channel; },
    listen(event, cb) { (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(cb); return channel; },
    stopListening(event, cb) { if (cb) listeners.get(event)?.delete(cb); return channel; },
  };
  const relay = (payload: unknown) => { for (const cb of listeners.get(".cowork.intent") ?? []) cb(payload); };
  return { channel, relay };
}

const ok = () => ({ ok: true, status: 200, json: async () => ({ session: { participants: [
  { ref: "user:1", route: "/dashboard", revision: 0, follows: null },
  { ref: "user:4", route: "/dashboard", revision: 0, follows: null },
] } }) }) as unknown as Response;

let sessions: CoworkSession[] = [];
let warn: { mock: { calls: unknown[][] } } & ((...a: unknown[]) => void);
beforeEach(() => {
  vi.useFakeTimers();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {}) as never;
  document.body.innerHTML = '<div id="root"><textarea data-co-handle="composer"></textarea></div>';
});
afterEach(() => {
  for (const s of sessions) s.destroy();
  sessions = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const warned = (text: string) => warn.mock.calls.filter((c) => String(c[0]).includes(text));
const settle = async () => { for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0); };

function bob(transportSelf: string, sharedFields = ["composer"]) {
  const { channel, relay } = channelDouble();
  const s = createCoworkSession({
    sessionId: "s1",
    self: { ref: "user:4" },
    transport: createServerTransport({ sessionId: "s1", self: transportSelf, channel, fetch: (async () => ok()) as never }),
    config: { consent: "notify", control: { mode: "ranked", scope: "session", rank: { "user:1": 2, "user:4": 1 } } },
    authorize: () => true,
    root: document.getElementById("root")!,
    presenceRouting: "server",
    sharedFields,
    heartbeatMs: 60_000,
    adapter: { getLocation: () => ({ url: "/dashboard", title: "" }), describe: () => ({ url: "/dashboard", title: "", actions: [] }), visit: () => {}, scrollTo: () => {}, scrollBy: () => {}, setField: () => ({ ok: true }), click: () => ({ ok: true }), submit: () => ({ ok: true }) } as never,
  });
  sessions.push(s);
  return { s, relay };
}
const field = (value: string) => ({ id: `e${value}`, session: "s1", from: "user:1", view: "user:1", revision: 0, at: 1, intent: { kind: "field", handle: "composer", value } });

describe("receive-path drops are warned", () => {
  it("a transport whose self is not the session's self is warned at once, and its dropped 'own' intents too", async () => {
    // Bob's page built its transport with the ADMIN's ref.
    const { s, relay } = bob("user:1");
    await settle();
    expect(warned("transport").length).toBe(1);
    expect(String(warned("transport")[0]![0])).toContain("user:1");
    expect(String(warned("transport")[0]![0])).toContain("user:4");

    relay(field("a"));
    relay(field("b"));
    await settle();
    expect(s.getSnapshot().blocked).toBeNull();
    const own = warned("are ignored as this page's own");
    expect(own).toHaveLength(1); // once, not per frame
  });

  it("a malformed relay (not an object, no sender, no intent) is warned once per reason", async () => {
    const { relay } = bob("user:4");
    await settle();
    relay("not json");
    relay("again");
    relay({ intent: { kind: "field" } });
    relay({ from: "user:1", id: "x" });
    await settle();
    expect(warned("relayed").length).toBe(3);
  });

  it("a shared field from a peer on ANOTHER route is warned, with both routes", async () => {
    const { relay } = bob("user:4");
    await settle();
    relay({ id: "v", session: "s1", from: "user:1", view: "user:1", revision: 0, at: 1, intent: { kind: "visit", url: "/orders" } });
    relay(field("x"));
    relay(field("y"));
    await settle();
    const route = warned("route");
    expect(route).toHaveLength(1);
    expect(String(route[0]![0])).toContain("/orders");
    expect(String(route[0]![0])).toContain("/dashboard");
  });

  it("a field this page does not share is warned once", async () => {
    const { relay } = bob("user:4", ["notes"]);
    await settle();
    relay(field("x"));
    relay(field("y"));
    await settle();
    expect(warned("sharedFields")).toHaveLength(1);
  });

  it("a correctly built page warns nothing and is held", async () => {
    const { s, relay } = bob("user:4");
    await settle();
    relay(field("x"));
    await settle();
    expect(warn).not.toHaveBeenCalled();
    expect(s.getSnapshot().blocked).toMatchObject({ by: "user:1" });
  });
});
