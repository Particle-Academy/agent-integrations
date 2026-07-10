import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";
import type { AgentTarget } from "../presence/types";
import type { CellValue, SheetData, SheetOp, WorkbookData } from "@particle-academy/fancy-sheets";

/**
 * Cell writes funnel through fancy-sheets' own `reduceWorkbook` + `SheetOp` —
 * the same reducer that drives `<SheetWorkbook>` — so agent edits recalculate
 * formulas and land byte-identical to human edits, mirroring how the slides
 * bridge works. Types come straight from the package (no drift); the reducer
 * VALUE is lazy-imported inside the mutation handlers so the package barrel
 * never statically pulls this optional peer (see issue #3).
 */

export type SheetsBridgeAdapter = {
  /** fancy-screens screen id (optional) so activity events know which screen the sheet lives in. */
  screenId?: string;
  /** Read the current workbook. */
  getWorkbook: () => WorkbookData;
  /** Replace the workbook. Host wires this to its onChange. */
  setWorkbook: (next: WorkbookData) => void;
  /** Optional: programmatically change the active cell. */
  setActiveCell?: (sheetId: string, address: string) => void;
};

export type SheetsBridgeOptions = {
  adapter: SheetsBridgeAdapter;
  agent?: { id: string; name?: string; color?: string };
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };

/**
 * registerSheetsBridge — schema-aware MCP access to a fancy-sheets workbook.
 * Tools are sheet-aware (every mutator takes an explicit `sheet` id, defaulting
 * to the active sheet when omitted) so an agent can author multi-sheet docs.
 */
