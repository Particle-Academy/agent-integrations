import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerGridBridge, type GridState } from "../grid";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import type { JsonObject } from "../../mcp/types";

function setup(opts: { editable?: boolean; pendingMode?: boolean; columns?: string[]; rows?: string[] } = {}) {
  let state: GridState = {};
  const edits: Array<[string, string, unknown]> = [];
  const staged: Array<{ label: string; apply: () => void | Promise<void> }> = [];
  const host = new ToolRegistry();

  registerGridBridge(host, {
    adapter: {
      id: "orders",
      title: "Orders",
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      getColumnIds: () => opts.columns ?? ["id", "customer", "total", "status"],
      getRowIds: () => opts.rows ?? ["r1", "r2", "r3"],
      editCell: opts.editable === false ? undefined : (rowId, columnId, value) => {
        edits.push([rowId, columnId, value]);
      },
    },
    pendingMode: opts.pendingMode,
    onPending: (s) => staged.push(s),
  });

  const call = async (name: string, args: JsonObject = {}) => {
    const r = await host.callTool(name, args);
    return { isError: r.isError, text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "" };
  };

  return { host, call, state: () => state, edits, staged };
}

describe("registerGridBridge", () => {
  beforeEach(() => resetAllUndoStacks());

  it("registers the four tools the story names, plus a read", () => {
    const { host } = setup();
    const names = host.listTools().map((t) => t.name);

    for (const v of ["grid_get", "grid_sort", "grid_filter", "grid_select_rows", "grid_edit_cell"]) {
      expect(names, `missing ${v}`).toContain(v);
    }
    expect(names).toContain("agent_undo");
  });

  it("sorts, filters and selects through the one controlled channel", () => {
    // The grid is controlled by a single state object, so the bridge writes
    // through `setState` rather than mutating pieces — anything else would
    // drift from what the component actually accepts.
    return (async () => {
      const { call, state } = setup();

      await call("grid_sort", { sorting: [{ id: "total", desc: true }] });
      expect(state().sorting).toEqual([{ id: "total", desc: true }]);

      await call("grid_filter", { filters: [{ id: "status", value: "open" }] });
      expect(state().filters).toEqual([{ id: "status", value: "open" }]);
      expect(state().sorting, "filtering must not clear the sort").toEqual([{ id: "total", desc: true }]);

      await call("grid_select_rows", { rowIds: ["r1", "r3"] });
      expect(state().rowSelection).toEqual({ r1: true, r3: true });
    })();
  });

  it("clears with an empty array rather than needing a separate tool", async () => {
    const { call, state } = setup();

    await call("grid_sort", { sorting: [{ id: "total", desc: true }] });
    await call("grid_sort", { sorting: [] });

    expect(state().sorting).toEqual([]);
  });

  it("REJECTS an unknown column instead of writing state nothing applies", async () => {
    // A silently ignored sort looks exactly like a grid that is not sorted, so
    // the agent would have no way to tell it failed.
    const { call, state } = setup();
    const r = await call("grid_sort", { sorting: [{ id: "nope", desc: false }] });

    expect(r.isError).toBe(true);
    expect(r.text).toContain("Unknown column");
    expect(r.text, "the error should say what IS addressable").toContain("customer");
    expect(state().sorting, "state must be untouched").toBeUndefined();
  });

  it("rejects selecting a row that is not on the page", async () => {
    const { call, state } = setup();
    const r = await call("grid_select_rows", { rowIds: ["r1", "ghost"] });

    expect(r.isError).toBe(true);
    expect(r.text).toContain("ghost");
    expect(state().rowSelection).toBeUndefined();
  });

  it("reports what an agent can address, including whether cells are editable", async () => {
    const { call } = setup();
    const r = await call("grid_get");
    const payload = JSON.parse(r.text) as Record<string, unknown>;

    expect(payload.columnIds).toEqual(["id", "customer", "total", "status"]);
    expect(payload.rowIds).toEqual(["r1", "r2", "r3"]);
    expect(payload.editable).toBe(true);
  });

  it("omits grid_edit_cell entirely on a read-only grid", () => {
    // Discoverable from the tool list rather than failing at call time — an
    // agent should not have to try a write to learn it cannot write.
    const { host } = setup({ editable: false });

    expect(host.listTools().map((t) => t.name)).not.toContain("grid_edit_cell");
  });

  it("writes a cell when not gated", async () => {
    const { call, edits } = setup();
    await call("grid_edit_cell", { rowId: "r2", columnId: "status", value: "closed" });

    expect(edits).toEqual([["r2", "status", "closed"]]);
  });

  it("STAGES a cell edit under pendingMode, and writes nothing yet", async () => {
    // grid_edit_cell is the only tool here that changes stored DATA rather than
    // view state — sorting is not a trust-but-verify action, this is.
    const { call, edits, staged } = setup({ pendingMode: true });
    const r = await call("grid_edit_cell", { rowId: "r2", columnId: "status", value: "closed" });

    expect(r.text).toContain("Staged");
    expect(edits, "nothing may be written before a human confirms").toEqual([]);
    expect(staged).toHaveLength(1);

    await staged[0]!.apply();
    expect(edits).toEqual([["r2", "status", "closed"]]);
  });

  it("does not gate view-state changes under pendingMode", async () => {
    const { call, state } = setup({ pendingMode: true });
    await call("grid_sort", { sorting: [{ id: "total", desc: false }] });

    expect(state().sorting, "sorting is not destructive and should apply immediately").toEqual([
      { id: "total", desc: false },
    ]);
  });

  it("undoes a sort back to the previous state", async () => {
    const { call, state } = setup();

    await call("grid_sort", { sorting: [{ id: "total", desc: true }] });
    await call("grid_sort", { sorting: [{ id: "customer", desc: false }] });
    expect(state().sorting).toEqual([{ id: "customer", desc: false }]);

    await call("agent_undo", {});
    expect(state().sorting).toEqual([{ id: "total", desc: true }]);
  });

  it("disposes every tool it registered", () => {
    const host = new ToolRegistry();
    let state: GridState = {};
    const bridge = registerGridBridge(host, {
      adapter: { id: "g", getState: () => state, setState: (n) => { state = n; } },
    });

    expect(host.listTools().map((t) => t.name)).toContain("grid_sort");
    bridge.dispose();
    expect(host.listTools().map((t) => t.name)).not.toContain("grid_sort");
  });
});
