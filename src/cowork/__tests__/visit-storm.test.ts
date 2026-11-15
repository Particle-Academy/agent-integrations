// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCoworkSession, type CoworkSession } from "../session";
import type { CoworkFrame, PeerTransport } from "../transport";
import type { Decision } from "../types";

/*
 * MOIC's re-test on 0.4.0 / 0.64.0: a page reported its URL from an effect keyed on
 * the session HANDLE, which changes on every snapshot change. Each visit committed a
 * new revision, so the effect ran again: a visit storm (revisions 1, 2, 3 in a row).
 * On a slow host every visit was a serial POST, and the admin's field reports waited
 * behind them, so his typing sent nothing; Bob was never held by a field that never
 * arrived. Reproduced on the real stack (fancy-cowork 0.4.0 host, 0.64.0 client):
 * 8 visit POSTs and no field POST in the window after typing.
 */

type Sent = { frame: CoworkFrame; at: number };

function slowServer(latencyMs = 1_800) {
  const sent: Sent[] = [];
  const transport: PeerTransport = {
    routing: "server",
    send: (frame) =>
      new Promise((resolve) => {
        sent.push({ frame, at: Date.now() });
        setTimeout(() => resolve({ allow: true } as Decision), latencyMs);
      }),
    onFrame: () => () => {},
    onPresence: () => () => {},
    close: () => {},
    sync: async () => null,
    heartbeat: async () => ({ allow: true }),
  };
  return { transport, sent };
}

const intents = (sent: Sent[], kind: string) =>
  sent
    .filter((s) => s.frame.t === "intent" && (s.frame as { intent: { kind: string } }).intent.kind === kind)
    .map((s) => (s.frame as { intent: { url?: string; value?: unknown } }).intent);

let sessions: CoworkSession[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"><textarea data-co-handle="composer"></textarea></div>';
});
afterEach(() => {
  for (const s of sessions) s.destroy();
  sessions = [];
  vi.useRealTimers();
});

function session(transport: PeerTransport) {
  const s = createCoworkSession({
    sessionId: "s",
    self: { ref: "admin" },
    transport,
    config: { control: { mode: "free" } },
    authorize: () => true,
    root: document.getElementById("root")!,
    presenceRouting: "server",
    heartbeatMs: 60_000,
  });
  sessions.push(s);
  return s;
}

const selfRevision = (s: CoworkSession) => s.getSnapshot().peers.find((p) => p.ref === "admin")?.view.revision;

describe("visits", () => {
  it("a visit to the route this page is already on is not sent and does not bump the revision", async () => {
    const { transport, sent } = slowServer(10);
    const s = session(transport);
    await vi.advanceTimersByTimeAsync(0);
    const first = s.reportVisit("/dashboard");
    await vi.advanceTimersByTimeAsync(50);
    expect((await first).allow).toBe(true);
    expect(selfRevision(s)).toBe(1);

    const again = [s.reportVisit("/dashboard"), s.reportVisit("/dashboard?tab=2"), s.reportVisit("/dashboard#top")];
    await vi.advanceTimersByTimeAsync(200);
    for (const d of await Promise.all(again)) expect(d.allow).toBe(true);
    expect(intents(sent, "visit").map((i) => i.url)).toEqual(["/dashboard"]);
    expect(selfRevision(s)).toBe(1);
  });

  it("an effect that reports the URL on every snapshot change sends ONE visit and does not starve field reports", async () => {
    const { transport, sent } = slowServer();
    const s = session(transport);
    // The consumer's effect, keyed on the handle: runs on every snapshot change.
    const off = s.subscribe(() => void s.reportVisit("/dashboard"));
    void s.reportVisit("/dashboard");
    await vi.advanceTimersByTimeAsync(2_000);

    const text = "Hello from support";
    for (let i = 1; i <= text.length; i++) {
      void s.reportField("composer", text.slice(0, i));
      await vi.advanceTimersByTimeAsync(40);
    }
    await vi.advanceTimersByTimeAsync(6_000);
    off();
    expect(intents(sent, "visit").length).toBe(1);
    expect(intents(sent, "field").map((i) => i.value).at(-1)).toBe(text);
    expect(selfRevision(s)).toBe(1);
  });

  it("visits queued behind a slow POST coalesce: only the latest route is sent", async () => {
    const { transport, sent } = slowServer();
    const s = session(transport);
    await vi.advanceTimersByTimeAsync(0);
    void s.reportField("composer", "x");
    await vi.advanceTimersByTimeAsync(10);
    const done = [s.reportVisit("/a"), s.reportVisit("/b"), s.reportVisit("/c")];
    await vi.advanceTimersByTimeAsync(10_000);
    for (const d of await Promise.all(done)) expect(d.allow).toBe(true);
    expect(intents(sent, "visit").map((i) => i.url)).toEqual(["/c"]);
  });
});

