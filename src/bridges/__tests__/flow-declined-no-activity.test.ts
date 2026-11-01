import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerFlowBridge, type FlowBridgeAdapter } from "../flow";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import { onActivity, resetActivityRegistry } from "../../presence";
import type { JsonObject } from "../../mcp/types";

/**
 * 0.55.1: a human DECLINING a pendingMode confirm applies nothing, so it must
 * emit no AgentActivity. The result stays a normal, non-error result carrying
 * the decline text, so the agent reads the decline as an outcome.
 *
 * 0.55.0 emitted one activity per decline: wrapToolWithActivity skips only
 * error results and null targets, and a decline is neither.
 *
 * Every confirm-gated flow tool is covered: flow_run, and flow_delete_node on
 * both its commit path and its legacy setNodes/setEdges path.
 */

function setup(adapter: Partial<FlowBridgeAdapter> = {}) {
  const g = {
    nodes: [{ id: "a", type: "log", position: { x: 0, y: 0 }, data: { label: "A" } }] as any[],
    edges: [{ id: "e1", source: "a", target: "a2" }] as any[],
  };
  const host = new ToolRegistry();
  const full: FlowBridgeAdapter = {
    getNodes: () => g.nodes,
    setNodes: vi.fn((u: any) => { g.nodes = u(g.nodes); }),
    getEdges: () => g.edges,
    setEdges: vi.fn((u: any) => { g.edges = u(g.edges); }),
    ...adapter,
  };
  registerFlowBridge(host, {
    adapter: full,
    agent: { id: "maipa-agent", name: "Maipa" },
    validateConnections: false,
    pendingMode: true,
  });
  const activity: string[] = [];
  onActivity((e) => { activity.push(e.action); });
  const call = async (name: string, args: JsonObject = {}) => {
    const r = await host.callTool(name, args);
    return {
      isError: r.isError === true,
      text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "",
      structured: r.structuredContent,
    };
  };
  return { g, adapter: full, call, activity };
}

beforeEach(() => {
  resetAllUndoStacks();
  resetActivityRegistry();
});

describe("flow bridge: a declined confirm emits no activity", () => {
  it("flow_run declined: no activity, nothing run, non-error decline text", async () => {
    const run = vi.fn();
    const ctx = setup({ confirm: async () => false, run });
    const r = await ctx.call("flow_run");
    expect(r.isError).toBe(false);
    expect(r.text).toBe("Run was declined by the human.");
    expect(r.structured).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(ctx.activity).toEqual([]);
  });

  it("flow_run approved: still exactly one activity", async () => {
    const run = vi.fn(async () => ({ ok: true as const }));
    const ctx = setup({ confirm: async () => true, run });
    const r = await ctx.call("flow_run");
    expect(r.isError).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(ctx.activity).toEqual(["flow_run"]);
  });

  it("flow_delete_node declined (commit path): no activity, nothing removed, no commit", async () => {
    const commit = vi.fn(async () => ({ ok: true as const }));
    const ctx = setup({ confirm: async () => false, commit });
    const r = await ctx.call("flow_delete_node", { id: "a" });
    expect(r.isError).toBe(false);
    expect(r.text).toBe("Delete of node a was declined by the human.");
    expect(commit).not.toHaveBeenCalled();
    expect(ctx.adapter.setNodes).not.toHaveBeenCalled();
    expect(ctx.adapter.setEdges).not.toHaveBeenCalled();
    expect(ctx.g.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(ctx.g.edges.map((e) => e.id)).toEqual(["e1"]);
    expect(ctx.activity).toEqual([]);
  });

  it("flow_delete_node approved (commit path): still exactly one activity", async () => {
    const commit = vi.fn(async () => ({ ok: true as const }));
    const ctx = setup({ confirm: async () => true, commit });
    const r = await ctx.call("flow_delete_node", { id: "a" });
    expect(r.isError).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(ctx.activity).toEqual(["flow_delete_node"]);
  });

  it("flow_delete_node declined (legacy setNodes path): no activity, nothing removed", async () => {
    const ctx = setup({ confirm: async () => false });
    const r = await ctx.call("flow_delete_node", { id: "a" });
    expect(r.isError).toBe(false);
    expect(r.text).toBe("Delete of node a was declined by the human.");
    expect(ctx.adapter.setNodes).not.toHaveBeenCalled();
    expect(ctx.adapter.setEdges).not.toHaveBeenCalled();
    expect(ctx.g.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(ctx.activity).toEqual([]);
  });

  it("flow_delete_node approved (legacy setNodes path): still exactly one activity", async () => {
    const ctx = setup({ confirm: async () => true });
    const r = await ctx.call("flow_delete_node", { id: "a" });
    expect(r.isError).toBe(false);
    expect(ctx.g.nodes).toEqual([]);
    expect(ctx.activity).toEqual(["flow_delete_node"]);
  });
});
