import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import {
  registerFlowBridge,
  type FlowBridgeAdapter,
  type FlowBridgeOptions,
  type FlowGraphOp,
  type FlowAdapterResult,
} from "../flow";
import { resetAllUndoStacks, readHistory } from "../../undo/undo-stack";
import { onActivity, resetActivityRegistry } from "../../presence";
import type { JsonObject } from "../../mcp/types";
// The bridge dynamic-imports this same module; a kind registered here is visible to it.
import { registerNodeKind } from "@particle-academy/fancy-flow";

/**
 * A flow host whose graph writes are authoritative (persisted, gated, or
 * refusable) wires `adapter.commit`. The bridge then hands it ONE whole
 * operation per mutating tool and waits: success, and the AgentActivity event
 * that rides on it, are reported only after the host accepts. A refusal is that
 * tool call's error. Same contract as the form bridge (0.52.0).
 */

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

type Node = { id: string; type?: string; position: { x: number; y: number }; data: any };
type Edge = { id: string; source: string; target: string; [k: string]: unknown };

const node = (id: string): Node => ({
  id,
  type: "test_plain",
  position: { x: 0, y: 0 },
  data: { kind: "test_plain", label: id, config: {} },
});

/** Apply a committed op to plain arrays — what a real host does after persisting. */
function applyOp(g: { nodes: Node[]; edges: Edge[] }, op: FlowGraphOp): void {
  switch (op.op) {
    case "add_node": g.nodes = [...g.nodes, op.node as Node]; break;
    case "update_node": g.nodes = g.nodes.map((n) => (n.id === op.id ? (op.node as Node) : n)); break;
    case "remove_node":
      g.nodes = g.nodes.filter((n) => n.id !== op.id);
      g.edges = g.edges.filter((e) => !op.edgeIds.includes(e.id));
      break;
    case "connect": g.edges = [...g.edges, op.edge as Edge]; break;
    case "disconnect": g.edges = g.edges.filter((e) => e.id !== op.id); break;
    case "set_node_status":
      g.nodes = g.nodes.map((n) => (n.id === op.id ? { ...n, data: { ...n.data, status: op.status, statusText: op.text } } : n));
      break;
  }
}

type CommitMode = "sync" | "defer" | "refuse" | "reject" | "throw";

/**
 * A host with a graph `g`, a `commit` that routes through a gate, and spies on
 * the legacy setters so a test can prove they are never touched when commit is
 * wired.
 */
function setup(opts: { commit?: boolean; options?: Partial<FlowBridgeOptions>; adapter?: Partial<FlowBridgeAdapter> } = {}) {
  const g = {
    nodes: [node("a"), node("b"), node("c")],
    edges: [
      { id: "e1", source: "a", target: "b" },
      { id: "e2", source: "b", target: "c" },
      { id: "e3", source: "a", target: "c" },
    ] as Edge[],
  };
  let revision = 7;
  const ops: FlowGraphOp[] = [];
  const gate = { mode: "sync" as CommitMode, held: [] as Array<() => void> };
  const release = () => { const h = gate.held; gate.held = []; h.forEach((go) => go()); };

  const setNodes = vi.fn((next: any) => { g.nodes = typeof next === "function" ? next(g.nodes) : next; });
  const setEdges = vi.fn((next: any) => { g.edges = typeof next === "function" ? next(g.edges) : next; });

  const commit = vi.fn((op: FlowGraphOp): void | FlowAdapterResult | Promise<void | FlowAdapterResult> => {
    ops.push(op);
    switch (gate.mode) {
      case "sync": applyOp(g, op); revision++; return { ok: true };
      case "refuse": return Promise.resolve({ ok: false, error: "Graph changed since you read it; re-read and retry.", code: "stale" });
      case "reject": {
        const e = new Error("Persist failed: quota exceeded\n    at save (C:/srv/internal/persist.ts:12:3)");
        return Promise.reject(e);
      }
      case "throw": throw new Error("host refused synchronously");
      case "defer":
        return new Promise<FlowAdapterResult>((resolve) => {
          gate.held.push(() => { applyOp(g, op); revision++; resolve({ ok: true }); });
        });
    }
  });

  const host = new ToolRegistry();
  const adapter: FlowBridgeAdapter = {
    getNodes: () => g.nodes as any,
    setNodes: setNodes as any,
    getEdges: () => g.edges as any,
    setEdges: setEdges as any,
    getRevision: () => revision,
    ...(opts.commit === false ? {} : { commit }),
    ...opts.adapter,
  };
  const bridge = registerFlowBridge(host, {
    adapter,
    agent: { id: "maipa-agent", name: "Maipa" },
    validateConnections: false,
    ...opts.options,
  });

  const activity: Array<{ action: string; meta?: Record<string, unknown> }> = [];
  onActivity((e) => { activity.push({ action: e.action, meta: e.meta }); });

  const call = async (name: string, args: JsonObject = {}) => {
    const r = await host.callTool(name, args);
    return {
      isError: r.isError === true,
      text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "",
      structured: r.structuredContent as Record<string, any> | undefined,
    };
  };
  return { host, g, ops, gate, release, commit, setNodes, setEdges, call, activity, bridge, adapter, bumpRevision: () => revision++ };
}

