import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerGridBridge, type GridColumnInfo, type GridState } from "../grid";
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

/**
 * What an agent already written against this bridge sees, byte for byte.
 *
 * An adapter with none of the newer methods is a grid that may predate those
 * features, so it must get exactly the tools and payloads it always got. New
 * fields appear only when the adapter opts in by supplying what they read.
 */
describe("existing tool payloads stay compatible", () => {
  beforeEach(() => resetAllUndoStacks());

  it("lists exactly the original tools for an adapter with no new methods", () => {
    const { host } = setup();
    const names = host.listTools().map((t) => t.name).filter((n) => n.startsWith("grid_"));

    expect(names.sort()).toEqual(["grid_edit_cell", "grid_filter", "grid_get", "grid_select_rows", "grid_sort"]);
  });

  it("returns exactly the original grid_get payload", async () => {
    const { call } = setup();
    await call("grid_sort", { sorting: [{ id: "total", desc: true }] });
    await call("grid_select_rows", { rowIds: ["r1"] });

    const r = await call("grid_get");

    expect(JSON.parse(r.text)).toStrictEqual({
      id: "orders",
      title: "Orders",
      sorting: [{ id: "total", desc: true }],
      filters: [],
      selectedRowIds: ["r1"],
      columnIds: ["id", "customer", "total", "status"],
      rowIds: ["r1", "r2", "r3"],
      editable: true,
    });
  });

  it("keeps the original result text and argument shape for every write", async () => {
    const { call, edits } = setup();

    expect((await call("grid_sort", { sorting: [{ id: "total", desc: true }] })).text).toBe("Sorted by total desc.");
    expect((await call("grid_filter", { filters: [{ id: "status", value: "open" }] })).text).toBe("Filtering on status=open.");
    expect((await call("grid_select_rows", { rowIds: ["r1", "r2"] })).text).toBe("Selected 2 rows.");
    expect((await call("grid_edit_cell", { rowId: "r1", columnId: "total", value: 7 })).text).toBe("Set total on row r1.");
    expect(edits).toEqual([["r1", "total", 7]]);
  });

  it("keeps the original staged text under pendingMode", async () => {
    const { call } = setup({ pendingMode: true });
    const r = await call("grid_edit_cell", { rowId: "r1", columnId: "total", value: 7 });
    expect(r.text).toBe("Staged: set total on row r1. Awaiting confirmation.");
  });
});

describe("column visibility and pinning", () => {
  beforeEach(() => resetAllUndoStacks());

  const INFO: GridColumnInfo[] = [
    { id: "sku", header: "SKU", group: [], visible: true, pinned: null, sortable: true, filterable: false },
    { id: "q1", header: "Q1", group: ["sales"], visible: true, pinned: "left", sortable: false, filterable: false },
    { id: "q2", header: "Q2", group: ["sales"], visible: false, pinned: null, sortable: false, filterable: false },
  ];

  function columnSetup(initial: GridState = {}) {
    let state: GridState = initial;
    const host = new ToolRegistry();
    registerGridBridge(host, {
      adapter: {
        id: "g",
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        getColumnIds: () => INFO.map((c) => c.id),
        getRowIds: () => [],
        getColumnInfo: () => INFO,
      },
    });
    const call = async (name: string, args: JsonObject = {}) => {
      const r = await host.callTool(name, args);
      return { isError: r.isError, text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "" };
    };
    return { host, call, state: () => state };
  }

  it("offers the tools only to an adapter that reports columns", () => {
    // Discoverable from the tool list: an older grid ignores these slices, and a
    // pin nothing applied looks exactly like a grid with nothing pinned.
    expect(setup().host.listTools().map((t) => t.name)).not.toContain("grid_pin_columns");
    expect(setup().host.listTools().map((t) => t.name)).not.toContain("grid_set_column_visibility");

    const names = columnSetup().host.listTools().map((t) => t.name);
    expect(names).toContain("grid_pin_columns");
    expect(names).toContain("grid_set_column_visibility");
  });

  it("reports columns and their view state from grid_get", async () => {
    const { call } = columnSetup({ columnVisibility: { q2: false }, columnPinning: { left: ["q1"] } });
    const payload = JSON.parse((await call("grid_get")).text) as Record<string, unknown>;

    expect(payload.columns).toEqual(INFO);
    expect(payload.columnVisibility).toEqual({ q2: false });
    expect(payload.columnPinning).toEqual({ left: ["q1"] });
  });

  it("hides and shows columns through the one state channel, leaving other slices alone", async () => {
    const { call, state } = columnSetup({ sorting: [{ id: "sku", desc: false }] });
    const r = await call("grid_set_column_visibility", { columnVisibility: { q1: false } });

    expect(r.isError).toBeFalsy();
    expect(state().columnVisibility).toEqual({ q1: false });
    expect(state().sorting).toEqual([{ id: "sku", desc: false }]);
  });

  it("pins through the one state channel, and an empty call clears", async () => {
    const { call, state } = columnSetup();

    await call("grid_pin_columns", { left: ["sku"], right: ["q2"] });
    expect(state().columnPinning).toEqual({ left: ["sku"], right: ["q2"] });

    await call("grid_pin_columns", {});
    expect(state().columnPinning).toEqual({ left: [], right: [] });
  });

  it("refuses an unknown column, which includes a group's id", async () => {
    const { call, state } = columnSetup();

    for (const bad of ["nope", "sales"]) {
      const pin = await call("grid_pin_columns", { left: [bad] });
      expect(pin.isError).toBe(true);
      expect(pin.text).toContain("Unknown column");

      const hide = await call("grid_set_column_visibility", { columnVisibility: { [bad]: false } });
      expect(hide.isError).toBe(true);
    }
    expect(state()).toEqual({});
  });

  it("refuses a column pinned to both sides rather than picking one silently", async () => {
    const { call, state } = columnSetup();
    const r = await call("grid_pin_columns", { left: ["sku"], right: ["sku"] });

    expect(r.isError).toBe(true);
    expect(r.text).toContain("sku");
    expect(state().columnPinning).toBeUndefined();
  });

  it("undoes both back to the previous state", async () => {
    const { call, state } = columnSetup();

    await call("grid_pin_columns", { left: ["sku"] });
    await call("agent_undo", {});
    expect(state().columnPinning).toBeUndefined();

    await call("grid_set_column_visibility", { columnVisibility: { sku: false } });
    await call("agent_undo", {});
    expect(state().columnVisibility).toBeUndefined();
  });
});
