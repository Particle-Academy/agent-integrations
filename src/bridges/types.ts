import type { MicroMcpServer } from "../mcp/server";

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

export type BridgeFactory<TOptions> = (
  server: MicroMcpServer,
  options: TOptions,
) => Bridge;
