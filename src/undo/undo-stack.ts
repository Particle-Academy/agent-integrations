/**
 * Per-actor undo/redo stack. Now backed by the shared implementation in
 * `@particle-academy/fancy-auto-common` (keyed by actor id — an agent id or a
 * flow-run id), re-exported under the same names for back-compat.
 */
export {
  pushUndoEntry,
  undoOne,
  redoOne,
  readHistory,
  clearStack,
  resetAllUndoStacks,
  type UndoEntry,
} from "@particle-academy/fancy-auto-common";
