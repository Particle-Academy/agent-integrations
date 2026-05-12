import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SheetsBridgeAdapter } from "./bridges/sheets";
import {
  onActivity,
  type AgentActivityEvent,
} from "./presence/registry";

/**
 * Shared-session helpers for `@particle-academy/fancy-sheets`.
 *
 * fancy-sheets' `SheetWorkbook` is already controlled (`data` + `onChange`).
 * The two missing pieces for a clean shared-session experience are:
 *
 *   1. an adapter object the host can hand to {@link registerSheetsBridge}
 *      without writing boilerplate, and
 *   2. a derived `CellHighlightMap` so agent edits visibly pulse on the
 *      humans' screens — wired from the presence registry's per-bridge
 *      activity stream.
 *
 * These are kept as host-side hooks (not part of the bridge itself) so
 * agent-integrations keeps zero hard deps on fancy-sheets. The host
 * imports SheetWorkbook directly and feeds these hooks' outputs into
 * its props.
 *
 *   const wb = useSheetsAdapter(initial, { screenId: "deal-sheet" });
 *   const highlights = useSheetsActivityHighlights({ screenId: "deal-sheet" });
 *
 *   useEffect(() => {
 *     const bridge = registerSheetsBridge(host, { adapter: wb.adapter });
 *     return bridge.dispose;
 *   }, [host, wb.adapter]);
 *
 *   <SheetWorkbook
 *     data={wb.workbook}
 *     onChange={wb.setWorkbook}
 *     highlights={highlights}
 *     onActiveCellChange={wb.onActiveCellChange}
 *   />
 */

// Loose type mirror of fancy-sheets' WorkbookData — kept local so this
// helper doesn't pull a runtime dep on the package. Apps using the helper
// import the real `WorkbookData` from fancy-sheets and pass it through.
export type WorkbookLike = {
  sheets: Array<{ id: string; name: string; [k: string]: unknown }>;
  activeSheetId: string;
};

export type SheetsAdapterOptions = {
  /** Tags the bridge's screen id so presence events route correctly. */
  screenId?: string;
};

export type UseSheetsAdapterResult<W extends WorkbookLike> = {
  /** Controlled workbook state. Wire to `<SheetWorkbook data={…} />`. */
  workbook: W;
  /** Setter for the controlled state. Wire to `<SheetWorkbook onChange={…} />`. */
  setWorkbook: (next: W) => void;
  /** Wire to `<SheetWorkbook onActiveCellChange={…} />` to track focus. */
  onActiveCellChange: (address: string) => void;
  /** Stable adapter to hand to `registerSheetsBridge({ adapter })`. */
  adapter: SheetsBridgeAdapter;
  /** Imperative: set the active sheet + cell. Mirrors the adapter's hook. */
  setActiveCell: (sheetId: string, address: string) => void;
  /** Read-only: the address last focused (any source). */
  activeCell: string | null;
};

/**
 * useSheetsAdapter — one-liner glue between fancy-sheets' SheetWorkbook
 * and the sheets bridge.
 *
 *   const wb = useSheetsAdapter(initialWorkbook, { screenId: "..." });
 *
 *   useEffect(() => registerSheetsBridge(host, { adapter: wb.adapter }).dispose,
 *             [host, wb.adapter]);
 *
 *   <SheetWorkbook
 *     data={wb.workbook}
 *     onChange={wb.setWorkbook}
 *     onActiveCellChange={wb.onActiveCellChange}
 *   />
 */