beforeAll(() => {
  registerNodeKind({
    name: "test_plain",
    category: "data",
    label: "Plain",
    configSchema: [{ key: "url", label: "URL", type: "text" }],
  } as any);
  registerNodeKind({
    name: "test_required",
    category: "data",
    label: "Required",
    configSchema: [{ key: "url", label: "URL", type: "text", required: true }],
  } as any);
});

beforeEach(() => {
  resetAllUndoStacks();
  resetActivityRegistry();
});

/** Every mutating tool, its args, and what the graph looks like once it commits. */
const MUTATIONS: Array<{
  tool: string;
  op: FlowGraphOp["op"];
  args: JsonObject;
  committed: (g: { nodes: Node[]; edges: Edge[] }) => boolean;
}> = [
  { tool: "flow_add_node", op: "add_node", args: { kind: "test_plain", label: "New", x: 10, y: 20 }, committed: (g) => g.nodes.some((n) => n.data.label === "New") },
  { tool: "flow_update_node", op: "update_node", args: { id: "a", label: "Renamed", x: 50 }, committed: (g) => g.nodes.find((n) => n.id === "a")!.data.label === "Renamed" },
  { tool: "flow_delete_node", op: "remove_node", args: { id: "b" }, committed: (g) => !g.nodes.some((n) => n.id === "b") },
  { tool: "flow_connect", op: "connect", args: { source: "c", target: "a" }, committed: (g) => g.edges.some((e) => e.source === "c" && e.target === "a") },
  { tool: "flow_disconnect", op: "disconnect", args: { id: "e2" }, committed: (g) => !g.edges.some((e) => e.id === "e2") },
  { tool: "flow_set_node_status", op: "set_node_status", args: { id: "a", status: "running", text: "go" }, committed: (g) => g.nodes.find((n) => n.id === "a")!.data.status === "running" },
];

describe("flow bridge — Maipa's shape: flow_add_node with a gated async commit", () => {
  it("does not report success while the commit is unresolved and the graph is unchanged", async () => {
    const ctx = setup();
    ctx.gate.mode = "defer";
    const before = ctx.g.nodes.length;

    let settled = false;
    const pending = ctx.call("flow_add_node", { kind: "test_plain", label: "Gated", x: 1, y: 2 })
      .then((r) => { settled = true; return r; });
    await flush();
    await flush();

    // The bug: 0.53.0 returned success here, with the graph still unchanged.
    expect(settled).toBe(false);
    expect(ctx.g.nodes).toHaveLength(before);
    expect(ctx.activity).toHaveLength(0);

    ctx.release();
    const r = await pending;
    expect(r.isError).toBe(false);
    expect(ctx.g.nodes).toHaveLength(before + 1);
    // The success names the node the host now holds.
    expect(ctx.g.nodes.some((n) => n.id === r.structured!.id)).toBe(true);
    expect(ctx.activity.map((a) => a.action)).toEqual(["flow_add_node"]);
  });
});

