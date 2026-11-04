import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";
import { pushUndoEntry } from "../undo/undo-stack";
import type { AgentTarget } from "../presence/types";

/**
 * Loose grid types — the public state shape of `@particle-academy/fancy-grid`,
 * mirrored here rather than imported.
 *
 * Same reason the scene bridge mirrors fancy-3d's descriptor: a bridge must not
 * drag its surface package into every consumer's tree. fancy-grid keeps
 * TanStack Table and Virtual as PEERS specifically so nothing bundles them, and
 * an `import type` here would still make fancy-grid a build-time dependency of
 * agent-integrations. The state is four small JSON shapes; the coupling is not
 * worth it.
 */
export type GridSort = { id: string; desc: boolean };
export type GridFilter = { id: string; value: string };
export type GridPagination = { pageIndex: number; pageSize: number };
export type GridColumnPinning = { left?: string[]; right?: string[] };
/** How a column is edited, which is what an agent has to know to write it. */
export type GridEditor =
  | { type: "text"; required?: boolean; maxLength?: number; placeholder?: string }
  | { type: "number"; required?: boolean; min?: number; max?: number; step?: number; placeholder?: string }
  | {
      type: "select";
      required?: boolean;
      options: Array<string | { value: string; label: string }>;
      placeholder?: string;
    };
export type GridCellRef = { rowId: string; columnId: string };
/** The editor open in the grid, and what has been typed in it so far. */
export type GridEditing = GridCellRef & { draft: unknown; error?: string | null; pending?: boolean };
/** One leaf column as the grid reports it. */
export type GridColumnInfo = {
  id: string;
  header: string;
  /** Ids of the groups it sits in, outermost first. */
  group: string[];
  visible: boolean;
  pinned: "left" | "right" | null;
  sortable: boolean;
  filterable: boolean;
  /** What the column accepts, or `null` if it is read-only. */
  editor?: GridEditor | null;
};

export type GridState = {
  sorting?: GridSort[];
  filters?: GridFilter[];
  /** Keyed by row id — see the grid's `getRowId`. */
  rowSelection?: Record<string, boolean>;
  pagination?: GridPagination;
  /** Keyed by leaf column id. `false` hides; no entry means visible. */
  columnVisibility?: Record<string, boolean>;
  columnPinning?: GridColumnPinning;
  activeCell?: GridCellRef | null;
  editing?: GridEditing | null;
};

export type GridBridgeAdapter = {
  id: string;
  title?: string;
  screenId?: string;
  /** Controlled state — the same object the grid's `onStateChange` emits. */
  getState: () => GridState;
  setState: (next: GridState) => void;
  /**
   * Column ids an agent may address. Supplied so a tool can REJECT an unknown
   * column instead of writing a sort nothing applies — a silently ignored sort
   * looks identical to a grid that simply is not sorted.
   */
  getColumnIds?: () => string[];
  /** Row ids currently on screen, for `grid_select_rows` validation. */
  getRowIds?: () => string[];
  /**
   * Write one cell. Absent when the grid is read-only, in which case
   * `grid_edit_cell` is not registered at all rather than failing at call time
   * — an agent should discover the capability from the tool list.
   */
  editCell?: (rowId: string, columnId: string, value: unknown) => void | Promise<void>;
  /**
   * The refusal `editCell` would give, or `null`, writing nothing. With it,
   * `grid_edit_cell` under `pendingMode` refuses a bad value straight away instead
   * of asking a human to confirm a write that was always going to fail.
   */
  validateCell?: (rowId: string, columnId: string, value: unknown) => string | null;
  /**
   * The grid's leaf columns. Supplying it is how an adapter says its grid
   * understands column visibility and pinning: without it those tools are not
   * registered, because an older grid ignores the slices and a pin nothing applied
   * looks exactly like a grid with nothing pinned. `createGridBridgeAdapter` from
   * `@particle-academy/fancy-grid` supplies it.
   */
  getColumnInfo?: () => GridColumnInfo[];
};

export type GridBridgeOptions = {
  adapter: GridBridgeAdapter;
  agent?: { id: string; name?: string; color?: string };
  /**
   * Gate writes behind a human confirmation. `grid_edit_cell` is the only
   * mutation that changes DATA rather than view state, so it is the one that
   * matters here — sorting a grid is not a trust-but-verify action.
   */
  pendingMode?: boolean;
  onPending?: (staged: { id: string; label: string; apply: () => void | Promise<void> }) => void;
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };

/**
 * registerGridBridge — MCP access to a `fancy-grid` surface.
 *
 * `grid_sort`, `grid_filter`, `grid_select_rows` and `grid_edit_cell`, plus a
 * read tool. View state (sort / filter / selection / page) goes through one
 * `setState` channel because that is how the grid is controlled — a bridge that
 * mutated pieces separately would drift from what the component actually
 * accepts.
 */
