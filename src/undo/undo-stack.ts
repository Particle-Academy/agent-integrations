/**
 * Generic undo/redo stack keyed by `agentId`. Each entry holds:
 *  - `do` — re-applies the action (for redo)
 *  - `undo` — reverses it
 *  - `label` — human-readable summary surfaced in agent_history
 *
 * Bridges register entries by calling `pushUndoEntry` after a successful
 * mutation. The corresponding MCP tools (`agent_undo`, `agent_redo`,
 * `agent_history`) are registered once per server via `registerUndoTools`.
 *
 * Stacks are per-agent so multiple agents can rewind independently.
 */

export type UndoEntry = {
  /** Wall-clock ms. */
  timestamp: number;
  /** Bridge id (e.g. "whiteboard", "form:signup"). */
  bridgeId: string;
  /** Tool name that produced the entry. */
  action: string;
  /** Short human label, e.g. `Added sticky n_abc`. */
  label: string;
  /** Reverse the action. */
  undo: () => void | Promise<void>;
  /** Re-apply the action (used when redoing after an undo). */
  redo: () => void | Promise<void>;
};

type Stack = { past: UndoEntry[]; future: UndoEntry[] };

const stacks = new Map<string, Stack>();
const CAP = 200;

function getStack(agentId: string): Stack {
  let s = stacks.get(agentId);
  if (!s) {
    s = { past: [], future: [] };
    stacks.set(agentId, s);
  }
  return s;
}

/** Push a new undo entry on the agent's stack. Clears the redo (future) stack. */
export function pushUndoEntry(agentId: string, entry: UndoEntry): void {
  const s = getStack(agentId);
  s.past.push(entry);
  if (s.past.length > CAP) s.past.splice(0, s.past.length - CAP);
  s.future.length = 0;
}

/** Pop and undo the most recent entry. Returns the entry that ran, or null. */
export async function undoOne(agentId: string): Promise<UndoEntry | null> {
  const s = getStack(agentId);
  const entry = s.past.pop();
  if (!entry) return null;
  await entry.undo();
  s.future.push(entry);
  return entry;
}

/** Re-apply the most recently undone entry. Returns it, or null if no future. */
export async function redoOne(agentId: string): Promise<UndoEntry | null> {
  const s = getStack(agentId);
  const entry = s.future.pop();
  if (!entry) return null;
  await entry.redo();
  s.past.push(entry);
  return entry;
}

/** Read the past stack (oldest first). */
export function readHistory(agentId: string): UndoEntry[] {
  return getStack(agentId).past.slice();
}

/** Wipe an agent's stacks. */
export function clearStack(agentId: string): void {
  stacks.delete(agentId);
}

/** Test/teardown helper. */
export function resetAllUndoStacks(): void {
  stacks.clear();
}
