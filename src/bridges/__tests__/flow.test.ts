import { describe, it, expect, vi, beforeAll } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerFlowBridge, type FlowBridgeAdapter } from "../flow";
// The bridge dynamic-imports this same module, so a kind registered here is
// visible to it (shared registry singleton). Requires fancy-flow >= 0.18.0.
import { registerNodeKind } from "@particle-academy/fancy-flow";

const text = (r: any) => r.content?.[0]?.text ?? "";
const errored = (r: any) => r.isError === true;

type Node = { id: string; type?: string; position: { x: number; y: number }; data: any };

function makeAdapter(nodes: Node[] = [], overrides: Partial<FlowBridgeAdapter> = {}): FlowBridgeAdapter {
  let ns = [...nodes];
  let es: any[] = [];
  return {
    getNodes: () => ns as any,
    setNodes: (next: any) => {
      ns = typeof next === "function" ? next(ns) : next;
    },
    getEdges: () => es as any,
    setEdges: (next: any) => {
      es = typeof next === "function" ? next(es) : next;
    },
    ...overrides,
  };
}

const typed = (id: string, ports: { inputs?: any[]; outputs?: any[] }, config: any = {}): Node => ({
  id,
  type: "test_typed",
  position: { x: 0, y: 0 },
  data: { kind: "test_typed", label: id, config, ...ports },
});

beforeAll(() => {
  registerNodeKind({
    name: "test_typed",
    category: "data",
    label: "Typed",
    configSchema: [{ key: "url", label: "URL", type: "text", required: true }],
    inputs: [{ id: "in", type: "text" }],
    outputs: [{ id: "out", type: "text" }],
  } as any);
});

describe("flow bridge — connection validation (G1-A)", () => {
  const nodes = [
    typed("a", { outputs: [{ id: "out", type: "text" }] }, { url: "x" }),
    typed("b", { inputs: [{ id: "in", type: "number" }] }, { url: "y" }),
    typed("c", { inputs: [{ id: "in", type: "text" }] }, { url: "z" }),
  ];

  it("rejects a type-incompatible connection", async () => {
    const host = new ToolRegistry();
    registerFlowBridge(host, { adapter: makeAdapter(nodes) });
    const res = await host.callTool("flow_connect", { source: "a", target: "b", sourceHandle: "out", targetHandle: "in" });
    expect(errored(res)).toBe(true);
    expect(text(res)).toMatch(/invalid connection/i);
  });

  it("accepts a type-compatible connection", async () => {
    const host = new ToolRegistry();
    const adapter = makeAdapter(nodes);
    registerFlowBridge(host, { adapter });
    const res = await host.callTool("flow_connect", { source: "a", target: "c", sourceHandle: "out", targetHandle: "in" });
    expect(errored(res)).toBe(false);
    expect(adapter.getEdges()).toHaveLength(1);
  });

  it("blocks a self-connection", async () => {
    const host = new ToolRegistry();
    registerFlowBridge(host, { adapter: makeAdapter(nodes) });
    const res = await host.callTool("flow_connect", { source: "a", target: "a", sourceHandle: "out", targetHandle: "in" });
    expect(errored(res)).toBe(true);
    expect(text(res)).toMatch(/itself/i);
  });

  it("still rejects a connection to an unknown node (existence check)", async () => {
    const host = new ToolRegistry();
    registerFlowBridge(host, { adapter: makeAdapter(nodes) });
    const res = await host.callTool("flow_connect", { source: "a", target: "zzz" });
    expect(errored(res)).toBe(true);
  });

  it("does not validate when validateConnections is false", async () => {
    const host = new ToolRegistry();
    const adapter = makeAdapter(nodes);
    registerFlowBridge(host, { adapter, validateConnections: false });
    const res = await host.callTool("flow_connect", { source: "a", target: "b", sourceHandle: "out", targetHandle: "in" });
    expect(errored(res)).toBe(false); // incompatible types allowed through
    expect(adapter.getEdges()).toHaveLength(1);
  });
});