describe("flow bridge — every mutating tool waits for commit", () => {
  for (const m of MUTATIONS) {
    it(`${m.tool}: no success and no activity before the commit resolves; both after`, async () => {
      const ctx = setup();
      ctx.gate.mode = "defer";
      let settled = false;
      const pending = ctx.call(m.tool, m.args).then((r) => { settled = true; return r; });
      await flush();
      await flush();

      expect(settled).toBe(false);
      expect(ctx.activity).toHaveLength(0);
      expect(m.committed(ctx.g)).toBe(false);
      expect(ctx.commit).toHaveBeenCalledTimes(1);
      expect(ctx.ops[0].op).toBe(m.op);

      ctx.release();
      const r = await pending;
      expect(r.isError).toBe(false);
      expect(m.committed(ctx.g)).toBe(true);
      expect(ctx.activity.map((a) => a.action)).toEqual([m.tool]);
      // With commit wired, the legacy setters are never used.
      expect(ctx.setNodes).not.toHaveBeenCalled();
      expect(ctx.setEdges).not.toHaveBeenCalled();
    });
  }
});

describe("flow bridge — refusal is the tool's error", () => {
  for (const m of MUTATIONS) {
    it(`${m.tool}: { ok: false } is an error with the host's message and code; no activity, no undo, graph unchanged`, async () => {
      const ctx = setup();
      ctx.gate.mode = "refuse";
      const snapshot = JSON.stringify(ctx.g);
      const r = await ctx.call(m.tool, m.args);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Graph changed since you read it");
      expect(r.structured).toMatchObject({ ok: false, code: "stale", op: m.op });
      expect(ctx.activity).toHaveLength(0);
      expect(readHistory("maipa-agent")).toHaveLength(0);
      expect(JSON.stringify(ctx.g)).toBe(snapshot);
      expect(ctx.setNodes).not.toHaveBeenCalled();
      expect(ctx.setEdges).not.toHaveBeenCalled();
    });
  }

  it("a rejected commit is handled the same way, and never leaks a stack", async () => {
    const ctx = setup();
    ctx.gate.mode = "reject";
    const r = await ctx.call("flow_add_node", { kind: "test_plain", label: "X", x: 0, y: 0 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Persist failed: quota exceeded");
    expect(r.text).not.toContain("persist.ts");
    expect(r.text).not.toMatch(/\bat save\b/);
    expect(ctx.activity).toHaveLength(0);
    expect(readHistory("maipa-agent")).toHaveLength(0);
  });

  it("a commit that throws synchronously is handled the same way", async () => {
    const ctx = setup();
    ctx.gate.mode = "throw";
    const r = await ctx.call("flow_connect", { source: "c", target: "a" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("host refused synchronously");
    expect(ctx.activity).toHaveLength(0);
  });

  it("a refusal without a code carries no code", async () => {
    const ctx = setup({ adapter: { commit: async () => ({ ok: false, error: "Read-only graph." }) } });
    const r = await ctx.call("flow_disconnect", { id: "e1" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Read-only graph.");
    expect(r.structured?.code).toBeUndefined();
  });

  it("a non-Error rejection gets a fallback, never [object Object]", async () => {
    const ctx = setup({ adapter: { commit: () => Promise.reject({ status: 500 }) } });
    const r = await ctx.call("flow_delete_node", { id: "a" });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("[object Object]");
    expect(r.text.length).toBeGreaterThan(0);
  });

  it("void and { ok: true } both count as accepted", async () => {
    const ctx = setup({ adapter: { commit: async () => undefined } });
    expect((await ctx.call("flow_disconnect", { id: "e1" })).isError).toBe(false);
    const ctx2 = setup({ adapter: { commit: () => ({ ok: true }) } });
    expect((await ctx2.call("flow_disconnect", { id: "e1" })).isError).toBe(false);
  });
});

describe("flow bridge — the op is whole, and says what it was computed against", () => {
  it("remove_node is ONE op carrying the node and every edge it removes", async () => {
    const ctx = setup();
    const r = await ctx.call("flow_delete_node", { id: "b" });
    expect(r.isError).toBe(false);
    expect(ctx.commit).toHaveBeenCalledTimes(1);
    const op = ctx.ops[0];
    expect(op.op).toBe("remove_node");
    if (op.op !== "remove_node") throw new Error("unreachable");
    expect(op.id).toBe("b");
    expect(op.node.id).toBe("b");
    expect([...op.edgeIds].sort()).toEqual(["e1", "e2"]);
    expect(ctx.setNodes).not.toHaveBeenCalled();
    expect(ctx.setEdges).not.toHaveBeenCalled();
    // Committed atomically: node and its edges went together, e3 survives.
    expect(ctx.g.edges.map((e) => e.id)).toEqual(["e3"]);
  });

  it("each op carries the revision read at call time, the acting agent and the tool", async () => {
    const ctx = setup();
    ctx.gate.mode = "defer";
    const pending = ctx.call("flow_update_node", { id: "a", label: "R" });
    await flush();
    // The graph moves on while the commit is in flight; the op keeps its basis.
    ctx.bumpRevision();
    ctx.release();
    await pending;
    expect(ctx.ops[0]).toMatchObject({
      op: "update_node",
      revision: 7,
      agent: { id: "maipa-agent", name: "Maipa" },
      tool: "flow_update_node",
    });
  });

  it("update_node carries the previous node and the next one", async () => {
    const ctx = setup();
    await ctx.call("flow_update_node", { id: "a", x: 99 });
    const op = ctx.ops[0];
    if (op.op !== "update_node") throw new Error("expected update_node");
    expect(op.previous.position.x).toBe(0);
    expect(op.node.position.x).toBe(99);
  });

  it("connect and disconnect carry the edge", async () => {
    const ctx = setup();
    await ctx.call("flow_connect", { source: "c", target: "a", label: "loop" });
    await ctx.call("flow_disconnect", { id: "e1" });
    expect(ctx.ops[0]).toMatchObject({ op: "connect", edge: { source: "c", target: "a", label: "loop" } });
    expect(ctx.ops[1]).toMatchObject({ op: "disconnect", id: "e1", edge: { id: "e1", source: "a", target: "b" } });
  });

  it("revision is undefined when the adapter has no getRevision", async () => {
    const ctx = setup({ adapter: { getRevision: undefined } });
    await ctx.call("flow_disconnect", { id: "e1" });
    expect(ctx.ops[0].revision).toBeUndefined();
  });

  it("flow_set_node_status still uses a host setNodeStatus when one is wired (not a graph op)", async () => {
    const setNodeStatus = vi.fn();
    const ctx = setup({ adapter: { setNodeStatus } });
    const r = await ctx.call("flow_set_node_status", { id: "a", status: "done" });
    expect(r.isError).toBe(false);
    expect(setNodeStatus).toHaveBeenCalledWith("a", "done", undefined);
    expect(ctx.commit).not.toHaveBeenCalled();
  });
});

describe("flow bridge — gates run before commit", () => {
  it("a declined pendingMode confirm never reaches commit", async () => {
    const ctx = setup({ options: { pendingMode: true }, adapter: { confirm: async () => false } });
    const r = await ctx.call("flow_delete_node", { id: "a" });
    expect(r.text).toMatch(/declined/);
    expect(ctx.commit).not.toHaveBeenCalled();
    expect(ctx.g.nodes.some((n) => n.id === "a")).toBe(true);
  });

  it("an approved confirm commits the edges present AFTER the human decided", async () => {
    const confirmGate = deferred<boolean>();
    const ctx = setup({ options: { pendingMode: true }, adapter: { confirm: () => confirmGate.promise } });
    const pending = ctx.call("flow_delete_node", { id: "a" });
    await flush();
    expect(ctx.commit).not.toHaveBeenCalled();
    // An edge to "a" appears while the human is deciding.
    ctx.g.edges = [...ctx.g.edges, { id: "e9", source: "c", target: "a" }];
    confirmGate.resolve(true);
    await pending;
    const op = ctx.ops[0];
    if (op.op !== "remove_node") throw new Error("expected remove_node");
    expect([...op.edgeIds].sort()).toEqual(["e1", "e3", "e9"]);
  });

  it("an invalid config is refused before commit", async () => {
    const ctx = setup();
    const r = await ctx.call("flow_add_node", { kind: "test_required", label: "X", x: 0, y: 0 });
    expect(r.isError).toBe(true);
    expect(ctx.commit).not.toHaveBeenCalled();
  });

  it("an unknown node or edge is refused before commit", async () => {
    const ctx = setup();
    expect((await ctx.call("flow_delete_node", { id: "zz" })).isError).toBe(true);
    expect((await ctx.call("flow_disconnect", { id: "zz" })).isError).toBe(true);
    expect((await ctx.call("flow_update_node", { id: "zz", label: "x" })).isError).toBe(true);
    expect((await ctx.call("flow_set_node_status", { id: "zz", status: "done" })).isError).toBe(true);
    expect((await ctx.call("flow_connect", { source: "zz", target: "a" })).isError).toBe(true);
    expect(ctx.commit).not.toHaveBeenCalled();
  });
});

describe("flow bridge — fencing late results", () => {
  it("dispose while a commit is pending: the call settles as unknown, and a late accept records nothing", async () => {
    const ctx = setup();
    ctx.gate.mode = "defer";
    const pending = ctx.call("flow_add_node", { kind: "test_plain", label: "Late", x: 0, y: 0 });
    await flush();
    ctx.bridge.dispose();

    const r = await pending;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/closed/i);
    expect(r.text).toMatch(/unknown/i);

    ctx.release();
    await flush();
    expect(ctx.activity).toHaveLength(0);
    expect(readHistory("maipa-agent")).toHaveLength(0);
  });

  it("a late rejection after dispose is swallowed, not an unhandled rejection", async () => {
    const gate = deferred<FlowAdapterResult>();
    const ctx = setup({ adapter: { commit: () => gate.promise } });
    const pending = ctx.call("flow_connect", { source: "c", target: "a" });
    await flush();
    ctx.bridge.dispose();
    expect((await pending).isError).toBe(true);
    gate.reject(new Error("too late"));
    await flush();
    // vitest fails the run on an unhandled rejection; reaching here is the assertion.
  });

  it("a bridge replaced on the same host: its pending commit settles as unknown and records nothing", async () => {
    const ctx = setup();
    ctx.gate.mode = "defer";
    const pending = ctx.call("flow_delete_node", { id: "b" });
    await flush();

    // A remount registers a fresh flow bridge on the same host (same owner).
    registerFlowBridge(ctx.host, { adapter: { ...ctx.adapter, commit: async () => ({ ok: true }) } });

    const r = await pending;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown/i);
    ctx.release();
    await flush();
    expect(ctx.activity).toHaveLength(0);
  });

  it("a confirm pending at dispose never commits", async () => {
    const confirmGate = deferred<boolean>();
    const ctx = setup({ options: { pendingMode: true }, adapter: { confirm: () => confirmGate.promise } });
    const pending = ctx.call("flow_delete_node", { id: "a" });
    await flush();
    ctx.bridge.dispose();
    const r = await pending;
    expect(r.isError).toBe(true);
    confirmGate.resolve(true);
    await flush();
    expect(ctx.commit).not.toHaveBeenCalled();
    expect(ctx.activity).toHaveLength(0);
  });
});

describe("flow bridge — without commit, behaviour is exactly as before", () => {
  it("flow_add_node calls setNodes synchronously and emits one activity", async () => {
    const ctx = setup({ commit: false });
    const r = await ctx.call("flow_add_node", { kind: "test_plain", label: "Legacy", x: 0, y: 0 });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^Added test_plain n_/);
    expect(ctx.setNodes).toHaveBeenCalledTimes(1);
    expect(ctx.g.nodes.some((n) => n.data.label === "Legacy")).toBe(true);
    expect(ctx.activity.map((a) => a.action)).toEqual(["flow_add_node"]);
  });

  it("flow_delete_node still calls setNodes then setEdges", async () => {
    const ctx = setup({ commit: false });
    const r = await ctx.call("flow_delete_node", { id: "b" });
    expect(r.text).toBe("Deleted node b");
    expect(ctx.setNodes).toHaveBeenCalledTimes(1);
    expect(ctx.setEdges).toHaveBeenCalledTimes(1);
    expect(ctx.g.edges.map((e) => e.id)).toEqual(["e3"]);
  });

  it("an async legacy setNodes is still not awaited (fire-and-forget, as documented)", async () => {
    const gate = deferred<void>();
    const ctx = setup({ commit: false, adapter: { setNodes: (() => gate.promise) as any } });
    const r = await ctx.call("flow_update_node", { id: "a", label: "x" });
    expect(r.isError).toBe(false);
    gate.resolve();
  });

  it("connect, disconnect, update and status keep their texts", async () => {
    const ctx = setup({ commit: false });
    expect((await ctx.call("flow_connect", { source: "c", target: "a" })).text).toBe("Connected c → a");
    expect((await ctx.call("flow_disconnect", { id: "e1" })).text).toBe("Disconnected e1");
    expect((await ctx.call("flow_update_node", { id: "a", label: "Z" })).text).toBe("Updated node a");
    expect((await ctx.call("flow_set_node_status", { id: "a", status: "done", text: "ok" })).text).toBe("a → done (ok)");
    expect(ctx.activity).toHaveLength(4);
  });
});
