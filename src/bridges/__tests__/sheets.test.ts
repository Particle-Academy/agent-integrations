import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerSheetsBridge } from "../sheets";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import type { JsonObject } from "../../mcp/types";

type Workbook = {
  activeSheetId: string;
  sheets: Array<{ id: string; name: string; cells: Record<string, { value: unknown }> }>;
};

function setup() {
  let workbook: Workbook = {
    activeSheetId: "s1",
    sheets: [
      { id: "s1", name: "Q1", cells: { A1: { value: "Revenue" }, B1: { value: 100 } } },
    ],
  };
  const activeCells: Array<[string, string]> = [];
  const host = new ToolRegistry();

  registerSheetsBridge(host, {
    adapter: {
      getWorkbook: () => workbook as never,
      setWorkbook: (next) => {
        workbook = next as unknown as Workbook;
      },
      setActiveCell: (sheetId, address) => activeCells.push([sheetId, address]),
    },
  });

  const call = async (name: string, args: JsonObject = {}) => {
    const r = await host.callTool(name, args);
    return { isError: r.isError, text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "" };
  };

  const sheets = () => workbook.sheets;

  return { host, call, workbook: () => workbook, sheets, activeCells };
}

describe("registerSheetsBridge", () => {
  beforeEach(() => resetAllUndoStacks());

  it("registers its tools", () => {
    const names = setup().host.listTools().map((t) => t.name);

    for (const t of ["sheet_describe", "sheet_get_cell", "sheet_get_range", "sheet_set_cell", "sheet_add_sheet", "sheet_set_active", "sheet_set_active_cell"]) {
      expect(names, `missing ${t}`).toContain(t);
    }
  });

  it("reads a cell by address", async () => {
    const { call } = setup();

    expect((await call("sheet_get_cell", { address: "A1" })).text).toContain("Revenue");
  });

  it("writes a cell through setWorkbook, not by mutating what it read", async () => {
    // The workbook is controlled. A mutation in place would not re-render, so
    // the agent's read-back would agree with itself while the user saw nothing.
    const { call, workbook, sheets } = setup();
    const before = workbook();

    await call("sheet_set_cell", { address: "B1", value: 250 });

    expect(workbook()).not.toBe(before);
    expect(sheets()[0]!.cells.B1!.value).toBe(250);
  });

  it("leaves neighbouring cells alone when one is written", async () => {
    const { call, sheets } = setup();

    await call("sheet_set_cell", { address: "B1", value: 250 });

    expect(sheets()[0]!.cells.A1!.value).toBe("Revenue");
  });

  it("adds a sheet without dropping the existing one", async () => {
    const { call, sheets } = setup();

    await call("sheet_add_sheet", { id: "s2", name: "Q2" });

    expect(sheets().map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("routes the active cell through the host handle", async () => {
    // Selection is view state the component owns; writing it into the workbook
    // would make a cursor move look like a document edit.
    const { call, activeCells } = setup();

    await call("sheet_set_active_cell", { address: "A1" });

    expect(activeCells).toHaveLength(1);
    expect(activeCells[0]![1]).toBe("A1");
  });

  it("reports an unknown sheet rather than writing into nothing", async () => {
    const { call } = setup();

    expect((await call("sheet_set_active", { sheet: "nope" })).isError).toBe(true);
  });
});
