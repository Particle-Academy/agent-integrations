/**
 * In-process registry of activity events. Now backed by the shared bus in
 * `@particle-academy/fancy-auto-common`, so agent activity (here) and flow
 * activity (fancy-flow's FlowRunnerUx) land in ONE stream — presence layers
 * render both. Re-exported under the same names for back-compat.
 */
export {
  emitActivity,
  onActivity,
  readActivityHistory,
  resetActivityRegistry,
} from "@particle-academy/fancy-auto-common";
