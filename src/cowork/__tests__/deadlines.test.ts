// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCoworkSession, type CoworkSession } from "../session";
import { createServerTransport, type PeerTransport, type PresenceChannelLike } from "../transport";

/*
 * Every receive, send and re-sync of a session runs through ONE queue, and nothing in it
 * had a deadline: a host `fetch` that never settles (a re-sync GET, a /follow or /intents
 * POST) stopped everything after it, silently, so a page kept receiving frames on its
 * transport and never applied one. Now a transport request has a deadline, and a step
 * that waits too long is warned.
 */

const channel: PresenceChannelLike = {
  here() { return channel; }, joining() { return channel; }, leaving() { return channel; },
  whisper() { return channel; }, listenForWhisper() { return channel; }, listen() { return channel; }, stopListening() { return channel; },
};
const never = (() => new Promise<Response>(() => {})) as never;

let sessions: CoworkSession[] = [];
let warn: { mock: { calls: unknown[][] } };
beforeEach(() => {
  vi.useFakeTimers();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {}) as never;
  document.body.innerHTML = '<div id="root"></div>';
});
afterEach(() => {
  for (const s of sessions) s.destroy();
  sessions = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const warned = (text: string) => warn.mock.calls.filter((c) => String(c[0]).includes(text));

describe("transport deadlines", () => {
  it("an intent POST that never answers resolves as a timeout after requestTimeoutMs", async () => {
    const t = createServerTransport({ sessionId: "s", self: "a", channel, fetch: never, requestTimeoutMs: 2_000 });
    const sent = t.send({ t: "intent", envelope: { id: "x", view: "a", revision: 0 }, intent: { kind: "scroll", y: 1 } });
    await vi.advanceTimersByTimeAsync(2_001);
    await expect(sent).resolves.toMatchObject({ allow: false, reason: "cowork.transport.timeout" });
  });

  it("a re-sync that never answers resolves to nothing, warned once, with the default 10 s deadline", async () => {
    const t = createServerTransport({ sessionId: "s", self: "a", channel, fetch: never });
    const first = t.sync!();
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(first).resolves.toBeNull();
    const second = t.sync!();
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(second).resolves.toBeNull();
    expect(warned("did not answer")).toHaveLength(1);
  });

  it("with a hanging fetch, the session's queue moves on: a later send settles", async () => {
    const s = createCoworkSession({
      sessionId: "s", self: { ref: "a" },
      transport: createServerTransport({ sessionId: "s", self: "a", channel, fetch: never, requestTimeoutMs: 1_000 }),
      config: { consent: "notify", control: { mode: "free" } }, authorize: () => true,
      root: document.getElementById("root")!, presenceRouting: "server", heartbeatMs: 60_000,
    });
    sessions.push(s);
    const decision = s.sendIntent({ kind: "scroll", y: 1 });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(decision).resolves.toMatchObject({ allow: false, reason: "cowork.transport.timeout" });
  });
});

describe("a session step that waits too long", () => {
  it("is warned once, so a stuck queue is never silent", async () => {
    // A transport of the host's own whose re-sync never settles.
    const transport: PeerTransport = {
      routing: "server",
      send: async () => ({ allow: true }) as never,
      onFrame: () => () => {}, onPresence: () => () => {}, close: () => {},
      sync: () => new Promise(() => {}),
    };
    const s = createCoworkSession({
      sessionId: "s", self: { ref: "a" }, transport,
      config: { consent: "notify", control: { mode: "free" } }, authorize: () => true,
      root: document.getElementById("root")!, presenceRouting: "server",
    });
    sessions.push(s);
    void s.sendIntent({ kind: "scroll", y: 1 });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(warned("waiting")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(20_000);
    const w = warned("waiting");
    expect(w).toHaveLength(1);
    expect(String(w[0]![0])).toContain("queued");
  });
});

describe("an adapter call that never settles", () => {
  it("a followed leader's visit whose adapter.visit never settles does not stall the field behind it", async () => {
    const listeners = new Set<(p: unknown) => void>();
    const ch: PresenceChannelLike = { ...channel, listen(_e, cb) { listeners.add(cb); return ch; } };
    const relay = (p: unknown) => { for (const cb of listeners) cb(p); };
    const sync = async () => ({ ok: true, status: 200, json: async () => ({ session: {
      control: { mode: "ranked", scope: "session", idleMs: 3000, views: {} },
      participants: [
        { ref: "user:1", route: "/dashboard", revision: 0, follows: null, rank: 2 },
        { ref: "user:4", route: "/dashboard", revision: 0, follows: "user:1", rank: 1 },
      ] } }) }) as unknown as Response;
    document.body.innerHTML = '<div contenteditable="true" data-co-handle="composer"></div>';
    const s = createCoworkSession({
      sessionId: "s", self: { ref: "user:4" },
      transport: createServerTransport({ sessionId: "s", self: "user:4", channel: ch, fetch: sync as never }),
      config: { consent: "notify", control: { mode: "ranked", scope: "session", rank: (r: string) => (r === "user:4" ? 1 : 2), idleMs: 3000 } },
      authorize: () => true, presenceRouting: "server", sharedFields: ["composer"], adapterTimeoutMs: 2_000,
      adapter: {
        getLocation: () => ({ url: "/dashboard", title: "" }), describe: () => ({ url: "/dashboard", title: "", actions: [] }),
        visit: () => new Promise(() => {}), // the host's openView(url) never settles
        scrollTo: () => {}, scrollBy: () => {}, click: () => ({ ok: true }), submit: () => ({ ok: true }),
        setField: (h: string, v: unknown) => { (document.querySelector(`[data-co-handle="${h}"]`) as HTMLElement).textContent = String(v); return { ok: true }; },
      } as never,
    });
    sessions.push(s);
    await vi.advanceTimersByTimeAsync(0);
    relay({ id: "v", session: "s", from: "user:1", view: "user:1", revision: 0, intent: { kind: "visit", url: "/orders" } });
    relay({ id: "f", session: "s", from: "user:1", view: "user:1", revision: 1, intent: { kind: "field", handle: "composer", value: "Hello from support" } });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(warned("cowork.apply.timeout")).toHaveLength(1);
    // The field behind it was processed: committed (it holds), though routes now differ.
    expect(s.getSnapshot().blocked).toMatchObject({ by: "user:1" });
  });
});

describe("a pending follow does not hold the queue", () => {
  it("a relayed field is committed while the /follow POST is still waiting", async () => {
    const listeners = new Set<(p: unknown) => void>();
    const ch: PresenceChannelLike = { ...channel, listen(_e, cb) { listeners.add(cb); return ch; } };
    const relay = (p: unknown) => { for (const cb of listeners) cb(p); };
    const fetchFn = (async (url: string, init?: { method?: string }) => {
      if (String(url).endsWith("/follow")) return new Promise(() => {}); // the consumer's hung POST
      if ((init?.method ?? "GET") === "GET") {
        return { ok: true, status: 200, json: async () => ({ session: {
          control: { mode: "ranked", scope: "session", idleMs: 3000, views: {} },
          participants: [
            { ref: "user:1", route: "/dashboard", revision: 0, follows: null, rank: 2 },
            { ref: "user:4", route: "/dashboard", revision: 0, follows: null, rank: 1 },
          ] } }) };
      }
      return { ok: true, status: 202, json: async () => ({}) };
    }) as never;
    const s = createCoworkSession({
      sessionId: "s", self: { ref: "user:4" },
      transport: createServerTransport({ sessionId: "s", self: "user:4", channel: ch, fetch: fetchFn }),
      config: { consent: "notify", control: { mode: "ranked", scope: "session", rank: (r: string) => (r === "user:4" ? 1 : 2), idleMs: 3000 } },
      authorize: () => true, presenceRouting: "server",
    });
    sessions.push(s);
    await vi.advanceTimersByTimeAsync(0);
    const following = s.follow("user:1");
    await vi.advanceTimersByTimeAsync(10);
    relay({ id: "f", session: "s", from: "user:1", view: "user:1", revision: 0, intent: { kind: "field", handle: "composer", value: "Hi" } });
    await vi.advanceTimersByTimeAsync(50); // far inside the 10 s request deadline
    expect(s.getSnapshot().blocked).toMatchObject({ by: "user:1" });
    await vi.advanceTimersByTimeAsync(10_500);
    await expect(following).resolves.toMatchObject({ allow: false, reason: "cowork.transport.timeout" });
  });
});
