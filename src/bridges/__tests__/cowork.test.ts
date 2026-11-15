// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "../../mcp/tool-host";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import { registerCoworkBridge, COWORK_BRIDGE_TOOLS } from "../cowork";
import { createCoworkSession, type CoworkSession, type CoworkSnapshot } from "../../cowork/session";
import { createMemoryTransport, type MemoryHub } from "../../cowork/transport";
import type { Decision } from "../../cowork/types";

const ALLOW: Decision = { allow: true };

/** A session double: records calls, answers with whatever decision the test sets. */
function fakeSession(overrides: Partial<CoworkSnapshot> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  let answer: Decision = ALLOW;
  const snapshot: CoworkSnapshot = {
    sessionId: "s1",
    self: "agent",
    routing: "server",
    consent: "notify",
    peers: [
      { ref: "agent", label: "Agent", self: true, view: { route: "/help", revision: 0 }, follows: null, drives: false, idle: false, cursor: null, activeField: null, online: true },
      { ref: "user", label: "Ada", self: false, view: { route: "/account", revision: 3 }, follows: null, drives: false, idle: true, cursor: { anchor: "email", fx: 0.5, fy: 0.5 }, activeField: "card.number", online: true },
    ],
    control: { user: { mode: "baton", holder: "user", requests: [] } },
    blocked: null,
    configured: true,
    ...overrides,
  };
  const session = {
    getSnapshot: () => snapshot,
    follow: async (ref: string) => { calls.push(["follow", ref]); return answer; },
    unfollow: async () => { calls.push(["unfollow"]); return answer; },
    requestControl: async (view: string) => { calls.push(["requestControl", view]); return answer; },
    release: async (view: string) => { calls.push(["release", view]); return answer; },
  } as unknown as CoworkSession;
  return { session, calls, refuseWith: (d: Decision) => { answer = d; } };
}

const json = (result: unknown) => (result as { structuredContent?: unknown }).structuredContent as Record<string, unknown>;
const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]!.text;
const isError = (result: unknown) => (result as { isError?: boolean }).isError === true;