// MOIC: one `409 cowork.denied.stale` on Bob's first POST after a visit. The server
// had committed a revision of Bob's OWN view this browser had not (a lost answer, a
// relay it missed). The report describes the page as it is now, so only the counter
// was behind: re-sync, take the server's revision, and send it again, once, silently.
describe("a stale revision of this page's own view", () => {
  function staleOnce(serverRevision: number) {
    const sent: Array<{ frame: CoworkFrame }> = [];
    let syncs = 0;
    const transport: PeerTransport = {
      routing: "server",
      // The server's verdict follows the revision the frame carries.
      send: async (frame) => {
        sent.push({ frame });
        const rev = (frame as { envelope?: { revision?: number } }).envelope?.revision ?? -1;
        return frame.t === "intent" && rev < serverRevision
          ? ({ allow: false, reason: "cowork.denied.stale", status: 409 } as Decision)
          : ({ allow: true } as Decision);
      },
      onFrame: () => () => {},
      onPresence: () => () => {},
      close: () => {},
      // The first sync predates the commit this browser missed; later ones have it.
      sync: async () => ({ participants: [{ ref: "admin", route: "/dashboard", revision: syncs++ === 0 ? 0 : serverRevision, follows: null }] }) as never,
      heartbeat: async () => ({ allow: true }),
    };
    return { transport, sent };
  }

  it("re-syncs and re-sends once with the server's revision; nothing is reported", async () => {
    const { transport, sent } = staleOnce(3);
    const refused: unknown[] = [];
    const s = createCoworkSession({
      sessionId: "s", self: { ref: "admin" }, transport, config: { control: { mode: "free" } }, authorize: () => true,
      root: document.getElementById("root")!, presenceRouting: "server", heartbeatMs: 60_000,
      onRefused: (r) => refused.push(r),
    });
    sessions.push(s);
    await vi.advanceTimersByTimeAsync(0);
    const revs = () => sent.filter((x) => x.frame.t === "intent").map((x) => (x.frame as { envelope: { revision: number } }).envelope.revision);
    const decision = await s.reportField("composer", "hello");
    expect(decision.allow).toBe(true);
    expect(refused).toEqual([]);
    expect(revs().at(-1)).toBe(3);
  });

  it("a second stale answer is reported, not retried forever", async () => {
    const sent: Array<{ frame: CoworkFrame }> = [];
    const transport: PeerTransport = {
      routing: "server",
      send: async (frame) => { sent.push({ frame }); return { allow: false, reason: "cowork.denied.stale", status: 409 } as Decision; },
      onFrame: () => () => {}, onPresence: () => () => {}, close: () => {},
      sync: async () => null, heartbeat: async () => ({ allow: true }),
    };
    const refused: Array<{ reason: string }> = [];
    const s = createCoworkSession({
      sessionId: "s", self: { ref: "admin" }, transport, config: { control: { mode: "free" } }, authorize: () => true,
      root: document.getElementById("root")!, presenceRouting: "server", heartbeatMs: 60_000, onRefused: (r) => refused.push(r),
    });
    sessions.push(s);
    await vi.advanceTimersByTimeAsync(0);
    const decision = await s.reportField("composer", "hello");
    expect(decision).toMatchObject({ allow: false, reason: "cowork.denied.stale" });
    expect(sent.filter((x) => x.frame.t === "intent").length).toBe(2);
    expect(refused.map((r) => r.reason)).toEqual(["cowork.denied.stale"]);
  });

  it("a drive into ANOTHER view that went stale is not retried: that page really moved", async () => {
    const sent: Array<{ frame: CoworkFrame }> = [];
    const transport: PeerTransport = {
      routing: "server",
      send: async (frame) => { sent.push({ frame }); return { allow: false, reason: "cowork.denied.stale", status: 409 } as Decision; },
      onFrame: () => () => {}, onPresence: () => () => {}, close: () => {},
      sync: async () => ({ participants: [
        { ref: "admin", route: "/", revision: 0, follows: null },
        { ref: "bob", route: "/", revision: 0, follows: null },
      ] }) as never,
      heartbeat: async () => ({ allow: true }),
    };
    const s = createCoworkSession({
      sessionId: "s", self: { ref: "admin" }, transport, config: { control: { mode: "free" } }, authorize: () => true,
      root: document.getElementById("root")!, presenceRouting: "server", heartbeatMs: 60_000,
    });
    sessions.push(s);
    await vi.advanceTimersByTimeAsync(0);
    await s.sendIntent({ kind: "field", handle: "composer", value: "x" }, { view: "bob" });
    expect(sent.filter((x) => x.frame.t === "intent").length).toBe(1);
  });
});
