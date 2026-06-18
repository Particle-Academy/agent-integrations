import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attachHeuristicsSink, type CollectBatch } from "../sink";
import { emitActivity, resetActivityRegistry } from "../../presence";

/**
 * The sink subscribes to the SAME bundled fancy-auto-common bus the bridges
 * emit into, so `emitActivity` here lands in the sink's `onActivity` listener.
 */

type Beacon = { url: string; body: string };

function collectBeacons(): { beacons: Beacon[]; restore: () => void } {
  const beacons: Beacon[] = [];
  const orig = navigator.sendBeacon;
  // Read Blob text synchronously via FileReader is async; capture the raw
  // string by stubbing Blob-less: our sink passes a Blob, so decode it.
  const spy = vi.fn((url: string, data?: BodyInit) => {
    if (data instanceof Blob) {
      // jsdom Blobs expose .text() (Promise); but we also stash the source.
      beacons.push({ url, body: (data as Blob & { __body?: string }).__body ?? "" });
    } else {
      beacons.push({ url, body: String(data) });
    }
    return true;
  });
  navigator.sendBeacon = spy as unknown as typeof navigator.sendBeacon;
  return {
    beacons,
    restore: () => {
      navigator.sendBeacon = orig;
    },
  };
}

describe("attachHeuristicsSink", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;
  let originalBeacon: typeof navigator.sendBeacon;

  beforeEach(() => {
    resetActivityRegistry();
    originalFetch = globalThis.fetch;
    originalBeacon = navigator.sendBeacon;
    // Force the fetch fallback by removing sendBeacon — easier to introspect the
    // JSON body than decoding a Blob in jsdom.
    // @ts-expect-error remove for the test
    navigator.sendBeacon = undefined;
    fetchSpy = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    navigator.sendBeacon = originalBeacon;
    resetActivityRegistry();
    vi.useRealTimers();
  });

  function lastBatch(): CollectBatch {
    expect(fetchSpy).toHaveBeenCalled();
    const call = fetchSpy.mock.calls.at(-1)!;
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe("/heuristics/collect");
    return JSON.parse(init.body as string) as CollectBatch;
  }

  it("maps an agent activity to a click HeuristicsEvent and POSTs a valid batch", async () => {
    const stop = attachHeuristicsSink({
      endpoint: "/heuristics",
      siteKey: "K",
      batchMs: 10,
    });

    emitActivity({
      agentId: "a1",
      agentName: "Aria",
      target: { kind: "whiteboard", elementId: "sticky-9", label: "the note" },
      action: "whiteboard_add_sticky",
      timestamp: 1700000000000,
      meta: { x: 12, y: 34 },
    });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    const batch = lastBatch();
    expect(batch.siteKey).toBe("K");
    expect(typeof batch.sessionId).toBe("string");
    expect(batch.sessionId.startsWith("agent-")).toBe(true);
    expect(batch.events).toHaveLength(1);

    const ev = batch.events[0];
    expect(ev.actor).toBe("agent");
    expect(ev.kind).toBe("click");
    expect(ev.path).toBe(location.pathname);
    expect(ev.ts).toBe(1700000000000);
    expect(ev.targetId).toBe("sticky-9");
    expect(ev.label).toBe("the note");
    expect(ev.x).toBe(12);
    expect(ev.y).toBe(34);
    expect(ev.meta?.action).toBe("whiteboard_add_sticky");
    expect(ev.meta?.agentId).toBe("a1");
    expect(ev.meta?.source).toBe("agent");
    expect(ev.meta?.kind).toBe("whiteboard");

    stop();
  });

  it("maps an activity with finite meta.dwellMs to a dwell event", async () => {
    const stop = attachHeuristicsSink({
      endpoint: "/heuristics",
      siteKey: "K",
      batchMs: 10,
    });

    emitActivity({
      agentId: "a2",
      target: { kind: "form", elementId: "email", label: "Email" },
      action: "form_focus",
      timestamp: 1700000001000,
      meta: { dwellMs: 750 },
    });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    const ev = lastBatch().events[0];
    expect(ev.kind).toBe("dwell");
    expect(ev.actor).toBe("agent");
    expect(ev.dwellMs).toBe(750);
    expect(ev.targetId).toBe("email");
    expect(ev.label).toBe("Email");
    expect(ev.x).toBeUndefined();

    stop();
  });

  it("respects a source filter and ignores non-matching sources", async () => {
    const stop = attachHeuristicsSink({
      endpoint: "/heuristics",
      siteKey: "K",
      batchMs: 10,
      source: "flow",
    });

    emitActivity({
      agentId: "agent-x",
      target: { kind: "whiteboard" },
      action: "whiteboard_add_sticky",
      timestamp: 1,
      source: "agent",
    });
    emitActivity({
      agentId: "flow-1",
      target: { kind: "flow" },
      action: "flow_run_node",
      timestamp: 2,
      source: "flow",
    });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    const batch = lastBatch();
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0].meta?.source).toBe("flow");

    stop();
  });

  it("unsubscribe flushes once then stops further POSTs", async () => {
    const stop = attachHeuristicsSink({
      endpoint: "/heuristics",
      siteKey: "K",
      batchMs: 100000, // long timer so the only flush is the unsubscribe one
    });

    emitActivity({
      agentId: "a3",
      target: { kind: "code", elementId: "L1" },
      action: "code_edit",
      timestamp: 5,
    });

    stop(); // final flush

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const callsAfterStop = fetchSpy.mock.calls.length;

    // Emit after unsubscribe — must NOT be recorded or flushed.
    emitActivity({
      agentId: "a4",
      target: { kind: "code", elementId: "L2" },
      action: "code_edit",
      timestamp: 6,
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy.mock.calls.length).toBe(callsAfterStop);
  });

  it("uses sendBeacon when available", async () => {
    const { beacons, restore } = collectBeacons();
    const stop = attachHeuristicsSink({
      endpoint: "/heuristics",
      siteKey: "K",
      batchMs: 10,
    });
    emitActivity({
      agentId: "a5",
      target: { kind: "sheet", elementId: "A1" },
      action: "sheet_paint",
      timestamp: 9,
    });
    await vi.waitFor(() => expect(beacons.length).toBeGreaterThan(0));
    expect(beacons[0].url).toBe("/heuristics/collect");
    stop();
    restore();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
