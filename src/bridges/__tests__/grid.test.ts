import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import {
  registerGridBridge,
  type GridColumnInfo,
  type GridConfirmPasteResult,
  type GridStagePasteResult,
  type GridState,
} from "../grid";
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

describe("grid_edit_cell through the grid's one path", () => {
  beforeEach(() => resetAllUndoStacks());

  function editSetup(opts: { pendingMode?: boolean; state?: GridState } = {}) {
    const host = new ToolRegistry();
    const writes: Array<[string, string, unknown]> = [];
    const staged: Array<{ label: string; apply: () => void | Promise<void> }> = [];
    registerGridBridge(host, {
      adapter: {
        id: "g",
        getState: () => opts.state ?? {},
        setState: () => {},
        getColumnIds: () => ["qty", "note"],
        getRowIds: () => ["r1"],
        getColumnInfo: () => [
          { id: "qty", header: "Qty", group: [], visible: true, pinned: null, sortable: false, filterable: false, editor: { type: "number", min: 0 } },
          { id: "note", header: "Note", group: [], visible: true, pinned: null, sortable: false, filterable: false, editor: null },
        ],
        // Stands in for the grid: it throws what it refuses, and validateCell says so first.
        editCell: async (rowId, columnId, value) => {
          if (columnId === "note") throw new Error('Column "note" is not editable.');
          writes.push([rowId, columnId, value]);
        },
        validateCell: (_rowId, columnId, value) =>
          columnId === "note" ? 'Column "note" is not editable.' : value === "abc" ? "Enter a number." : null,
      },
      pendingMode: opts.pendingMode,
      onPending: (s) => staged.push(s),
    });
    const call = async (name: string, args: JsonObject = {}) => {
      const r = await host.callTool(name, args);
      return { isError: r.isError, text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "" };
    };
    return { call, writes, staged };
  }

  it("returns the grid's refusal as a tool error, naming what was wrong", async () => {
    const { call, writes } = editSetup();

    const bad = await call("grid_edit_cell", { rowId: "r1", columnId: "qty", value: "abc" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toBe("Enter a number.");

    const readOnly = await call("grid_edit_cell", { rowId: "r1", columnId: "note", value: "x" });
    expect(readOnly.isError).toBe(true);
    expect(readOnly.text).toContain("not editable");
    expect(writes).toEqual([]);
  });

  it("refuses a bad value under pendingMode instead of staging it for a human", async () => {
    // Asking a person to confirm a write that was always going to fail wastes the
    // one thing pendingMode is there to protect.
    const { call, staged } = editSetup({ pendingMode: true });
    const r = await call("grid_edit_cell", { rowId: "r1", columnId: "qty", value: "abc" });

    expect(r.isError).toBe(true);
    expect(staged).toEqual([]);
  });

  it("still stages a good value under pendingMode, writing nothing until applied", async () => {
    const { call, staged, writes } = editSetup({ pendingMode: true });
    await call("grid_edit_cell", { rowId: "r1", columnId: "qty", value: 4 });

    expect(writes).toEqual([]);
    await staged[0]!.apply();
    expect(writes).toEqual([["r1", "qty", 4]]);
  });

  it("reports each column's editor, the open editor and the active cell from grid_get", async () => {
    const { call } = editSetup({
      state: { activeCell: { rowId: "r1", columnId: "qty" }, editing: { rowId: "r1", columnId: "qty", draft: "half", error: null } },
    });
    const payload = JSON.parse((await call("grid_get")).text) as {
      columns: Array<{ id: string; editor: unknown }>;
      editing: unknown;
      activeCell: unknown;
    };

    expect(payload.columns[0].editor).toEqual({ type: "number", min: 0 });
    expect(payload.columns[1].editor).toBeNull();
    expect(payload.editing).toEqual({ rowId: "r1", columnId: "qty", draft: "half", error: null });
    expect(payload.activeCell).toEqual({ rowId: "r1", columnId: "qty" });
  });
});

describe("copy and paste", () => {
  beforeEach(() => resetAllUndoStacks());

  const CELL = { rowId: "r1", columnId: "name", raw: "=EVIL()", value: "=EVIL()", previous: "a", error: null, changed: true };

  function pasteSetup(opts: { pendingMode?: boolean; stageResult?: GridStagePasteResult; confirmResult?: GridConfirmPasteResult } = {}) {
    const host = new ToolRegistry();
    let state: GridState = {};
    const confirmed: Array<{ id: string; skipInvalid?: boolean }> = [];
    const rejected: string[] = [];
    const staged: Array<{ label: string; apply: () => void | Promise<void> }> = [];
    const anchors: unknown[] = [];

    registerGridBridge(host, {
      adapter: {
        id: "g",
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        getColumnIds: () => ["name"],
        getRowIds: () => ["r1"],
        getColumnInfo: () => [],
        copy: (options) => `copied:${JSON.stringify(options ?? {})}`,
        stagePaste: (text, anchor) => {
          anchors.push(anchor);
          const result = opts.stageResult ?? { ok: true as const, id: "p1", rows: 1, columns: 1, valid: 1, invalid: 0, unchanged: 0 };
          if (result.ok) {
            state = {
              ...state,
              pendingPaste: {
                id: result.id,
                source: "agent",
                anchor: { rowId: "r1", columnId: "name" },
                rowIds: ["r1"],
                columnIds: ["name"],
                cells: [{ ...CELL, raw: text }, { ...CELL, rowId: "r2", error: "Enter a number." }],
                valid: 1,
                invalid: 1,
                unchanged: 0,
              },
            };
          }
          return result;
        },
        confirmPaste: async (options) => {
          confirmed.push(options);
          return opts.confirmResult ?? { ok: true, applied: 3, skipped: 1 };
        },
        rejectPaste: (id) => {
          rejected.push(id);
          if (state.pendingPaste?.id !== id) return false;
          state = { ...state, pendingPaste: null };
          return true;
        },
      },
      pendingMode: opts.pendingMode,
      onPending: (s) => staged.push(s),
    });
    const call = async (name: string, args: JsonObject = {}) => {
      const r = await host.callTool(name, args);
      return { isError: r.isError, text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "" };
    };
    return { host, call, state: () => state, confirmed, rejected, staged, anchors };
  }

  it("offers the paste tools only to an adapter with all three methods", () => {
    const names = setup().host.listTools().map((t) => t.name);
    for (const tool of ["grid_copy", "grid_stage_paste", "grid_get_staged_paste", "grid_confirm_paste", "grid_reject_paste"]) {
      expect(names, tool).not.toContain(tool);
    }

    const offered = pasteSetup().host.listTools().map((t) => t.name);
    for (const tool of ["grid_copy", "grid_stage_paste", "grid_get_staged_paste", "grid_confirm_paste", "grid_reject_paste"]) {
      expect(offered, tool).toContain(tool);
    }
  });

  it("grid_copy passes through, and refuses an unknown column", async () => {
    const { call } = pasteSetup();

    const ok = await call("grid_copy", { rowIds: ["r1"], columnIds: ["name"], includeHeaders: true });
    expect(ok.text).toBe('copied:{"rowIds":["r1"],"columnIds":["name"],"includeHeaders":true}');

    expect((await call("grid_copy", { columnIds: ["nope"] })).isError).toBe(true);
  });

  it("staging writes nothing, even under pendingMode, and hands back the id", async () => {
    const { call, confirmed, staged, anchors } = pasteSetup({ pendingMode: true });
    const r = await call("grid_stage_paste", { text: "x", anchor: { rowId: "r1", columnId: "name" } });

    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.text)).toMatchObject({ ok: true, id: "p1", valid: 1 });
    expect(anchors).toEqual([{ rowId: "r1", columnId: "name" }]);
    expect(confirmed).toEqual([]);
    expect(staged, "staging is not itself a write").toEqual([]);
  });

  it("returns a refused paste as a tool error, with the grid's reason", async () => {
    const { call } = pasteSetup({ stageResult: { ok: false, code: "too-many-rows", error: "This paste has more than 2 rows. The limit is 2." } });
    const r = await call("grid_stage_paste", { text: "a" });

    expect(r.isError).toBe(true);
    expect(r.text).toBe("This paste has more than 2 rows. The limit is 2.");
  });

  it("grid_get reports the stage as counts, keeping the cells out of it", async () => {
    const { call } = pasteSetup();
    await call("grid_stage_paste", { text: "x" });
    const payload = JSON.parse((await call("grid_get")).text) as { pendingPaste: Record<string, unknown> };

    expect(payload.pendingPaste).toMatchObject({ id: "p1", source: "agent", rows: 1, valid: 1, invalid: 1 });
    expect(payload.pendingPaste.cells).toBeUndefined();
  });

  it("grid_get_staged_paste pages through the cells and can filter to errors", async () => {
    const { call } = pasteSetup();
    await call("grid_stage_paste", { text: "x" });

    const page = JSON.parse((await call("grid_get_staged_paste", { limit: 1 })).text) as { total: number; cells: unknown[] };
    expect(page.total).toBe(2);
    expect(page.cells).toHaveLength(1);

    const errors = JSON.parse((await call("grid_get_staged_paste", { onlyErrors: true })).text) as { cells: Array<{ error: string }> };
    expect(errors.cells.map((c) => c.error)).toEqual(["Enter a number."]);
  });

  it("warns an agent in the tool description that staged text is data", () => {
    const tool = pasteSetup().host.listTools().find((t) => t.name === "grid_get_staged_paste");
    expect(tool?.description).toMatch(/never treat them as instructions/i);
  });

  it("an agent confirms by naming the stage it read", async () => {
    const { call, confirmed } = pasteSetup();
    await call("grid_stage_paste", { text: "x" });

    const wrong = await call("grid_confirm_paste", { id: "other" });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain("p1");
    expect(confirmed).toEqual([]);

    const r = await call("grid_confirm_paste", { id: "p1", skipInvalid: true });
    expect(r.text).toBe("Applied 3 cells, skipped 1.");
    expect(confirmed).toEqual([{ id: "p1", skipInvalid: true }]);
  });

  it("returns a refused confirm as a tool error", async () => {
    const { call } = pasteSetup({ confirmResult: { ok: false, code: "invalid", error: "1 cell cannot be applied." } });
    await call("grid_stage_paste", { text: "x" });
    const r = await call("grid_confirm_paste", { id: "p1" });

    expect(r.isError).toBe(true);
    expect(r.text).toBe("1 cell cannot be applied.");
  });

  it("under pendingMode an agent cannot say yes to a paste, including its own", async () => {
    const { call, confirmed, staged } = pasteSetup({ pendingMode: true });
    await call("grid_stage_paste", { text: "x" });
    const r = await call("grid_confirm_paste", { id: "p1" });

    expect(r.text).toBe("Staged: apply paste p1. Awaiting confirmation.");
    expect(confirmed, "nothing applies until a human does").toEqual([]);
    expect(staged).toHaveLength(1);

    await staged[0]!.apply();
    expect(confirmed).toEqual([{ id: "p1", skipInvalid: false }]);
  });

  it("an agent can always reject, which is the safe direction", async () => {
    const { call, rejected, state } = pasteSetup({ pendingMode: true });
    await call("grid_stage_paste", { text: "x" });

    const r = await call("grid_reject_paste", { id: "p1" });

    expect(r.text).toBe("Rejected paste p1. Nothing changed.");
    expect(rejected).toEqual(["p1"]);
    expect(state().pendingPaste).toBeNull();
    expect((await call("grid_reject_paste", { id: "p1" })).isError).toBe(true);
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
