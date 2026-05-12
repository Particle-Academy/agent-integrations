import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import { readHistory, redoOne, undoOne } from "./undo-stack";

export type UndoToolsOptions = {
  /** Default agent id when the caller doesn't pass one. */
  defaultAgentId?: string;
};

/**
 * Idempotent tracker so multiple bridges on the same server only register
 * agent_undo / agent_redo / agent_history once.
 */
const installedHosts = new WeakSet<ToolHost>();

/**
 * ensureUndoToolsRegistered — bridges call this on construction. Safe to
 * call repeatedly with the same server; subsequent calls are no-ops.
 */
export function ensureUndoToolsRegistered(host: ToolHost, options: UndoToolsOptions = {}): void {
  if (installedHosts.has(host)) return;
  installedHosts.add(host);
  registerUndoTools(host, options);
}

/**
 * registerUndoTools — add agent_undo / agent_redo / agent_history to the
 * server. Returns a disposer that unregisters all three.
 */
export function registerUndoTools(host: ToolHost, options: UndoToolsOptions = {}): () => void {
  const defaultAgent = options.defaultAgentId ?? "agent";
  const disposers: Array<() => void> = [];
  const agentOf = (args: any): string =>
    typeof args?.agentId === "string" ? args.agentId : defaultAgent;

  disposers.push(
    host.registerTool(
      {
        name: "agent_undo",
        description: "Undo the most recent action on the agent's stack. Optional agentId targets a specific agent.",
        inputSchema: {
          type: "object",
          properties: { agentId: { type: "string" } },
          additionalProperties: false,
        },
      },
      async (args) => {
        const entry = await undoOne(agentOf(args));
        if (!entry) return errorResult("Nothing to undo.");
        return textResult(`Undid: ${entry.label}`, { entry: serialize(entry) });
      },
    ),
  );

  disposers.push(
    host.registerTool(
      {
        name: "agent_redo",
        description: "Redo the most recently undone action.",
        inputSchema: {
          type: "object",
          properties: { agentId: { type: "string" } },
          additionalProperties: false,
        },
      },
      async (args) => {
        const entry = await redoOne(agentOf(args));
        if (!entry) return errorResult("Nothing to redo.");
        return textResult(`Redid: ${entry.label}`, { entry: serialize(entry) });
      },
    ),
  );

  disposers.push(
    host.registerTool(
      {
        name: "agent_history",
        description: "List the agent's undo stack (oldest first). Useful for understanding what's reversible.",
        inputSchema: {
          type: "object",
          properties: { agentId: { type: "string" } },
          additionalProperties: false,
        },
      },
      async (args) => {
        const history = readHistory(agentOf(args)).map(serialize);
        const text = history.map((e) => `${new Date(e.timestamp).toISOString()} ${e.bridgeId} ${e.action}: ${e.label}`).join("\n");
        return textResult(text || "(empty)", history);
      },
    ),
  );

  return () => disposers.forEach((d) => d());
}

function serialize(entry: import("./undo-stack").UndoEntry) {
  return {
    timestamp: entry.timestamp,
    bridgeId: entry.bridgeId,
    action: entry.action,
    label: entry.label,
  };
}
