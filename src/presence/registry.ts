import type { ActivityFilter, AgentActivity, AgentActivityListener } from "./types";

/**
 * In-process registry of agent activity events. Bridges call `emitActivity`
 * after a tool runs; React hooks + the SSE relay subscribe via
 * `onActivity()`.
 *
 * Holds a short scrollback of recent events (default 200) so newly-mounted
 * subscribers can render the recent past — useful for activity-log UIs
 * that rejoin a session mid-stream.
 */

const HISTORY_CAP = 200;

const listeners = new Set<AgentActivityListener>();
const history: AgentActivity[] = [];

/** Emit an activity event. All current listeners receive it synchronously. */
export function emitActivity(event: AgentActivity): void {
  history.push(event);
  if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP);
  for (const l of listeners) l(event);
}

/**
 * Subscribe to all events (or a filtered subset). Returns an unsubscribe
 * function. Filter checks all provided keys with strict equality; omit a
 * key to ignore it.
 */
export function onActivity(listener: AgentActivityListener, filter?: ActivityFilter): () => void {
  const wrapped: AgentActivityListener = filter
    ? (e) => { if (matches(e, filter)) listener(e); }
    : listener;
  listeners.add(wrapped);
  return () => listeners.delete(wrapped);
}

/** Read the recent history (newest last). Optional filter. */
export function readActivityHistory(filter?: ActivityFilter): AgentActivity[] {
  if (!filter) return history.slice();
  return history.filter((e) => matches(e, filter));
}

/** Wipe history + clear listeners. Test/teardown helper. */
export function resetActivityRegistry(): void {
  listeners.clear();
  history.length = 0;
}

function matches(e: AgentActivity, f: ActivityFilter): boolean {
  if (f.agentId !== undefined && e.agentId !== f.agentId) return false;
  if (f.screenId !== undefined && e.target.screenId !== f.screenId) return false;
  if (f.kind !== undefined && e.target.kind !== f.kind) return false;
  return true;
}
