/**
 * Presence layer types. These now live in `@particle-academy/fancy-auto-common`
 * as the unified `Auto*` family (shared with fancy-flow's FlowRunnerUx). The
 * historical `Agent*` names are kept here as back-compat aliases so existing
 * consumers (cursors, highlights, fancy-screens presence) don't change.
 */
export type {
  AutoTargetKind as AgentTargetKind,
  AutoTarget as AgentTarget,
  AutoActivityEvent as AgentActivityEvent,
  AutoActivityListener as AgentActivityListener,
  ActivityFilter,
} from "@particle-academy/fancy-auto-common";
