import { useState, useEffect, useCallback } from "react";
import { readHistory } from "./undo-stack";

/**
 * useUndoStack — minimal React snapshot of an agent's history. Polls every
 * `intervalMs` (default 500). Use this to render an inline "agent timeline"
 * in a sidebar or activity panel. No subscription model in v1 — keeping it
 * simple; bridge mutations are infrequent enough that polling is fine.
 */
export function useUndoStack(agentId: string, intervalMs = 500) {
  const [history, setHistory] = useState(() => readHistory(agentId));

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      setHistory(readHistory(agentId));
    };
    const id = setInterval(tick, intervalMs);
    tick();
    return () => { cancelled = true; clearInterval(id); };
  }, [agentId, intervalMs]);

  const refresh = useCallback(() => setHistory(readHistory(agentId)), [agentId]);
  return { history, refresh };
}
