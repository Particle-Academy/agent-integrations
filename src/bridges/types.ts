import type { ToolHost } from "../mcp/tool-host";

/**
 * Bridge — registers a cohesive set of MCP tools/resources for a single
 * fancy-* package or app concern. Each bridge owns its lifecycle: install
 * to register handlers on a server, dispose to remove them.
 */
export type Bridge = {
  /** Stable identifier — surfaces in agent activity logs. */
  id: string;
  /** Human-readable label for UI. */
  title?: string;
  /** Disposes the bridge. Must remove every tool it registered. */
  dispose: () => void;
};

/**
 * Who may confirm a write a bridge staged for confirmation.
 *
 * - `"human"` (the default on every bridge that stages writes): no agent-callable
 *   tool or argument confirms anything. The host confirms, through the returned
 *   bridge's `confirm(id)` or its own `confirm` hook, wired to a control only the
 *   person can use. This is the Human+ contract: agents propose, humans confirm.
 * - `"agent"`: the pre-0.66 behaviour, as an explicit opt-in. The agent that
 *   staged a write can also confirm it, which leaves pendingMode with no human
 *   in it. Use only for a host that has its own confirmation policy upstream.
 */
export type ConfirmBy = "human" | "agent";

export type BridgeFactory<TOptions> = (
  host: ToolHost,
  options: TOptions,
) => Bridge;
