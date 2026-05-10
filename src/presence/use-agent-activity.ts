import { useEffect, useState } from "react";
import { onActivity, readActivityHistory } from "./registry";
import type { ActivityFilter, AgentActivity } from "./types";

/**
 * useAgentActivity — React subscription to the in-process activity stream.
 *
 * Returns:
 *   - `events`: capped scrollback of recent events matching the filter
 *   - `latest`: the most recent event (handy for transient highlights)
 */
export function useAgentActivity(
  filter?: ActivityFilter,
  options: { capacity?: number } = {},
): { events: AgentActivity[]; latest: AgentActivity | null } {
  const cap = options.capacity ?? 50;
  const [events, setEvents] = useState<AgentActivity[]>(() => readActivityHistory(filter).slice(-cap));

  useEffect(() => {
    setEvents(readActivityHistory(filter).slice(-cap));
    return onActivity((event) => {
      setEvents((prev) => {
        const next = prev.length >= cap ? prev.slice(prev.length - cap + 1) : prev.slice();
        next.push(event);
        return next;
      });
    }, filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter?.agentId, filter?.screenId, filter?.kind, cap]);

  return { events, latest: events.length > 0 ? events[events.length - 1] : null };
}

/**
 * useAgentActivityForScreen — convenience wrapper that filters by screen id.
 * Drives "agent is here" badges in fancy-screens-based shells.
 */
export function useAgentActivityForScreen(
  screenId: string,
  options: { capacity?: number } = {},
): { events: AgentActivity[]; latest: AgentActivity | null; isAgentActive: boolean } {
  const { events, latest } = useAgentActivity({ screenId }, options);
  const fadeAfter = latest?.ttlMs ?? 1500;
  const [isAgentActive, setActive] = useState(false);

  useEffect(() => {
    if (!latest) {
      setActive(false);
      return;
    }
    setActive(true);
    const timer = setTimeout(() => setActive(false), fadeAfter);
    return () => clearTimeout(timer);
  }, [latest, fadeAfter]);

  return { events, latest, isAgentActive };
}
