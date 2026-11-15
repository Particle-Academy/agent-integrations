// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCoworkSession, type CoworkSession } from "../session";
import { readSync, type CoworkFrame, type CoworkSyncState, type PeerTransport, type ReceivedFrame } from "../transport";
import type { Decision } from "../types";

/*
 * The server is the authority on ranked control. A browser must never need to know
 * other people's roles to hold its person: the re-sync publishes each participant's
 * effective rank, the scope and the idle window (fixture `expectRanked`), and the
 * client uses them, falling back to the host's rank function only where the server
 * sent nothing. When the two disagree the server wins, with one console warning.
 */

function serverDouble(sync: CoworkSyncState | null) {
  const sent: CoworkFrame[] = [];
  let deliver: ((m: ReceivedFrame) => void) | null = null;
  const transport: PeerTransport = {
    routing: "server",
    send: async (frame) => { sent.push(frame); return { allow: true } as Decision; },
    onFrame: (fn) => { deliver = fn; return () => { deliver = null; }; },
    onPresence: () => () => {},
    close: () => {},
    sync: async () => sync,
    heartbeat: async () => ({ allow: true }),
  };
  /** A relayed intent, as the server stamps it. */
  const relay = (from: string, view: string, intent: Record<string, unknown>) =>
    deliver?.({ from, frame: { t: "intent", envelope: { id: `e${Math.random()}`, view, revision: 0 }, intent } as never });
  return { transport, sent, relay };
}

const published = (over: Partial<{ ranks: Record<string, number>; scope: string; idleMs: number; mode: string }> = {}): CoworkSyncState =>
  readSync({
    session: {
      control: { mode: over.mode ?? "ranked", scope: over.scope ?? "session", idleMs: over.idleMs ?? 3000, views: {} },
      participants: [
        { ref: "user:1", route: "/dashboard", revision: 0, follows: "user:4", actingFor: "user:4", ...(over.ranks?.["user:1"] !== undefined ? { rank: over.ranks["user:1"] } : {}) },
        { ref: "user:4", route: "/dashboard", revision: 0, follows: "user:1", ...(over.ranks?.["user:4"] !== undefined ? { rank: over.ranks["user:4"] } : {}) },
      ],
    },
  })!;

let sessions: CoworkSession[] = [];
let clock = 50_000;
beforeEach(() => {
  vi.useFakeTimers();
  clock = 50_000;
  document.body.innerHTML = '<div id="root"><textarea data-co-handle="composer"></textarea></div>';
});
afterEach(() => {
  for (const s of sessions) s.destroy();
  sessions = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function bob(transport: PeerTransport, control: Record<string, unknown>) {
  const s = createCoworkSession({
    sessionId: "s1",
    self: { ref: "user:4" },
    transport,
    config: { consent: "notify", control } as never,
    authorize: () => true,
    root: document.getElementById("root")!,
    presenceRouting: "server",
    sharedFields: ["composer"],
    heartbeatMs: 60_000,
    now: () => clock,
  });
  sessions.push(s);
  return s;
}
const settle = async () => { for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0); };

describe("readSync", () => {
  it("reads each participant's published rank, and the scope and idle window", () => {
    const sync = published({ ranks: { "user:1": 2, "user:4": 1 }, scope: "session", idleMs: 2500 });
    expect(sync.participants.map((p) => [p.ref, p.rank])).toEqual([["user:1", 2], ["user:4", 1]]);
    expect(sync.control).toMatchObject({ mode: "ranked", scope: "session", idleMs: 2500 });
  });

  it("drops a rank, scope or idle window that is not well-formed", () => {
    const sync = readSync({
      control: { mode: "ranked", scope: "everything", idleMs: -5 },
      participants: [{ ref: "a", route: "/", revision: 0, follows: null, rank: "high" }, { ref: "b", route: "/", revision: 0, follows: null, rank: Number.NaN }],
    })!;
    expect(sync.participants.map((p) => p.rank)).toEqual([undefined, undefined]);
    expect(sync.control?.scope).toBeUndefined();
    expect(sync.control?.idleMs).toBeUndefined();
  });
});

describe("published ranked control", () => {
  it("holds Bob from the admin's relayed intent although Bob's own rank function knows nobody else's role", async () => {
    const { transport, relay } = serverDouble(published({ ranks: { "user:1": 2, "user:4": 1 } }));
    // The page only knows its own person: everyone else ranks 0 here.
    const s = bob(transport, { mode: "ranked", scope: "session", idleMs: 3000, rank: (ref: string) => (ref === "user:4" ? 1 : 0) });
    await settle();
    relay("user:1", "user:1", { kind: "field", handle: "composer", value: "Hello" });
    await settle();
    expect(s.getSnapshot().blocked).toMatchObject({ by: "user:1", mode: "ranked", until: clock + 3000 });
    expect(document.getElementById("root")!.getAttribute("data-cowork-blocked")).toBe("ranked");
  });

  it("takes the server's scope and idle window over the host's", async () => {
    const { transport, relay } = serverDouble(published({ ranks: { "user:1": 2, "user:4": 1 }, scope: "session", idleMs: 1500 }));
    // The host left scope per view: the admin's own view would never hold Bob.
    const s = bob(transport, { mode: "ranked", rank: { "user:1": 2, "user:4": 1 } });
    await settle();
    relay("user:1", "user:1", { kind: "field", handle: "composer", value: "Hi" });
    await settle();
    expect(s.getSnapshot().blocked).toMatchObject({ by: "user:1", until: clock + 1500 });
  });

  it("the server wins a disagreement, with ONE console warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { transport, relay } = serverDouble(published({ ranks: { "user:1": 1, "user:4": 2 } }));
    // The host thinks the admin outranks Bob; the server says the opposite.
    const s = bob(transport, { mode: "ranked", scope: "session", rank: { "user:1": 2, "user:4": 1 } });
    await settle();
    relay("user:1", "user:1", { kind: "field", handle: "composer", value: "Hi" });
    await settle();
    expect(s.getSnapshot().blocked).toBeNull();
    s.refresh();
    await settle();
    const mine = warn.mock.calls.filter((c) => String(c[0]).includes("rank"));
    expect(mine).toHaveLength(1);
    expect(String(mine[0]![0])).toContain("user:1");
  });

  it("falls back to the host's rank function for a ref the server did not rank (an older server sends none)", async () => {
    const { transport, relay } = serverDouble(published({ ranks: {} }));
    const s = bob(transport, { mode: "ranked", scope: "session", rank: { "user:1": 2, "user:4": 1 } });
    await settle();
    relay("user:1", "user:1", { kind: "field", handle: "composer", value: "Hi" });
    await settle();
    expect(s.getSnapshot().blocked).toMatchObject({ by: "user:1" });
  });

  it("the server's ranked mode applies even where the host configured another mode", async () => {
    const { transport, relay } = serverDouble(published({ ranks: { "user:1": 2, "user:4": 1 } }));
    const s = bob(transport, { mode: "free" });
    await settle();
    relay("user:1", "user:1", { kind: "field", handle: "composer", value: "Hi" });
    await settle();
    expect(s.getSnapshot().blocked).toMatchObject({ by: "user:1", mode: "ranked" });
  });
});
