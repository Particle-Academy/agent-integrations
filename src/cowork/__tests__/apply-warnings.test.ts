// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCoworkSession, type CoworkSession } from "../session";
import { createServerTransport, type PresenceChannelLike } from "../transport";

/*
 * A consumer's subject page received the admin's `cowork.intent` (field "composer",
 * "Hello from support") and the composer, a contentEditable DIV, stayed empty with
 * nothing on the console. Three places between the commit and the composer were silent:
 * no adapter at all, an adapter whose setField reports ok without changing the field
 * (setting `.value` on a div does exactly that), and a value waiting for the person to
 * leave the field. Each now warns once. The payloads are the consumer's, verbatim.
 */

function channelDouble() {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const channel: PresenceChannelLike = {
    here() { return channel; }, joining() { return channel; }, leaving() { return channel; },
    whisper() { return channel; }, listenForWhisper() { return channel; },
    listen(event, cb) { (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(cb); return channel; },
    stopListening(event, cb) { if (cb) listeners.get(event)?.delete(cb); return channel; },
  };
  return { channel, relay: (p: unknown) => { for (const cb of listeners.get(".cowork.intent") ?? []) cb(p); } };
}
const SESSION = "01M7HET0F16A6DYGN7H0SBK3WA";
const sync = (mode = "ranked") => ({ ok: true, status: 200, json: async () => ({ session: { state: "live", starter: "user:1", consent: "notify", consented: false, routing: "server",
  control: mode === "ranked" ? { mode: "ranked", scope: "session", idleMs: 3000, views: {} } : { mode, views: {} },
  participants: [
    { ref: "user:1", actingFor: "user:4", route: "/dashboard", revision: 0, follows: "user:4", rank: 2 },
    { ref: "user:4", route: "/dashboard", revision: 0, follows: "user:1", rank: 1 },
  ] } }) }) as unknown as Response;
// The consumer's two frames, verbatim.
const cursor = { id: "user1-8pf21ve2hy", session: SESSION, from: "user:1", intent: { kind: "cursor", route: "/dashboard", anchor: '[data-co-handle="composer"]', fx: 0.4999, fy: 0.5 } };
const field = { id: "user1-g1l5m6br0l", session: SESSION, from: "user:1", view: "user:1", revision: 0, intent: { kind: "field", handle: "composer", value: "Hello from support" } };

let sessions: CoworkSession[] = [];
let warn: { mock: { calls: unknown[][] } };
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {}) as never;
  document.body.innerHTML = '<div contenteditable="true" data-co-handle="composer"></div>';
});
afterEach(() => {
  for (const s of sessions) s.destroy();
  sessions = [];
  vi.restoreAllMocks();
});
const warned = (text: string) => warn.mock.calls.filter((c) => String(c[0]).includes(text));
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const composer = () => document.querySelector('[data-co-handle="composer"]') as HTMLElement;

function subject(extra: Record<string, unknown> = {}, mode = "ranked") {
  const d = channelDouble();
  const s = createCoworkSession({
    sessionId: SESSION, self: { ref: "user:4", label: "Bob" },
    transport: createServerTransport({ sessionId: SESSION, self: "user:4", channel: d.channel, fetch: (async () => sync(mode)) as never }),
    config: { consent: "notify", control: { mode: "ranked", scope: "session", idleMs: 3000, rank: (ref: string) => (ref === "user:4" ? 1 : 2) } },
    authorize: () => true, presenceRouting: "server", sharedFields: ["composer"], heartbeatMs: 60_000,
    ...extra,
  } as never);
  sessions.push(s);
  return { s, relay: d.relay };
}
const valueSetter = { getLocation: () => ({ url: "/dashboard", title: "" }), describe: () => ({ url: "/dashboard", title: "", actions: [] }), visit: () => {}, scrollTo: () => {}, scrollBy: () => {}, click: () => ({ ok: true }), submit: () => ({ ok: true }) };

describe("the consumer's exact frames on a contentEditable composer", () => {
  it("are committed and hold the subject, whatever the adapter does", async () => {
    const { s, relay } = subject({ adapter: { ...valueSetter, setField: () => ({ ok: true }) } });
    await settle();
    relay(cursor);
    relay(field);
    await settle();
    expect(s.getSnapshot().blocked).toMatchObject({ by: "user:1", mode: "ranked" });
  });

  it("with NO adapter: the value cannot be applied, and that is warned once", async () => {
    const { relay } = subject();
    await settle();
    relay(field);
    relay({ ...field, id: "x2", intent: { ...field.intent, value: "Hello again" } });
    await settle();
    const w = warned("no adapter");
    expect(w).toHaveLength(1);
    expect(String(w[0]![0])).toContain("composer");
  });

  it("with an adapter whose setField reports ok but writes `.value` on the div: warned once", async () => {
    const { relay } = subject({ adapter: { ...valueSetter, setField: (h: string, v: unknown) => { (document.querySelector(`[data-co-handle="${h}"]`) as unknown as { value: unknown }).value = v; return { ok: true }; } } });
    await settle();
    relay(field);
    await settle();
    // Checked after a moment: a React-controlled field only updates on its next render.
    await new Promise((r) => setTimeout(r, 400));
    expect(composer().textContent).toBe("");
    const w = warned("did not change");
    expect(w).toHaveLength(1);
    expect(String(w[0]![0])).toContain("contenteditable");
  });

  it("with an adapter that writes the text: applied, nothing warned", async () => {
    const { relay } = subject({ adapter: { ...valueSetter, setField: (h: string, v: unknown) => { (document.querySelector(`[data-co-handle="${h}"]`) as HTMLElement).textContent = String(v); return { ok: true }; } } });
    await settle();
    relay(field);
    await settle();
    expect(composer().textContent).toBe("Hello from support");
    expect(warn.mock.calls).toHaveLength(0);
  });

  it("a value waiting for the person to leave the field is warned once (free control: nobody is held)", async () => {
    const { relay } = subject({
      config: { consent: "notify", control: { mode: "free" } },
      adapter: { ...valueSetter, setField: (h: string, v: unknown) => { (document.querySelector(`[data-co-handle="${h}"]`) as HTMLElement).textContent = String(v); return { ok: true }; } },
    }, "free");
    await settle();
    composer().tabIndex = 0;
    composer().focus();
    relay(field);
    relay({ ...field, id: "x3", intent: { ...field.intent, value: "Hello again" } });
    await settle();
    expect(warned("leaves the field")).toHaveLength(1);
  });
});
