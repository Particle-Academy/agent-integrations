// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDomNavigationAgent } from "../../dom-navigation/agent";
import { createCoworkSession, type CoworkSession } from "../session";
import { createServerTransport, type PresenceChannelLike } from "../transport";

/*
 * A consumer's 0.65.4 trace: the admin's field frame arrived on the subject's page and
 * waited "queued waiting=2" for over 1.5 s, behind the subject's OWN field POST (and
 * whatever else was in the one queue), before it was committed and applied. Meanwhile the
 * subject was not held (the hold started at dequeue), so he typed, and his POST got 409.
 * Now the page's own network calls (intent and cursor POSTs, re-sync GETs) are never made
 * inside the state queue: a received frame is judged and applied at once, its hold starts
 * when it ARRIVES, `queued` names the steps ahead, and a held person's swallowed typing is
 * traced.
 */

function channelDouble() {
  const listeners = new Set<(p: unknown) => void>();
  let here: ((m: unknown[]) => void) | null = null;
  const channel: PresenceChannelLike = {
    here(cb) { here = cb; return channel; }, joining() { return channel; }, leaving() { return channel; },
    whisper() { return channel; }, listenForWhisper() { return channel; },
    listen(_e, cb) { listeners.add(cb); return channel; }, stopListening() { return channel; },
  };
  return { channel, relay: (p: unknown) => { for (const cb of listeners) cb(p); }, fireHere: (m: unknown[]) => here?.(m) };
}
const syncBody = { session: { control: { mode: "ranked", scope: "session", idleMs: 3000, views: {} }, participants: [
  { ref: "user:1", route: "/dashboard", revision: 0, follows: null, rank: 2 },
  { ref: "user:4", route: "/dashboard", revision: 0, follows: null, rank: 1 },
] } };
const field = (value: string, id = `f${value}`) => ({ id, session: "s1", from: "user:1", view: "user:1", revision: 0, intent: { kind: "field", handle: "composer", value } });

let sessions: CoworkSession[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div contenteditable="true" data-co-handle="composer"></div>';
});
afterEach(() => {
  for (const s of sessions) s.destroy();
  sessions = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-cowork-blocked");
});

/** A server whose POSTs (or GETs, after the first) take `slowMs` to answer. */
function subject(opts: { slowPostMs?: number; slowSyncMs?: number; debug?: boolean } = {}) {
  const { channel, relay, fireHere } = channelDouble();
  let syncs = 0;
  const fetchFn = (async (_url: string, init?: { method?: string }) => {
    const get = (init?.method ?? "GET") === "GET";
    const delay = get ? (syncs++ > 0 ? opts.slowSyncMs ?? 0 : 0) : opts.slowPostMs ?? 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return get ? { ok: true, status: 200, json: async () => syncBody } : { ok: true, status: 202, json: async () => ({}) };
  }) as never;
  const s = createCoworkSession({
    sessionId: "s1", self: { ref: "user:4" }, debug: opts.debug,
    transport: createServerTransport({ sessionId: "s1", self: "user:4", channel, fetch: fetchFn }),
    config: { consent: "notify", control: { mode: "ranked", scope: "session", rank: (r: string) => (r === "user:4" ? 1 : 2), idleMs: 3000 } },
    authorize: () => true, presenceRouting: "server", sharedFields: ["composer"], heartbeatMs: 60_000,
    adapter: { ...createDomNavigationAgent(), visit: () => {} },
    blockInput: { isUserEvent: (e: Event) => (e as Event & { user?: boolean }).user === true },
  } as never);
  sessions.push(s);
  return { s, relay, fireHere };
}
const composer = () => document.querySelector("[data-co-handle]") as HTMLElement;

describe("a received frame never waits on this page's own network calls", () => {
  it("while the page's own field POST is in flight, the admin's field is applied and holds at once", async () => {
    const { s, relay } = subject({ slowPostMs: 2_000 });
    await vi.advanceTimersByTimeAsync(0);
    void s.reportField("composer", "X"); // the subject's POST: 2 s to answer
    await vi.advanceTimersByTimeAsync(10);
    relay(field("Hello from support"));
    await vi.advanceTimersByTimeAsync(10);
    expect(composer().textContent).toBe("Hello from support");
    expect(document.documentElement.getAttribute("data-cowork-blocked")).toBe("ranked");
  });

  it("while a cursor POST is in flight, likewise", async () => {
    const { s, relay } = subject({ slowPostMs: 2_000 });
    await vi.advanceTimersByTimeAsync(0);
    s.moveCursor({ x: 10, y: 10 });
    await vi.advanceTimersByTimeAsync(150);
    relay(field("Hi"));
    await vi.advanceTimersByTimeAsync(10);
    expect(composer().textContent).toBe("Hi");
  });

  it("while a re-sync GET is in flight, likewise", async () => {
    const { relay, fireHere } = subject({ slowSyncMs: 2_000 });
    await vi.advanceTimersByTimeAsync(0);
    // A presence acknowledgement starts a re-sync: this one's GET takes 2 s.
    fireHere([{ ref: "user:1" }, { ref: "user:4" }]);
    await vi.advanceTimersByTimeAsync(10);
    relay(field("Yo"));
    await vi.advanceTimersByTimeAsync(10);
    expect(composer().textContent).toBe("Yo");
  });

  it("the hold starts when the frame ARRIVES: until = arrival + idleMs", async () => {
    const { s, relay } = subject();
    await vi.advanceTimersByTimeAsync(0);
    const arrived = Date.now();
    relay(field("Hello"));
    // Before anything is dequeued: synchronously after the frame reached the transport.
    expect(s.getSnapshot().blocked).toMatchObject({ by: "user:1", until: arrived + 3000 });
    expect(document.documentElement.getAttribute("data-cowork-blocked")).toBe("ranked");
  });
});

describe("debug names what is queued ahead, and a held person's swallowed typing", () => {
  it("`queued` lists the steps ahead; a key swallowed while held is traced", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { relay } = subject({ debug: true });
    await vi.advanceTimersByTimeAsync(0);
    relay(field("Hello"));
    composer().dispatchEvent(Object.assign(new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }), { user: true }));
    await vi.advanceTimersByTimeAsync(10);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("queued") && l.includes("ahead="))).toBe(true);
    expect(lines.some((l) => l.includes("input blocked while held") && l.includes("keydown"))).toBe(true);
  });
});
