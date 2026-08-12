import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { attachSseRelay } from "../sse-relay";
import { emitActivity } from "../../presence/registry";

/**
 * A relay forwards only ITS OWN session's activity — issue #6, item 4.
 *
 * `attachSseRelay` subscribes to the in-process activity bus and forwards every
 * event it sees. That bus is global to the page, so two concurrent sessions —
 * the site-driving co-browse relay and the agent playground's — each forwarded
 * the other's traffic. Every agent saw every other agent's navigations and
 * clicks, and the presence overlay attributed them to whoever was nearest.
 *
 * ## Why this is the standalone fix, and not the whole of item 4
 *
 * The issue asks for one merged session with one tool surface. That needs a
 * decision about whether a mounted playground page contributes its bridges
 * permanently or only while mounted, and inventing that inside a bug fix is how
 * it ends up wrong and load-bearing.
 *
 * This fixes the LEAK, which is the part that is visibly wrong today, without
 * committing to that design. It is worth landing whether or not the rest
 * happens.
 *
 * ## Why a predicate rather than a `scope` field on the event
 *
 * Emitters do not know their session. A bridge calls `emitActivity` with no
 * notion of which server it belongs to, so a `scope` field would be inert until
 * something teaches every emitter to populate it — the larger design question.
 * A predicate at the relay needs nothing from emitters and works with what the
 * events already carry.
 */
type Frame = { method?: string; params?: unknown };

function fakeFetch() {
  // The relay POSTs frames and opens a stream; neither matters here, so this
  // keeps every request pending rather than pretending to be a broker.
  return vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
}

/** Capture what a relay actually put on the wire. */
function attach(options: Record<string, unknown> = {}) {
  const sent: Frame[] = [];
  // Only what `attachSseRelay` touches: it attaches the transport and hands
  // frames back through it.
  const server = { attach: vi.fn(() => () => {}), handle: vi.fn() } as never;

  const relay = attachSseRelay(server, {
    baseUrl: "/agent-relay",
    sessionId: "session-a",
    token: "tok",
    fetch: fakeFetch(),
    ...options,
  });

  // The transport's send is what reaches the agent.
  const t = relay as unknown as { send: (f: Frame) => void };
  const origSend = t.send.bind(t);
  t.send = (frame: Frame) => {
    sent.push(frame);
    try {
      origSend(frame);
    } catch {
      /* the fake transport has nowhere to go; recording is the point */
    }
  };

  return { relay, sent };
}

const activity = (agentId: string) => ({
  agentId,
  agentName: agentId,
  agentColor: "#a855f7",
  action: "page_navigate",
  timestamp: Date.now(),
  target: { kind: "navigation" as const, label: "/packages" },
});

/** Activity frames only — the relay sends protocol traffic too. */
const activityFrames = (sent: Frame[]) =>
  sent.filter((f) => f.method === "notifications/agent_activity");

let relays: Array<{ close?: () => void }> = [];

beforeEach(() => {
  relays = [];
});

afterEach(() => {
  for (const r of relays) r.close?.();
  vi.restoreAllMocks();
});

describe("without a filter", () => {
  it("forwards everything — the existing behaviour, unchanged", async () => {
    // A host that has one session must not have to opt in to keep working.
    const { relay, sent } = attach();
    relays.push(relay as never);
    await new Promise((r) => setTimeout(r, 10));

    emitActivity(activity("agent-a"));
    emitActivity(activity("agent-b"));
    await new Promise((r) => setTimeout(r, 10));

    expect(activityFrames(sent)).toHaveLength(2);
  });
});

describe("with a filter", () => {
  it("forwards only the events it accepts", async () => {
    const { relay, sent } = attach({
      activityFilter: (e: { agentId?: string }) => e.agentId === "agent-a",
    });
    relays.push(relay as never);
    await new Promise((r) => setTimeout(r, 10));

    emitActivity(activity("agent-a"));
    emitActivity(activity("agent-b"));
    await new Promise((r) => setTimeout(r, 10));

    const frames = activityFrames(sent);
    expect(frames).toHaveLength(1);
    expect((frames[0]!.params as { agentId: string }).agentId).toBe("agent-a");
  });

  it("keeps two concurrent sessions from seeing each other", async () => {
    // The reported symptom, stated directly.
    const a = attach({ activityFilter: (e: { agentId?: string }) => e.agentId === "agent-a" });
    const b = attach({
      sessionId: "session-b",
      activityFilter: (e: { agentId?: string }) => e.agentId === "agent-b",
    });
    relays.push(a.relay as never, b.relay as never);
    await new Promise((r) => setTimeout(r, 10));

    emitActivity(activity("agent-a"));
    emitActivity(activity("agent-b"));
    await new Promise((r) => setTimeout(r, 10));

    expect(activityFrames(a.sent).map((f) => (f.params as { agentId: string }).agentId)).toEqual(["agent-a"]);
    expect(activityFrames(b.sent).map((f) => (f.params as { agentId: string }).agentId)).toEqual(["agent-b"]);
  });

  it("does not throw the subscription away when the predicate throws", async () => {
    // A host predicate is host code. One bad event must not silently kill
    // forwarding for the rest of the session, which would look exactly like the
    // agent having gone quiet.
    let calls = 0;
    const { relay, sent } = attach({
      activityFilter: (e: { agentId?: string }) => {
        calls++;
        if (e.agentId === "boom") throw new Error("host predicate blew up");
        return true;
      },
    });
    relays.push(relay as never);
    await new Promise((r) => setTimeout(r, 10));

    emitActivity(activity("boom"));
    emitActivity(activity("agent-a"));
    await new Promise((r) => setTimeout(r, 10));

    expect(calls).toBe(2);
    // The throwing event is dropped; the next one still arrives.
    expect(activityFrames(sent).map((f) => (f.params as { agentId: string }).agentId)).toEqual(["agent-a"]);
  });
});

describe("the relay's own connect/disconnect events", () => {
  it("carries the configured agent id instead of a hardcoded one", async () => {
    // These were emitted with a literal `agentId: "agent"`, so two sessions'
    // connect events were indistinguishable — and unfilterable, since there was
    // nothing to tell them apart by.
    const { relay, sent } = attach({
      agent: { id: "agent-a", name: "Site agent", color: "#10b981" },
      activityFilter: (e: { agentId?: string }) => e.agentId === "agent-a",
    });
    relays.push(relay as never);
    await new Promise((r) => setTimeout(r, 10));

    // Simulate the broker announcing a peer. `handleInbound` takes the raw
    // frame, and is called WITHOUT `?.` on purpose: an optional call would
    // silently no-op if the method were ever renamed, and this test would pass
    // over nothing.
    const inbound = (relay as unknown as { handleInbound: (raw: string) => Promise<void> }).handleInbound;
    expect(typeof inbound).toBe("function");
    await inbound.call(relay, JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/peer_joined",
      params: { subscriberId: "sub-1" },
    }));
    await new Promise((r) => setTimeout(r, 10));

    const connected = activityFrames(sent)
      .map((f) => f.params as { agentId: string; action: string })
      .find((p) => p.action === "agent_connected");

    expect(connected?.agentId).toBe("agent-a");
  });
});