export function registerSheetsBridge(
  host: ToolHost,
  options: SheetsBridgeOptions,
): Bridge {
  const { adapter } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const disposers: Array<() => void> = [];

  // agent_undo / agent_redo / agent_history are registered whenever any bridge
  // mounts, so undo availability doesn't hinge on which bridges are co-present.
  ensureUndoToolsRegistered(host, { defaultAgentId: agent.id });

  const target = (sheetId: string, address?: string): AgentTarget => ({
    kind: "sheet",
    screenId: adapter.screenId,
    elementId: address ? `${sheetId}!${address}` : sheetId,
    label: address ? `${sheetId}!${address}` : sheetId,
  });

  const reg = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: JsonObject) => Promise<any> | any,
    isMutation: boolean,
    resolveTarget?: (args: JsonObject, result: any) => AgentTarget | null,
  ) => {
    const wrapped = async (args: JsonObject) => {
      try {
        return await handler(args);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    };
    const final = isMutation
      ? wrapToolWithActivity(wrapped, {
          toolName: name,
          agent,
          kind: "sheet",
          screenId: adapter.screenId,
          resolveTarget: ({ args, result }) =>
            resolveTarget?.(args, result) ?? target(getSheetId(args)),
        })
      : wrapped;
    disposers.push(
      host.registerTool(
        {
          name,
          description,
          inputSchema: { type: "object", properties: properties as any, required, additionalProperties: false },
        },
        final as any,
      ),
    );
  };

  function activeSheetId(): string {
    return adapter.getWorkbook().activeSheetId;
  }
  function getSheetId(args: JsonObject): string {
    return typeof args.sheet === "string" ? args.sheet : activeSheetId();
  }
  function getSheet(workbook: WorkbookData, sheetId: string): SheetData | undefined {
    return workbook.sheets.find((s) => s.id === sheetId);
  }

  // ───────────── Read tools ─────────────

  reg(
    "sheet_describe",
    "Describe the workbook: every sheet's id, name, dimensions, cell count, active sheet. Call before reading or writing.",
    {},
    [],
    () => {
      const wb = adapter.getWorkbook();
      const summary = {
        activeSheetId: wb.activeSheetId,
        sheets: wb.sheets.map((s) => ({
          id: s.id,
          name: s.name,
          cellCount: Object.keys(s.cells).length,
          columnCount: Object.keys(s.columnWidths).length,
          frozenRows: s.frozenRows,
          frozenCols: s.frozenCols,
        })),
      };
      const text = `Active: ${summary.activeSheetId}\n` + summary.sheets
        .map((s) => `${s.id} "${s.name}" — ${s.cellCount} cells`)
        .join("\n");
      return textResult(text, summary);
    },
    false,
  );

  reg(
    "sheet_get_cell",
    "Read a single cell's raw + computed value.",
    {
      sheet: { type: "string", description: "Sheet id (defaults to active)." },
      address: { type: "string", description: "A1-style address, e.g. \"B12\"." },
    },
    ["address"],
    (args) => {
      const sheetId = getSheetId(args);
      const address = String(args.address);
      const sheet = getSheet(adapter.getWorkbook(), sheetId);
      if (!sheet) return errorResult(`No sheet ${sheetId}`);
      const cell = sheet.cells[address];
      if (!cell) {
        return textResult(`(empty)`, { sheet: sheetId, address, value: null });
      }
      return textResult(`${address} = ${JSON.stringify(cell.computedValue ?? cell.value)}`, { ...cell, sheet: sheetId, address });
    },
    false,
  );

  reg(
    "sheet_get_range",
    "Read a rectangular range as a 2D array of values.",
    {
      sheet: { type: "string" },
      start: { type: "string", description: "Top-left A1 address." },
      end: { type: "string", description: "Bottom-right A1 address." },
    },
    ["start", "end"],
    (args) => {
      const sheetId = getSheetId(args);
      const sheet = getSheet(adapter.getWorkbook(), sheetId);
      if (!sheet) return errorResult(`No sheet ${sheetId}`);
      const grid = readRange(sheet, String(args.start), String(args.end));
      return textResult(JSON.stringify(grid), { sheet: sheetId, start: args.start, end: args.end, values: grid });
    },
    false,
  );

  // ───────────── Mutation tools ─────────────

  reg(
    "sheet_set_cell",
    "Set a single cell's value. To set a formula, pass a string starting with '='.",
    {
      sheet: { type: "string" },
      address: { type: "string" },
      value: { description: "string | number | boolean | null. Strings starting with '=' are stored as formulas." },
    },
    ["address", "value"],
    async (args) => {
      const sheetId = getSheetId(args);
      const address = String(args.address);
      const value = args.value as CellValue;
      const wb = adapter.getWorkbook();
      if (!getSheet(wb, sheetId)) return errorResult(`No sheet ${sheetId}`);
      const { reduceWorkbook } = await import("@particle-academy/fancy-sheets");
      adapter.setWorkbook(reduceWorkbook(wb, setCellOp(sheetId, address, value)));
      return textResult(`${sheetId}!${address} ← ${JSON.stringify(value)}`, { sheet: sheetId, address, value });
    },
    true,
    (args) => target(getSheetId(args), String(args.address ?? "")),
  );

  reg(
    "sheet_set_range",
    "Set many cells atomically. `cells` is an object map of { \"A1\": value, \"B2\": value, ... }.",
    {
      sheet: { type: "string" },
      cells: { type: "object" },
    },
    ["cells"],
    async (args) => {
      const sheetId = getSheetId(args);
      const wb = adapter.getWorkbook();
      if (!getSheet(wb, sheetId)) return errorResult(`No sheet ${sheetId}`);
      const cells = (args.cells && typeof args.cells === "object") ? args.cells as Record<string, CellValue> : {};
      const { reduceWorkbook } = await import("@particle-academy/fancy-sheets");
      let next = wb;
      for (const [addr, v] of Object.entries(cells)) next = reduceWorkbook(next, setCellOp(sheetId, addr, v));
      adapter.setWorkbook(next);
      return textResult(`Set ${Object.keys(cells).length} cells in ${sheetId}`, { sheet: sheetId, count: Object.keys(cells).length });
    },
    true,
  );

  reg(
    "sheet_add_sheet",
    "Add a new sheet (tab) to the workbook.",
    { id: { type: "string" }, name: { type: "string" } },
    ["id", "name"],
    (args) => {
      const wb = adapter.getWorkbook();
      const id = String(args.id);
      const name = String(args.name);
      if (wb.sheets.find((s) => s.id === id)) return errorResult(`Sheet ${id} already exists`);
      const next: WorkbookData = {
        ...wb,
        sheets: [
          ...wb.sheets,
          {
            id, name, cells: {}, columnWidths: {}, mergedRegions: [],
            columnFilters: {}, frozenRows: 0, frozenCols: 0,
          },
        ],
      };
      adapter.setWorkbook(next);
      return textResult(`Added sheet ${id} ("${name}")`, { id, name });
    },
    true,
    (args) => target(String(args.id ?? "")),
  );

  reg(
    "sheet_set_active",
    "Switch to a different sheet tab.",
    { sheet: { type: "string" } },
    ["sheet"],
    (args) => {
      const sheetId = String(args.sheet);
      const wb = adapter.getWorkbook();
      if (!getSheet(wb, sheetId)) return errorResult(`No sheet ${sheetId}`);
      adapter.setWorkbook({ ...wb, activeSheetId: sheetId });
      return textResult(`Active sheet → ${sheetId}`, { sheet: sheetId });
    },
    true,
  );

  reg(
    "sheet_set_active_cell",
    "Move the active cell selection (host implements DOM focus + scroll).",
    { sheet: { type: "string" }, address: { type: "string" } },
    ["address"],
    (args) => {
      if (!adapter.setActiveCell) return errorResult("Host did not provide setActiveCell.");
      const sheetId = getSheetId(args);
      adapter.setActiveCell(sheetId, String(args.address));
      return textResult(`Active cell → ${sheetId}!${args.address}`, { sheet: sheetId, address: args.address });
    },
    true,
    (args) => target(getSheetId(args), String(args.address ?? "")),
  );

  return {
    id: "sheets",
    title: "Sheets",
    dispose: () => {
      for (const d of disposers) d();
    },
  };
}