describe("registerCoworkBridge", () => {
  beforeEach(() => resetAllUndoStacks());

  it("registers exactly the four cowork_* tools of the plan, and nothing that writes into a page", () => {
    const host = new ToolRegistry();
    registerCoworkBridge(host, { session: fakeSession().session });
    const cowork = host.listTools().map((t) => t.name).filter((n) => n.startsWith("cowork")).sort();
    expect(cowork).toEqual([...COWORK_BRIDGE_TOOLS].sort());
    expect(COWORK_BRIDGE_TOOLS).toEqual(["cowork_peers", "cowork_follow", "cowork_request_control", "cowork_release_control"]);
  });

  it("cowork_peers describes peers and control without cursors, positions or field values", async () => {
    const host = new ToolRegistry();
    registerCoworkBridge(host, { session: fakeSession().session });
    const result = await host.callTool("cowork_peers", {});
    const out = json(result);
    expect(out).toEqual({
      sessionId: "s1",
      self: "agent",
      configured: true,
      consent: "notify",
      blocked: null,
      peers: [
        { ref: "agent", label: "Agent", self: true, route: "/help", follows: null, drives: false, idle: false },
        { ref: "user", label: "Ada", self: false, route: "/account", follows: null, drives: false, idle: true, editing: true },
      ],
      control: { user: { mode: "baton", holder: "user", requests: [] } },
    });
    // Neither the cursor nor even the NAME of a masked field is an agent's business.
    expect(JSON.stringify(result)).not.toContain("card.number");
    expect(JSON.stringify(result)).not.toContain("fx");
  });

  it("cowork_follow follows a peer, and with no ref stops following", async () => {
    const fake = fakeSession();
    const host = new ToolRegistry();
    registerCoworkBridge(host, { session: fake.session });
    expect(isError(await host.callTool("cowork_follow", { ref: "user" }))).toBe(false);
    expect(isError(await host.callTool("cowork_follow", {}))).toBe(false);
    expect(fake.calls).toEqual([["follow", "user"], ["unfollow"]]);
  });

  it("cowork_request_control and cowork_release_control name the view", async () => {
    const fake = fakeSession();
    const host = new ToolRegistry();
    registerCoworkBridge(host, { session: fake.session });
    await host.callTool("cowork_request_control", { view: "user" });
    await host.callTool("cowork_release_control", { view: "user" });
    expect(fake.calls).toEqual([["requestControl", "user"], ["release", "user"]]);
  });

  it("returns a refusal as an error carrying its named reason, so the agent sees the policy", async () => {
    const fake = fakeSession();
    fake.refuseWith({ allow: false, reason: "cowork.denied.authorize", status: 403 });
    const host = new ToolRegistry();
    registerCoworkBridge(host, { session: fake.session });
    const result = await host.callTool("cowork_request_control", { view: "user" });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("cowork.denied.authorize");
  });

  it("refuses malformed arguments before touching the session", async () => {
    const fake = fakeSession();
    const host = new ToolRegistry();
    registerCoworkBridge(host, { session: fake.session });
    expect(isError(await host.callTool("cowork_request_control", {}))).toBe(true);
    expect(isError(await host.callTool("cowork_follow", { ref: 7 }))).toBe(true);
    expect(isError(await host.callTool("cowork_release_control", { view: "" }))).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  it("disposes every tool it registered", () => {
    const host = new ToolRegistry();
    const bridge = registerCoworkBridge(host, { session: fakeSession().session });
    bridge.dispose?.();
    expect(host.listTools().map((t) => t.name).filter((n) => n.startsWith("cowork"))).toEqual([]);
  });
});

describe("an agent joins a real session under the same policy and control mode as a person", () => {
  let hub: MemoryHub;
  const sessions: CoworkSession[] = [];
  beforeEach(() => { vi.useFakeTimers(); hub = createMemoryTransport(); document.body.innerHTML = ""; });
  afterEach(() => { for (const s of sessions.splice(0)) s.destroy(); vi.useRealTimers(); });

  function join(ref: string, authorize: (ref: string, ability: string) => boolean) {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const session = createCoworkSession({
      sessionId: "s",
      self: { ref, label: ref },
      transport: hub.connect({ ref, label: ref }),
      config: { control: { mode: "baton" } },
      authorize,
      root,
      now: () => 1_000,
    });
    sessions.push(session);
    return session;
  }

  it("the agent's request queues on the person's view, and only the person's grant hands it over", async () => {
    const all = () => true;
    const user = join("user", all);
    const agent = join("agent", all);
    const host = new ToolRegistry();
    registerCoworkBridge(host, { session: agent });
    await vi.advanceTimersByTimeAsync(0);

    expect(isError(await host.callTool("cowork_request_control", { view: "user" }))).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(user.getSnapshot().control.user).toMatchObject({ holder: "user", requests: ["agent"] });

    await user.grant("agent");
    await vi.advanceTimersByTimeAsync(0);
    expect(json(await host.callTool("cowork_peers", {})).control).toMatchObject({ user: { holder: "agent" } });

    expect(isError(await host.callTool("cowork_release_control", { view: "user" }))).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(user.getSnapshot().control.user).toMatchObject({ holder: "user" });
  });

  it("an agent the host does not authorise is refused exactly as a person would be", async () => {
    const user = join("user", () => true);
    const agent = join("agent", (ref, ability) => !(ref === "agent" && ability === "drive"));
    const host = new ToolRegistry();
    registerCoworkBridge(host, { session: agent });
    await vi.advanceTimersByTimeAsync(0);
    const result = await host.callTool("cowork_request_control", { view: "user" });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("cowork.denied.authorize");
    expect(user.getSnapshot().control.user).toMatchObject({ requests: [] });
  });
});