describe("flow bridge — config validation (G1-B)", () => {
  it("rejects a node whose required config is missing (default reject mode)", async () => {
    const host = new ToolRegistry();
    registerFlowBridge(host, { adapter: makeAdapter() });
    const res = await host.callTool("flow_add_node", { kind: "test_typed", label: "X", x: 0, y: 0 });
    expect(errored(res)).toBe(true);
    expect(text(res)).toMatch(/config invalid/i);
  });

  it("accepts a node with valid config", async () => {
    const host = new ToolRegistry();
    const adapter = makeAdapter();
    registerFlowBridge(host, { adapter });
    const res = await host.callTool("flow_add_node", { kind: "test_typed", label: "X", x: 0, y: 0, config: { url: "https://x" } });
    expect(errored(res)).toBe(false);
    expect(adapter.getNodes()).toHaveLength(1);
  });

  it("warn mode applies the node but reports issues", async () => {
    const host = new ToolRegistry();
    const adapter = makeAdapter();
    registerFlowBridge(host, { adapter, validateConfig: "warn" });
    const res = await host.callTool("flow_add_node", { kind: "test_typed", label: "X", x: 0, y: 0 });
    expect(errored(res)).toBe(false);
    expect(adapter.getNodes()).toHaveLength(1);
    expect(text(res)).toMatch(/config warnings/i);
  });

  it("off mode skips validation entirely", async () => {
    const host = new ToolRegistry();
    const adapter = makeAdapter();
    registerFlowBridge(host, { adapter, validateConfig: "off" });
    const res = await host.callTool("flow_add_node", { kind: "test_typed", label: "X", x: 0, y: 0 });
    expect(errored(res)).toBe(false);
    expect(adapter.getNodes()).toHaveLength(1);
  });

  it("update rejects an invalid merged config and leaves the graph untouched", async () => {
    const host = new ToolRegistry();
    const adapter = makeAdapter([typed("n1", { outputs: [{ id: "out", type: "text" }] }, { url: "ok" })]);
    registerFlowBridge(host, { adapter });
    const res = await host.callTool("flow_update_node", { id: "n1", config: { url: "" } });
    expect(errored(res)).toBe(true);
    expect((adapter.getNodes()[0] as any).data.config.url).toBe("ok"); // unchanged
  });
});

describe("flow bridge — node-kinds category filter (G1-C)", () => {
  it("filters kinds by category", async () => {
    const host = new ToolRegistry();
    registerFlowBridge(host, { adapter: makeAdapter() });
    const inData = await host.callTool("flow_list_node_kinds", { category: "data" });
    expect(text(inData)).toMatch(/test_typed/);
    const inTrigger = await host.callTool("flow_list_node_kinds", { category: "trigger" });
    expect(text(inTrigger)).not.toMatch(/test_typed/);
  });
});

describe("flow bridge — staging (G1-D)", () => {
  it("declined confirm blocks a delete and leaves the node in place", async () => {
    const confirm = vi.fn(async () => false);
    const adapter = makeAdapter([typed("n1", { outputs: [{ id: "out", type: "text" }] }, { url: "ok" })], { confirm });
    const host = new ToolRegistry();
    registerFlowBridge(host, { adapter, pendingMode: true });
    const res = await host.callTool("flow_delete_node", { id: "n1" });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ action: "delete_node", nodeId: "n1" }));
    expect(text(res)).toMatch(/declined/i);
    expect(adapter.getNodes()).toHaveLength(1); // not deleted
  });

  it("approved confirm lets the delete through", async () => {
    const confirm = vi.fn(async () => true);
    const adapter = makeAdapter([typed("n1", { outputs: [{ id: "out", type: "text" }] }, { url: "ok" })], { confirm });
    const host = new ToolRegistry();
    registerFlowBridge(host, { adapter, pendingMode: true });
    await host.callTool("flow_delete_node", { id: "n1" });
    expect(adapter.getNodes()).toHaveLength(0);
  });

  it("deletes immediately when pendingMode is off (default)", async () => {
    const confirm = vi.fn(async () => false);
    const adapter = makeAdapter([typed("n1", { outputs: [{ id: "out", type: "text" }] }, { url: "ok" })], { confirm });
    const host = new ToolRegistry();
    registerFlowBridge(host, { adapter }); // pendingMode defaults off
    await host.callTool("flow_delete_node", { id: "n1" });
    expect(confirm).not.toHaveBeenCalled();
    expect(adapter.getNodes()).toHaveLength(0);
  });

  it("staged run is blocked by a declined confirm", async () => {
    const confirm = vi.fn(async () => false);
    const run = vi.fn(async () => ({ ok: true, outputs: {} }));
    const adapter = makeAdapter([], { confirm, run });
    const host = new ToolRegistry();
    registerFlowBridge(host, { adapter, pendingMode: true });
    const res = await host.callTool("flow_run", {});
    expect(run).not.toHaveBeenCalled();
    expect(text(res)).toMatch(/declined/i);
  });
});