export function registerGridBridge(host: ToolHost, options: GridBridgeOptions): Bridge {
  const { adapter } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const disposers: Array<() => void> = [];
  // The bridge id is also its registrant identity on the host: the same bridge
  // may re-register (a remount), a different one claiming a name is refused.
  const bridgeId = `grid:${adapter.id}`;

  ensureUndoToolsRegistered(host, { defaultAgentId: agent.id });

  const target = (part?: string): AgentTarget => ({
    kind: "grid",
    screenId: adapter.screenId,
    elementId: part ? `${adapter.id}:${part}` : adapter.id,
    label: part ? `${adapter.title ?? adapter.id} → ${part}` : (adapter.title ?? adapter.id),
  });

  const reg = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: JsonObject) => Promise<ReturnType<typeof textResult>> | ReturnType<typeof textResult>,
    isMutation: boolean,
    partFromArgs?: (args: JsonObject) => string | undefined,
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
          kind: "grid",
          screenId: adapter.screenId,
          resolveTarget: ({ args }) => target(partFromArgs?.(args)),
        })
      : wrapped;

    disposers.push(
      host.registerTool(
        {
          name,
          description,
          inputSchema: { type: "object", properties: properties as never, required, additionalProperties: false },
        },
        final as never,
        { owner: bridgeId },
      ),
    );
  };

  /** Reject an unknown column rather than writing state nothing applies. */
  const assertColumn = (id: string): void => {
    const known = adapter.getColumnIds?.();
    if (known && !known.includes(id)) {
      throw new Error(`Unknown column "${id}". Available: ${known.join(", ")}`);
    }
  };

  const commit = (next: GridState, action: string, label: string, previous: GridState): void => {
    adapter.setState(next);
    pushUndoEntry(agent.id, {
      timestamp: Date.now(),
      bridgeId: `grid:${adapter.id}`,
      action,
      label,
      undo: () => adapter.setState(previous),
      redo: () => adapter.setState(next),
    });
  };

  // ───────────── Read ─────────────

  reg(
    "grid_get",
    "Read the grid's view state — sorting, filters, selected row ids, pagination — plus the addressable column and row ids.",
    {},
    [],
    () => {
      const state = adapter.getState();
      return textResult(
        JSON.stringify(
          {
            id: adapter.id,
            title: adapter.title,
            sorting: state.sorting ?? [],
            filters: state.filters ?? [],
            selectedRowIds: Object.entries(state.rowSelection ?? {})
              .filter(([, on]) => on)
              .map(([id]) => id),
            pagination: state.pagination,
            columnIds: adapter.getColumnIds?.() ?? null,
            rowIds: adapter.getRowIds?.() ?? null,
            editable: Boolean(adapter.editCell),
            // Only for an adapter that opted in, so every other caller gets the
            // payload it has always had.
            ...(adapter.getColumnInfo
              ? {
                  columns: adapter.getColumnInfo(),
                  columnVisibility: state.columnVisibility ?? {},
                  columnPinning: state.columnPinning ?? {},
                  activeCell: state.activeCell ?? null,
                  // What a person is typing right now, so an agent does not write
                  // over a cell mid-edit without knowing it.
                  editing: state.editing ?? null,
                }
              : {}),
          },
          null,
          2,
        ),
      );
    },
    false,
  );

  // ───────────── View state ─────────────

  reg(
    "grid_sort",
    "Sort the grid. Pass an empty array to clear sorting. Multiple entries sort by each in order.",
    {
      sorting: {
        type: "array",
        description: 'e.g. [{ "id": "createdAt", "desc": true }]',
        items: {
          type: "object",
          properties: { id: { type: "string" }, desc: { type: "boolean" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    ["sorting"],
    (args) => {
      const raw = Array.isArray(args.sorting) ? (args.sorting as GridSort[]) : [];
      const sorting = raw.map((s) => {
        assertColumn(String(s.id));
        return { id: String(s.id), desc: Boolean(s.desc) };
      });

      const previous = adapter.getState();
      commit({ ...previous, sorting }, "grid_sort", `Sorted by ${sorting.map((s) => s.id).join(", ") || "nothing"}`, previous);
      return textResult(`Sorted by ${sorting.map((s) => `${s.id}${s.desc ? " desc" : ""}`).join(", ") || "nothing"}.`);
    },
    true,
    (args) => (Array.isArray(args.sorting) && args.sorting[0] ? String((args.sorting[0] as GridSort).id) : undefined),
  );

  reg(
    "grid_filter",
    "Filter the grid. Pass an empty array to clear all filters.",
    {
      filters: {
        type: "array",
        description: 'e.g. [{ "id": "status", "value": "open" }]',
        items: {
          type: "object",
          properties: { id: { type: "string" }, value: { type: "string" } },
          required: ["id", "value"],
          additionalProperties: false,
        },
      },
    },
    ["filters"],
    (args) => {
      const raw = Array.isArray(args.filters) ? (args.filters as GridFilter[]) : [];
      const filters = raw.map((f) => {
        assertColumn(String(f.id));
        return { id: String(f.id), value: String(f.value) };
      });

      const previous = adapter.getState();
      commit({ ...previous, filters }, "grid_filter", `Filtered ${filters.map((f) => f.id).join(", ") || "cleared"}`, previous);
      return textResult(`Filtering on ${filters.map((f) => `${f.id}=${f.value}`).join(", ") || "nothing"}.`);
    },
    true,
    (args) => (Array.isArray(args.filters) && args.filters[0] ? String((args.filters[0] as GridFilter).id) : undefined),
  );

  reg(
    "grid_select_rows",
    "Replace the grid's row selection with the given row ids. Pass an empty array to clear.",
    { rowIds: { type: "array", items: { type: "string" }, description: "Row ids, per the grid's getRowId." } },
    ["rowIds"],
    (args) => {
      const ids = Array.isArray(args.rowIds) ? args.rowIds.map(String) : [];
      const known = adapter.getRowIds?.();
      if (known) {
        const missing = ids.filter((id) => !known.includes(id));
        if (missing.length) {
          // Selecting a row that is not loaded looks like it worked and shows
          // nothing — worth an error rather than a silent no-op.
          throw new Error(`Row id(s) not on this page: ${missing.join(", ")}`);
        }
      }

      const previous = adapter.getState();
      const rowSelection: Record<string, boolean> = {};
      for (const id of ids) rowSelection[id] = true;

      commit({ ...previous, rowSelection }, "grid_select_rows", `Selected ${ids.length} row${ids.length === 1 ? "" : "s"}`, previous);
      return textResult(`Selected ${ids.length} row${ids.length === 1 ? "" : "s"}.`);
    },
    true,
  );

  // ───────────── Columns ─────────────

  if (adapter.getColumnInfo) {
    reg(
      "grid_set_column_visibility",
      "Choose which columns show. Replaces the whole map: false hides a column, and a column left out shows. Leaf column ids only; a group shows while any of its columns do.",
      {
        columnVisibility: {
          type: "object",
          description: 'e.g. { "internalNotes": false }',
          additionalProperties: { type: "boolean" },
        },
      },
      ["columnVisibility"],
      (args) => {
        const raw = (args.columnVisibility ?? {}) as Record<string, unknown>;
        const columnVisibility: Record<string, boolean> = {};
        for (const [id, shown] of Object.entries(raw)) {
          assertColumn(id);
          columnVisibility[id] = Boolean(shown);
        }

        const previous = adapter.getState();
        const hidden = Object.keys(columnVisibility).filter((id) => !columnVisibility[id]);
        const label = hidden.length ? `Hid ${hidden.join(", ")}` : "Showed every column";
        commit({ ...previous, columnVisibility }, "grid_set_column_visibility", label, previous);
        return textResult(`${label}.`);
      },
      true,
    );

    reg(
      "grid_pin_columns",
      "Stick columns to the left and right edges so they stay in view while the rest scrolls. Replaces all pinning: call with neither list to unpin everything. Leaf column ids only, in display order.",
      {
        left: { type: "array", items: { type: "string" } },
        right: { type: "array", items: { type: "string" } },
      },
      [],
      (args) => {
        const left = Array.isArray(args.left) ? args.left.map(String) : [];
        const right = Array.isArray(args.right) ? args.right.map(String) : [];
        for (const id of [...left, ...right]) assertColumn(id);

        // The grid would quietly keep the left one. An agent asking for both has
        // made a mistake it should hear about.
        const both = left.filter((id) => right.includes(id));
        if (both.length) throw new Error(`Column(s) pinned to both sides: ${both.join(", ")}`);

        const previous = adapter.getState();
        const label = left.length + right.length ? `Pinned ${[...left, ...right].join(", ")}` : "Unpinned every column";
        commit({ ...previous, columnPinning: { left, right } }, "grid_pin_columns", label, previous);
        return textResult(`${label}.`);
      },
      true,
    );
  }

  // ───────────── Data ─────────────

  if (adapter.editCell) {
    reg(
      "grid_edit_cell",
      "Write one cell. This changes DATA, not just the view.",
      {
        rowId: { type: "string" },
        columnId: { type: "string" },
        value: { description: "New value. Any JSON scalar or object the column accepts." },
      },
      ["rowId", "columnId"],
      async (args) => {
        const rowId = String(args.rowId);
        const columnId = String(args.columnId);
        assertColumn(columnId);

        const refusal = adapter.validateCell?.(rowId, columnId, args.value);
        if (refusal) throw new Error(refusal);

        const apply = async () => {
          await adapter.editCell?.(rowId, columnId, args.value);
        };

        if (options.pendingMode) {
          // Trust-but-verify: the only tool here that changes stored data
          // stages instead of writing. Sorting a grid is not a destructive act;
          // editing a cell is.
          const id = `grid-edit-${Date.now().toString(36)}`;
          options.onPending?.({ id, label: `set ${columnId} on row ${rowId}`, apply });
          return textResult(`Staged: set ${columnId} on row ${rowId}. Awaiting confirmation.`);
        }

        await apply();
        return textResult(`Set ${columnId} on row ${rowId}.`);
      },
      true,
      (args) => `${String(args.rowId)}:${String(args.columnId)}`,
    );
  }

  return {
    id: bridgeId,
    title: adapter.title ?? adapter.id,
    dispose: () => {
      for (const d of disposers) d();
      disposers.length = 0;
    },
  };
}
