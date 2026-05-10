/**
 * Presence layer types — describe what the agent is doing right now and
 * where. Every bridge tool emits one of these when it runs; the registry
 * fans them out to in-process subscribers + the SSE relay so external
 * clients can render presence indicators across the whole app.
 */

export type AgentTargetKind =
  | "whiteboard"
  | "flow"
  | "form"
  | "sheet"
  | "code"
  | "chart"
  | "scene"
  | "custom";

export type AgentTarget = {
  /** Which package surface the action affects. */
  kind: AgentTargetKind | string;
  /** Optional fancy-screens screen id, for screen-scoped UIs. */
  screenId?: string;
  /** Optional element id within the surface (sticky id, node id, field name, …). */
  elementId?: string;
  /** Free-form label the host can render (e.g. "the 'email' field"). */
  label?: string;
};

export type AgentActivity = {
  /** Stable identifier for the acting agent. */
  agentId: string;
  /** Human-friendly name (used by indicators / activity log). */
  agentName?: string;
  /** Color for cursor / highlight CSS. */
  agentColor?: string;
  /** What the agent is touching. */
  target: AgentTarget;
  /** Snake-case action verb mirroring the tool name (e.g. "whiteboard_add_sticky"). */
  action: string;
  /** Wall-clock ms — when the action ran. */
  timestamp: number;
  /** Optional small structured payload describing the action's effect. */
  meta?: Record<string, unknown>;
  /** Optional duration in ms — how long the activity should "stick" on the
   *  UI before fading. Default 1500. */
  ttlMs?: number;
};

export type AgentActivityListener = (event: AgentActivity) => void;

export type ActivityFilter = {
  agentId?: string;
  screenId?: string;
  kind?: string;
};
