import type { CallToolResult } from "../mcp/types";
import { emitActivity } from "./registry";
import type { AgentTarget } from "./types";

export type ActivityAgent = { id: string; name?: string; color?: string };

export type ActivityResolverContext<TArgs = Record<string, unknown>> = {
  /** Tool name as registered. */
  toolName: string;
  /** Arguments the tool was called with. */
  args: TArgs;
  /** The CallToolResult the underlying handler produced. */
  result: CallToolResult;
};

/**
 * Resolves an `AgentTarget` for an executed tool. Bridges declare one of
 * these per registration so the wrapper knows which surface / element /
 * screen the activity belongs to.
 *
 * The resolver runs AFTER the tool handler so it can inspect the result
 * (e.g. read a newly-created item id from `structuredContent`).
 */
export type ActivityTargetResolver<TArgs = Record<string, unknown>> = (
  ctx: ActivityResolverContext<TArgs>,
) => AgentTarget | null;

export type ToolHandler<TArgs = Record<string, unknown>> = (
  args: TArgs,
) => Promise<CallToolResult> | CallToolResult;

/**
 * wrapToolWithActivity — decorate a bridge tool handler so every successful
 * call emits an `AgentActivityEvent`. Returns a new handler with the same shape.
 *
 * Usage in a bridge:
 *
 *   server.registerTool(
 *     definition,
 *     wrapToolWithActivity(
 *       handler,
 *       { agent, kind: "whiteboard", resolveTarget: ({ args }) => ({
 *           kind: "whiteboard", elementId: args.id as string,
 *         }) },
 *     ),
 *   );
 */
export function wrapToolWithActivity<TArgs = Record<string, unknown>>(
  handler: ToolHandler<TArgs>,
  options: {
    toolName: string;
    agent: ActivityAgent;
    /** Optional fancy-screens screen id this bridge is scoped to. */
    screenId?: string;
    /** Default target kind if the resolver returns one without `kind`. */
    kind: AgentTarget["kind"];
    /** Per-call resolver. Return `null` to skip emitting (e.g. for read-only tools). */
    resolveTarget?: ActivityTargetResolver<TArgs>;
    /** Optional ttl override. */
    ttlMs?: number;
    /**
     * Build the `meta` broadcast to all relay peers. Defaults to the tool's full
     * `structuredContent`. Override to REDACT sensitive fields before fan-out —
     * e.g. the terminal bridge strips raw command/keystroke bytes so a command
     * line (or its secrets) is never broadcast verbatim to every peer.
     */
    buildMeta?: (result: CallToolResult) => Record<string, unknown> | undefined;
  },
): ToolHandler<TArgs> {
  return async (args) => {
    const result = await handler(args);
    if (result.isError) return result;

    let target: AgentTarget | null;
    if (options.resolveTarget) {
      target = options.resolveTarget({ toolName: options.toolName, args, result });
    } else {
      target = { kind: options.kind, screenId: options.screenId };
    }
    if (!target) return result;

    emitActivity({
      agentId: options.agent.id,
      agentName: options.agent.name,
      agentColor: options.agent.color,
      target: { ...target, kind: target.kind ?? options.kind, screenId: target.screenId ?? options.screenId },
      action: options.toolName,
      timestamp: Date.now(),
      meta: options.buildMeta ? options.buildMeta(result) : extractMeta(result),
      ttlMs: options.ttlMs,
    });
    return result;
  };
}

function extractMeta(result: CallToolResult): Record<string, unknown> | undefined {
  const sc = result.structuredContent;
  if (sc && typeof sc === "object" && !Array.isArray(sc)) {
    return sc as Record<string, unknown>;
  }
  return undefined;
}
