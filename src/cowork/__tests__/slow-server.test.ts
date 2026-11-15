// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCoworkSession, type CoworkSession } from "../session";
import type { CoworkFrame, PeerTransport } from "../transport";
import type { Decision } from "../types";

/*
 * Approved lab test 87, run 762, on a slow host (PHP's built-in server pays a TLS
 * handshake per publish, so each POST takes 1 to 2 s):
 * - every keystroke was its own serial POST, so a 16-character burst drained over
 *   about 16 s, the server kept committing the admin's activity long after he
 *   stopped, and held Bob for that long;
 * - Bob's field reports refused while held (409 with blockedUntil) were never sent
 *   again, so his final value never reached the server;
 * - cursors queued the same way (a 2 s burst took 24 s to drain);
 * - the session whispered `hello` on a server transport, which Sockudo refuses (4301).
 */

type Sent = { frame: CoworkFrame; at: number };

function slowServer(answer: (frame: CoworkFrame, n: number) => Decision = () => ({ allow: true }), latencyMs = 500) {
  const sent: Sent[] = [];
  let n = 0;
  const transport: PeerTransport = {
    routing: "server",
    send: (frame) =>
      new Promise((resolve) => {
        const decision = answer(frame, n++);
        sent.push({ frame, at: Date.now() });
        setTimeout(() => resolve(decision), latencyMs);
      }),
    onFrame: () => () => {},
    onPresence: () => () => {},
    close: () => {},
    sync: async () => null,
    heartbeat: async () => ({ allow: true }),
  };
  return { transport, sent };
}

const fieldValues = (sent: Sent[], handle = "composer") =>
  sent.filter((s) => s.frame.t === "intent" && (s.frame as { intent: { kind: string; handle?: string } }).intent.kind === "field" && (s.frame as { intent: { handle?: string } }).intent.handle === handle)
    .map((s) => (s.frame as { intent: { value: unknown } }).intent.value);

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
    self: { ref: "bob" },
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

describe("a slow server", () => {
  it("coalesces a burst of field reports: few POSTs, the last carries the final value, none older after newer", async () => {
    const { transport, sent } = slowServer();
    const s = session(transport);
    const text = "Hello from support, typed fast on a slow host";
    const done: Array<Promise<Decision>> = [];
    for (let i = 1; i <= text.length; i++) done.push(s.reportField("composer", text.slice(0, i)));
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all(done);
    const values = fieldValues(sent);
    expect(values.length).toBeLessThanOrEqual(3);
    expect(values.at(-1)).toBe(text);
    for (let i = 1; i < values.length; i++) expect(String(values[i]).length).toBeGreaterThan(String(values[i - 1]).length);
  });

  it("re-sends the LATEST value once a server hold (409 blockedUntil) ends", async () => {
    let held = true;
    const { transport, sent } = slowServer((frame) => {
      if (frame.t === "intent" && held) return { allow: false, reason: "cowork.denied.control", status: 409, blockedUntil: Date.now() + 2_000 };
      return { allow: true };
    }, 50);
    const s = session(transport);
    const first = s.reportField("composer", "and beta from bob");
    await vi.advanceTimersByTimeAsync(100);
    await first;
    held = false;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(fieldValues(sent)).toEqual(["and beta from bob", "and beta from bob"]);
  });

  it("re-sends a value refused by the rate limit, once the window passes", async () => {
    let refuse = true;
    const { transport, sent } = slowServer((frame) => (frame.t === "intent" && refuse ? { allow: false, reason: "cowork.denied.rate", status: 429 } : { allow: true }), 50);
    const s = session(transport);
    const first = s.reportField("composer", "one");
    await vi.advanceTimersByTimeAsync(100);
    await first;
    refuse = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fieldValues(sent)).toEqual(["one", "one"]);
  });

  it("a newer report during a hold replaces the pending re-send, which then goes once with the newest value", async () => {
    const until = Date.now() + 2_000;
    const { transport, sent } = slowServer((frame) => (frame.t === "intent" && Date.now() < until
      ? { allow: false, reason: "cowork.denied.control", status: 409, blockedUntil: until } : { allow: true }), 50);
    const s = session(transport);
    const a = s.reportField("composer", "be");
    await vi.advanceTimersByTimeAsync(500);
    const b = s.reportField("composer", "beta");
    await vi.advanceTimersByTimeAsync(3_000);
    await Promise.all([a, b]);
    expect(fieldValues(sent)).toEqual(["be", "beta", "beta"]);
  });

  it("never re-sends a masked field's value", async () => {
    document.body.innerHTML = '<div id="root"><input data-co-handle="pin" type="password" /></div>';
    const { transport, sent } = slowServer((frame) => (frame.t === "intent" ? { allow: false, reason: "cowork.denied.rate", status: 429 } : { allow: true }), 50);
    const s = session(transport);
    void s.reportField("pin", "4242");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(JSON.stringify(sent.map((x) => x.frame))).not.toContain("4242");
  });

  it("coalesces cursors behind a slow send: the final position goes, the queue does not grow", async () => {
    const { transport, sent } = slowServer(() => ({ allow: true }), 1_500);
    const s = session(transport);
    for (let i = 0; i < 20; i++) {
      s.moveCursor({ x: i, y: i });
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(5_000);
    const cursors = sent.filter((x) => x.frame.t === "intent" && (x.frame as { intent: { kind: string } }).intent.kind === "cursor")
      .map((x) => (x.frame as { intent: { x: number } }).intent.x);
    expect(cursors.length).toBeLessThanOrEqual(4);
    expect(cursors.at(-1)).toBe(19);
  });

  it("sends no client-event frame (hello) on a server transport, even on a presence acknowledgement", async () => {
    const { transport, sent } = slowServer();
    let presence: ((event: unknown) => void) | undefined;
    transport.onPresence = (listener) => { presence = listener as (event: unknown) => void; return () => {}; };
    session(transport);
    presence?.({ type: "here", peers: [{ ref: "bob" }, { ref: "admin" }] });
    presence?.({ type: "joining", peer: { ref: "eve" } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(presence).toBeDefined();
    expect(sent.filter((x) => x.frame.t === "hello")).toEqual([]);
  });
});