export function useSheetsAdapter<W extends WorkbookLike>(
  initial: W,
  options: SheetsAdapterOptions = {},
): UseSheetsAdapterResult<W> {
  const [workbook, setWorkbook] = useState<W>(initial);
  const [activeCell, setActiveCellState] = useState<string | null>(null);
  const workbookRef = useRef(workbook);
  workbookRef.current = workbook;

  const setActiveCell = useCallback((sheetId: string, address: string) => {
    setWorkbook((cur) => (cur.activeSheetId === sheetId ? cur : { ...cur, activeSheetId: sheetId }));
    setActiveCellState(address);
  }, []);

  const onActiveCellChange = useCallback((address: string) => {
    setActiveCellState(address);
  }, []);

  // Adapter must be stable across renders so the bridge's tool catalog
  // doesn't churn — bind it to refs that hold the latest state + setter.
  const setWorkbookRef = useRef(setWorkbook);
  setWorkbookRef.current = setWorkbook;

  const adapter = useMemo<SheetsBridgeAdapter>(
    () => ({
      screenId: options.screenId,
      getWorkbook: () => workbookRef.current,
      setWorkbook: (next) => setWorkbookRef.current(next as W),
      setActiveCell,
    }),
    [options.screenId, setActiveCell],
  );

  return {
    workbook,
    setWorkbook,
    onActiveCellChange,
    adapter,
    setActiveCell,
    activeCell,
  };
}

/**
 * Loose mirror of fancy-sheets' `CellHighlightMap`. Each key is a cell
 * address (`"B12"`); each value is the visual treatment to apply.
 */
export type SheetsCellHighlight = {
  color?: string;
  /** Background tint; if omitted, derived from `color` at low alpha. */
  background?: string;
  /** Optional label rendered in a chip on the cell. */
  label?: string;
  /** Optional className appended to the cell. */
  className?: string;
};

export type SheetsCellHighlightMap = Record<string, SheetsCellHighlight>;

export type SheetsHighlightOptions = {
  /** Only include events for this screen (recommended). */
  screenId?: string;
  /** Highlight TTL in ms before a hit fades from the map. Default 2200. */
  ttlMs?: number;
};

/**
 * useSheetsActivityHighlights — subscribe to the presence registry,
 * produce a CellHighlightMap reflecting recent sheet-bridge activity.
 *
 * Pass the result straight into `<SheetWorkbook highlights={…} />`. Each
 * agent edit pulses in the agent's color for `ttlMs` then fades out.
 *
 * The bridge's target shape is `${sheetId}!${address}` — this hook
 * filters for the currently-active sheet and exposes only its cells.
 *
 *   const highlights = useSheetsActivityHighlights({ screenId: "deal-sheet" });
 *   <SheetWorkbook highlights={highlights} … />
 */
export function useSheetsActivityHighlights(
  options: SheetsHighlightOptions = {},
): SheetsCellHighlightMap {
  const ttlMs = options.ttlMs ?? 2200;
  const screenId = options.screenId;
  const [, force] = useState(0);
  const hitsRef = useRef<
    Map<string, { event: AgentActivityEvent; expiresAt: number }>
  >(new Map());

  useEffect(() => {
    const off = onActivity((event) => {
      if (event.target?.kind !== "sheet") return;
      if (screenId && event.target.screenId && event.target.screenId !== screenId) return;
      const elementId = event.target.elementId;
      if (!elementId || !elementId.includes("!")) return;
      hitsRef.current.set(elementId, { event, expiresAt: Date.now() + ttlMs });
      force((n) => n + 1);
    });
    return off;
  }, [screenId, ttlMs]);

  // Periodic GC — drop expired entries and force a re-render.
  useEffect(() => {
    const t = window.setInterval(() => {
      const now = Date.now();
      let dirty = false;
      for (const [k, v] of hitsRef.current) {
        if (v.expiresAt < now) {
          hitsRef.current.delete(k);
          dirty = true;
        }
      }
      if (dirty) force((n) => n + 1);
    }, 500);
    return () => window.clearInterval(t);
  }, []);

  return useMemo<SheetsCellHighlightMap>(() => {
    const out: SheetsCellHighlightMap = {};
    for (const [elementId, { event }] of hitsRef.current) {
      const idx = elementId.indexOf("!");
      const address = elementId.slice(idx + 1);
      if (!address) continue;
      const color = event.agent?.color ?? "#a855f7";
      out[address] = {
        color,
        background: color + "33",
        label: event.agent?.name ?? "agent",
      };
    }
    return out;
    // hitsRef is mutated outside React; we re-derive on every render
    // triggered by `force` above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });
}