// ───────────── helpers ─────────────

/** Build a `set_cell` op, treating a leading-"=" string as a formula — matching
 *  the in-app editor (value keeps the raw "=…"; formula drops the "="). */
function setCellOp(sheet: string, address: string, value: CellValue): SheetOp {
  if (typeof value === "string" && value.startsWith("=")) {
    return { type: "set_cell", sheet, address, value, formula: value.slice(1) };
  }
  return { type: "set_cell", sheet, address, value };
}

/** Parse "B12" → { col: 1, row: 11 }. Letters are 1-based, rows 1-based. */
function parseAddress(addr: string): { col: number; row: number } {
  const m = /^([A-Za-z]+)(\d+)$/.exec(addr.trim());
  if (!m) throw new Error(`Bad address: ${addr}`);
  const letters = m[1].toUpperCase();
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return { col: col - 1, row: parseInt(m[2], 10) - 1 };
}

function colToLetter(col: number): string {
  let s = "";
  let n = col + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function readRange(sheet: SheetData, startAddr: string, endAddr: string): CellValue[][] {
  const start = parseAddress(startAddr);
  const end = parseAddress(endAddr);
  const r0 = Math.min(start.row, end.row);
  const r1 = Math.max(start.row, end.row);
  const c0 = Math.min(start.col, end.col);
  const c1 = Math.max(start.col, end.col);
  const grid: CellValue[][] = [];
  for (let r = r0; r <= r1; r++) {
    const row: CellValue[] = [];
    for (let c = c0; c <= c1; c++) {
      const addr = `${colToLetter(c)}${r + 1}`;
      const cell = sheet.cells[addr];
      row.push(cell?.computedValue ?? cell?.value ?? null);
    }
    grid.push(row);
  }
  return grid;
}
