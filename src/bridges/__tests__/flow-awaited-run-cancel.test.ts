import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import {
  registerFlowBridge,
  type FlowBridgeAdapter,
  type FlowBridgeOptions,
  type FlowAdapterResult,
  type FlowRunContext,
} from "../flow";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import { onActivity, resetActivityRegistry } from "../../presence";
import type { JsonObject } from "../../mcp/types";

/**
 * The run/cancel counterpart of flow-awaited-commit.test.ts (0.55.0).
 * `flow_run` and `flow_cancel` wait for the host, may be refused, and are fenced
 * against the bridge being disposed or replaced. Closing the UI is never a
 * backend cancellation: dispose must not call `adapter.cancel`.
 */

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(opts: { options?: Partial<FlowBridgeOptions>; adapter?: Partial<FlowBridgeAdapter> } = {}) {
  const g = { nodes: [] as any[], edges: [] as any[] };
  let revision = 3;
  const host = new ToolRegistry();
  const adapter: FlowBridgeAdapter = {
    getNodes: () => g.nodes,
    setNodes: vi.fn(),
    getEdges: () => g.edges,
    setEdges: vi.fn(),
    getRevision: () => revision,
    ...opts.adapter,
  };
  const bridge = registerFlowBridge(host, {
    adapter,
    agent: { id: "maipa-agent", name: "Maipa" },
    validateConnections: false,
    ...opts.options,
  });
  const activity: string[] = [];
  onActivity((e) => { activity.push(e.action); });
  const call = async (name: string, args: JsonObject = {}) => {
    const r = await host.callTool(name, args);
    return {
      isError: r.isError === true,
      text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "",
      structured: r.structuredContent as Record<string, any> | undefined,
    };
  };
  return { host, adapter, bridge, call, activity, bumpRevision: () => revision++ };
}

beforeEach(() => {
  resetAllUndoStacks();
  resetActivityRegistry();
});

describe("flow_cancel — awaited", () => {
  it("a slow cancel reports no success and no activity until it resolves", async () => {
    const gate = deferred<void>();
    const cancel = vi.fn(() => gate.promise);
    const ctx = setup({ adapter: { cancel } });
    let settled = false;
    const pending = ctx.call("flow_cancel").then((r) => { settled = true; return r; });
    await flush();
    await flush();
    // The bug: 0.54.1 called cancel without await and claimed success at once.
    expect(settled).toBe(false);
    expect(ctx.activity).toHaveLength(0);

    gate.resolve();
    const r = await pending;
    expect(r.isError).toBe(false);
    expect(r.text).toBe("Run cancelled");
    expect(ctx.activity).toEqual(["flow_cancel"]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("{ ok: true } counts as accepted", async () => {
    const ctx = setup({ adapter: { cancel: async () => ({ ok: true }) as FlowAdapterResult } });
    const r = await ctx.call("flow_cancel");
    expect(r.isError).toBe(false);
    expect(ctx.activity).toEqual(["flow_cancel"]);
  });
});

describe("flow_cancel — refusable", () => {
  it("{ ok: false } is a tool error with the host's message and code; no activity", async () => {
    const ctx = setup({
      adapter: { cancel: async () => ({ ok: false, error: "Run already finished.", code: "not_running" }) },
    });
    const r = await ctx.call("flow_cancel");
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Run already finished.");
    expect(r.structured).toEqual({ ok: false, op: "cancel", error: "Run already finished.", code: "not_running" });
    expect(ctx.activity).toHaveLength(0);
  });

  it("a rejection is a tool error, never a stack; no activity", async () => {
    const ctx = setup({
      adapter: {
        cancel: () => Promise.reject(new Error("Forbidden for this user\n    at stop (C:/srv/internal/runs.ts:9:1)")),
      },
    });
    const r = await ctx.call("flow_cancel");
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Forbidden for this user");
    expect(r.text).not.toContain("runs.ts");
    expect(r.structured).toMatchObject({ ok: false, op: "cancel", error: "Forbidden for this user" });
    expect(r.structured?.code).toBeUndefined();
    expect(ctx.activity).toHaveLength(0);
  });

  it("a synchronous throw is a tool error; no activity", async () => {
    const ctx = setup({ adapter: { cancel: () => { throw new Error("cannot stop"); } } });
    const r = await ctx.call("flow_cancel");
    expect(r.isError).toBe(true);
    expect(r.text).toBe("cannot stop");
    expect(r.structured).toMatchObject({ ok: false, op: "cancel" });
    expect(ctx.activity).toHaveLength(0);
  });

  it("a sync { ok: false } is refused the same way", async () => {
    const ctx = setup({ adapter: { cancel: () => ({ ok: false, error: "No run." }) } });
    const r = await ctx.call("flow_cancel");
    expect(r.isError).toBe(true);
    expect(r.structured).toEqual({ ok: false, op: "cancel", error: "No run." });
    expect(ctx.activity).toHaveLength(0);
  });
});

describe("flow_run — refusable", () => {
  it("{ ok: false } is a tool error with code; no activity", async () => {
    const ctx = setup({ adapter: { run: async () => ({ ok: false, error: "Not allowed to run.", code: "forbidden" }) } });
    const r = await ctx.call("flow_run");
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Not allowed to run.");
    expect(r.structured).toEqual({ ok: false, op: "run", error: "Not allowed to run.", code: "forbidden" });
    expect(ctx.activity).toHaveLength(0);
  });

  it("a rejection is a tool error with op 'run', never a stack; no activity", async () => {
    const ctx = setup({
      adapter: { run: () => Promise.reject(new Error("Quota hit\n    at go (C:/srv/x.ts:1:1)")) },
    });
    const r = await ctx.call("flow_run");
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Quota hit");
    expect(r.structured).toMatchObject({ ok: false, op: "run", error: "Quota hit" });
    expect(ctx.activity).toHaveLength(0);
  });

  it("a slow run reports nothing until it resolves", async () => {
    const gate = deferred<FlowAdapterResult>();
    const ctx = setup({ adapter: { run: () => gate.promise } });
    let settled = false;
    const pending = ctx.call("flow_run").then((r) => { settled = true; return r; });
    await flush();
    expect(settled).toBe(false);
    expect(ctx.activity).toHaveLength(0);
    gate.resolve({ ok: true });
    const r = await pending;
    expect(r.isError).toBe(false);
    expect(ctx.activity).toEqual(["flow_run"]);
  });

  it("void counts as accepted", async () => {
    const ctx = setup({ adapter: { run: async () => undefined } });
    const r = await ctx.call("flow_run");
    expect(r.isError).toBe(false);
    expect(ctx.activity).toEqual(["flow_run"]);
  });
});

describe("context captured at call time and passed to the host", () => {
  it("run gets the agent, the revision read at call time and the tool; not recomputed after the await", async () => {
    const gate = deferred<void>();
    const seen: FlowRunContext[] = [];
    const confirmGate = deferred<boolean>();
    const ctx = setup({
      options: { pendingMode: true },
      adapter: {
        confirm: () => confirmGate.promise,
        run: (_executors, context) => { seen.push(context!); return gate.promise; },
      },
    });
    const pending = ctx.call("flow_run");
    await flush();
    // The graph moves while the human decides; the run keeps its basis.
    ctx.bumpRevision();
    confirmGate.resolve(true);
    await flush();
    ctx.bumpRevision();
    gate.resolve();
    await pending;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ tool: "flow_run", agent: { id: "maipa-agent", name: "Maipa", color: "#a855f7" }, revision: 3 });
  });

  it("cancel gets the agent, revision and the runId argument", async () => {
    const seen: FlowRunContext[] = [];
    const ctx = setup({ adapter: { cancel: (context) => { seen.push(context!); } } });
    await ctx.call("flow_cancel", { runId: "run_42" });
    expect(seen[0]).toEqual({
      tool: "flow_cancel",
      agent: { id: "maipa-agent", name: "Maipa", color: "#a855f7" },
      revision: 3,
      runId: "run_42",
    });
  });

  it("revision is absent when the adapter has no getRevision", async () => {
    const seen: FlowRunContext[] = [];
    const ctx = setup({ adapter: { getRevision: undefined, cancel: (c) => { seen.push(c!); } } });
    await ctx.call("flow_cancel");
    expect(seen[0].revision).toBeUndefined();
    expect(seen[0].runId).toBeUndefined();
  });
});

describe("fencing: dispose and replacement settle as unknown, and never cancel the backend", () => {
  it("dispose during a pending run: outcome unknown, cancel NOT called, no late activity", async () => {
    const gate = deferred<FlowAdapterResult>();
    const cancel = vi.fn();
    const ctx = setup({ adapter: { run: () => gate.promise, cancel } });
    const pending = ctx.call("flow_run");
    await flush();
    ctx.bridge.dispose();
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/closed or replaced/i);
    expect(r.text).toMatch(/unknown/i);
    expect(cancel).not.toHaveBeenCalled();
    gate.resolve({ ok: true });
    await flush();
    expect(ctx.activity).toHaveLength(0);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("dispose during a pending cancel: outcome unknown, no late activity", async () => {
    const gate = deferred<void>();
    const cancel = vi.fn(() => gate.promise);
    const ctx = setup({ adapter: { cancel } });
    const pending = ctx.call("flow_cancel");
    await flush();
    ctx.bridge.dispose();
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown/i);
    gate.resolve();
    await flush();
    expect(ctx.activity).toHaveLength(0);
    // Exactly the agent's own call; dispose added none.
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("dispose during a pending run confirm: settles at once, run and cancel never called", async () => {
    const confirmGate = deferred<boolean>();
    const run = vi.fn(async () => ({ ok: true }) as FlowAdapterResult);
    const cancel = vi.fn();
    const ctx = setup({ options: { pendingMode: true }, adapter: { confirm: () => confirmGate.promise, run, cancel } });
    const pending = ctx.call("flow_run");
    await flush();
    ctx.bridge.dispose();
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/closed/i);
    confirmGate.resolve(true);
    await flush();
    expect(run).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(ctx.activity).toHaveLength(0);
  });

  it("dispose with nothing pending never calls cancel", () => {
    const cancel = vi.fn();
    const ctx = setup({ adapter: { cancel, run: async () => undefined } });
    ctx.bridge.dispose();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("a late rejection after dispose is swallowed, for run and for cancel", async () => {
    const runGate = deferred<void>();
    const cancelGate = deferred<void>();
    const ctx = setup({ adapter: { run: () => runGate.promise, cancel: () => cancelGate.promise } });
    const p1 = ctx.call("flow_run");
    const p2 = ctx.call("flow_cancel");
    await flush();
    ctx.bridge.dispose();
    expect((await p1).isError).toBe(true);
    expect((await p2).isError).toBe(true);
    runGate.reject(new Error("too late"));
    cancelGate.reject(new Error("too late"));
    await flush();
    // vitest fails the run on an unhandled rejection; reaching here is the assertion.
    expect(ctx.activity).toHaveLength(0);
  });

  it("replacement during a pending run: outcome unknown, cancel NOT called, no late activity", async () => {
    const gate = deferred<void>();
    const cancel = vi.fn();
    const ctx = setup({ adapter: { run: () => gate.promise, cancel } });
    const pending = ctx.call("flow_run");
    await flush();
    registerFlowBridge(ctx.host, { adapter: { ...ctx.adapter } });
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown/i);
    gate.resolve();
    await flush();
    expect(ctx.activity).toHaveLength(0);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("replacement during a pending cancel: outcome unknown, no late activity", async () => {
    const gate = deferred<void>();
    const cancel = vi.fn(() => gate.promise);
    const ctx = setup({ adapter: { cancel } });
    const pending = ctx.call("flow_cancel");
    await flush();
    registerFlowBridge(ctx.host, { adapter: { ...ctx.adapter } });
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown/i);
    gate.resolve();
    await flush();
    expect(ctx.activity).toHaveLength(0);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("replacement during a pending run confirm: run never called", async () => {
    const confirmGate = deferred<boolean>();
    const run = vi.fn(async () => undefined);
    const ctx = setup({ options: { pendingMode: true }, adapter: { confirm: () => confirmGate.promise, run } });
    const pending = ctx.call("flow_run");
    await flush();
    registerFlowBridge(ctx.host, { adapter: { ...ctx.adapter } });
    expect((await pending).isError).toBe(true);
    confirmGate.resolve(true);
    await flush();
    expect(run).not.toHaveBeenCalled();
    expect(ctx.activity).toHaveLength(0);
  });
});

describe("legacy adapters keep working", () => {
  it("a sync void cancel still succeeds with the same text and one activity", async () => {
    const cancel = vi.fn(() => {});
    const ctx = setup({ adapter: { cancel } });
    const r = await ctx.call("flow_cancel");
    expect(r.isError).toBe(false);
    expect(r.text).toBe("Run cancelled");
    expect(ctx.activity).toEqual(["flow_cancel"]);
  });

  it("a legacy RunResult run keeps its texts and structured result", async () => {
    const ok = setup({ adapter: { run: async () => ({ ok: true, outputs: { a: 1 } }) } });
    const r1 = await ok.call("flow_run");
    expect(r1.isError).toBe(false);
    expect(r1.text).toBe("Run complete");
    expect(r1.structured).toEqual({ ok: true, outputs: { a: 1 } });

    // A run that happened and failed is a result, not a refusal (unchanged).
    const failed = setup({ adapter: { run: async () => ({ ok: false, outputs: {}, error: "node b threw" }) } });
    const r2 = await failed.call("flow_run");
    expect(r2.isError).toBe(false);
    expect(r2.text).toBe("Run failed: node b threw");
    expect(r2.structured).toEqual({ ok: false, outputs: {}, error: "node b threw" });
  });

  it("a declined run confirm is unchanged", async () => {
    const run = vi.fn();
    const ctx = setup({ options: { pendingMode: true }, adapter: { confirm: async () => false, run } });
    const r = await ctx.call("flow_run");
    expect(r.text).toBe("Run was declined by the human.");
    expect(run).not.toHaveBeenCalled();
  });

  it("missing run / cancel handlers keep their errors", async () => {
    const ctx = setup();
    expect((await ctx.call("flow_run")).text).toBe("Host did not provide a run handler.");
    expect((await ctx.call("flow_cancel")).text).toBe("Host did not provide a cancel handler.");
  });
});
