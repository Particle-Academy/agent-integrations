import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { CallToolResult, JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import { pushUndoEntry } from "../undo/undo-stack";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";
import { commit, type HostCommitResult } from "./host-commit";
import { joinInstanceRouter, type InstanceRouter } from "./multi-instance";

/**
 * Bridge for react-fancy's `ContentReaction`: emoji reactions on a comment, post
 * or message. An agent reads the reactions and changes them through the host's
 * own controlled state (`value` / `onChange`), never by opening the picker.
 *
 * The adapter is defined HERE, structurally, so this bridge needs no particular
 * react-fancy version: a host wires it to whatever state feeds the component.
 * The toggle rule is the component's `toggleReaction`, restated below so the
 * two agree without an import.
 *
 * Reactions sit on every comment of a page, so several contents share one host
 * (the `form` bridge's model, docs/multi-form-hosts.md): the first registration
 * installs the tools, later ones join, and each tool selects its content with
 * the `content` argument, optional while exactly one is mounted.
 */

/** One reaction the content offers (react-fancy's `ContentReactionItem`). */
export type ContentReactionDescriptor = { key: string; emoji: string; label: string };

export type ContentReactionMode = "multi" | "single";

export type ContentReactionBridgeAdapter = {
  /** Stable id for this content (a comment id). Agents select it by this. */
  id: string;
  title?: string;
  screenId?: string;
  /** Active reaction keys, as the component's `value`. */
  getValue: () => readonly string[];
  /**
   * Apply a new value: the same call the component's `onChange` makes. `meta`
   * is given for a toggle. May return a Promise; resolving to
   * `{ ok: false, error }` refuses the write.
   */
  setValue: (
    next: string[],
    meta?: { key: string; on: boolean },
  ) => void | HostCommitResult | Promise<void | HostCommitResult>;
  /** The reactions offered, as the component's `reactions`. */
  getReactions: () => readonly ContentReactionDescriptor[];
  /** Aggregate counts by key, as the component's `counts`. */
  getCounts?: () => Record<string, number> | undefined;
  /** As the component's `mode`. @default "multi" */
  getMode?: () => ContentReactionMode;
};

export type ContentReactionConfirmRequest = {
  action: "reaction_toggle" | "reaction_set";
  content: string;
  value: string[];
  next: string[];
};

export type ContentReactionBridgeOptions = {
  adapter: ContentReactionBridgeAdapter;
  agent?: { id: string; name?: string; color?: string };
  /**
   * Trust-but-verify. A reaction is posted as the human, so a host may want to
   * see it first. When on, `reaction_toggle` / `reaction_set` ask `confirm`, or
   * without a hook need `confirm: true` on the call. @default false
   */
  pendingMode?: boolean;
  confirm?: (req: ContentReactionConfirmRequest) => boolean | Promise<boolean>;
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };

/** The one registrant every reaction tool is held by (the tools are shared by all contents). */
const TOOLS_OWNER = "content-reaction-bridge";

const CONTENT_ARG = {
  type: "string",
  description:
    "Id of the content whose reactions to use (see reaction_list). Optional while exactly one is mounted; required when several are.",
};

type Handler = (args: JsonObject) => Promise<CallToolResult>;
type Instance = { adapter: ContentReactionBridgeAdapter; handlers: Record<string, Handler> };

type ToolDef = { name: string; description: string; properties: Record<string, unknown>; required: string[] };

const TOOL_DEFS: ToolDef[] = [
  {
    name: "reaction_read",
    description:
      "Read a content's reactions: the active keys (`value`), aggregate `counts` when the host has them, the available `reactions` ({ key, emoji, label }) and the `mode` (multi or single).",
    properties: {},
    required: [],
  },
  {
    name: "reaction_toggle",
    description:
      "Toggle one reaction by key. In multi mode it turns that key on or off and leaves the others; in single mode choosing a key replaces the active one, and choosing the active one clears it.",
    properties: {
      key: { type: "string", description: "Reaction key (see reaction_read)." },
      confirm: { type: "boolean", description: "Apply a write staged by pendingMode." },
    },
    required: ["key"],
  },
  {
    name: "reaction_set",
    description:
      "Replace the active reactions with `value`, an array of reaction keys. [] clears them. Single mode accepts at most one key.",
    properties: {
      value: { type: "array", items: { type: "string" } },
      confirm: { type: "boolean", description: "Apply a write staged by pendingMode." },
    },
    required: ["value"],
  },
];

/** react-fancy's `toggleReaction`, restated so the bridge needs no react-fancy. */
function toggle(value: readonly string[], key: string, mode: ContentReactionMode): { next: string[]; on: boolean } {
  const active = value.includes(key);
  if (mode === "single") return active ? { next: [], on: false } : { next: [key], on: true };
  return active ? { next: value.filter((k) => k !== key), on: false } : { next: [...value, key], on: true };
}

const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((k, i) => k === b[i]);

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function installTools(host: ToolHost, router: InstanceRouter<Instance>): () => void {
  const disposers: Array<() => void> = [];
  try {
    for (const def of TOOL_DEFS) {
      disposers.push(
        host.registerTool(
          {
            name: def.name,
            description: def.description,
            inputSchema: {
              type: "object",
              properties: { content: CONTENT_ARG, ...def.properties } as never,
              required: def.required,
              additionalProperties: false,
            },
          },
          async (args) => {
            const target = router.resolve(args?.content);
            if (!target.ok) return errorResult(target.error);
            return target.instance.handlers[def.name](args ?? {});
          },
          { owner: TOOLS_OWNER },
        ),
      );
    }
    disposers.push(
      host.registerTool(
        {
          name: "reaction_list",
          description:
            "List the contents with reactions mounted on this host: id, title, screen and active keys. Pass an id as `content` to the other reaction tools when more than one is mounted.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        () => {
          try {
            const contents = router.entries().map(([id, { adapter }]) => ({
              id,
              title: adapter.title,
              screenId: adapter.screenId,
              value: [...adapter.getValue()],
            }));
            const text = contents
              .map((c) => `${c.id}${c.title ? ` (${c.title})` : ""}: ${c.value.join(", ") || "no reactions"}`)
              .join("\n");
            return textResult(text || "(no contents)", { contents });
          } catch (e) {
            return errorResult(message(e));
          }
        },
        { owner: TOOLS_OWNER },
      ),
    );
  } catch (e) {
    for (const d of disposers) d();
    throw e;
  }
  return () => {
    for (const d of disposers) d();
  };
}

/**
 * registerContentReactionBridge: MCP access to the reactions on a piece of content.
 *
 *   reaction_list     the contents mounted on this host
 *   reaction_read     value, counts, available reactions, mode
 *   reaction_toggle   toggle one key (the component's rule, per mode)
 *   reaction_set      replace the value
 *
 * Writes broadcast an AgentActivity event (kind `"reaction"`, element = the
 * content id) and push an undo entry. A refused or declined write does neither.
 * `dispose()` removes only this content; the tools go with the last one.
 */
export function registerContentReactionBridge(host: ToolHost, options: ContentReactionBridgeOptions): Bridge {
  const { adapter } = options;
  const contentId = adapter?.id == null ? "" : String(adapter.id);
  if (contentId.trim() === "") {
    throw new Error("registerContentReactionBridge needs adapter.id: agents select the content by it.");
  }
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const pendingMode = options.pendingMode ?? false;
  const bridgeId = `content-reaction:${contentId}`;
  const label = adapter.title ?? contentId;

  ensureUndoToolsRegistered(host, { defaultAgentId: agent.id });

  const mode = (): ContentReactionMode => (adapter.getMode?.() === "single" ? "single" : "multi");
  const keys = () => adapter.getReactions().map((r) => r.key);

  const guard = async (action: ContentReactionConfirmRequest["action"], value: string[], next: string[], confirmed: boolean) => {
    if (!pendingMode) return null;
    if (options.confirm) {
      const ok = await options.confirm({ action, content: contentId, value, next });
      return ok ? null : errorResult(`Declined: ${action} on "${contentId}" (the human did not confirm). Nothing changed.`);
    }
    if (!confirmed) {
      return errorResult(`${action} is staged (pendingMode). Re-call with confirm:true to apply, or wire a host confirm hook.`);
    }
    return null;
  };

  /** Commit `next`, record undo, and report. The caller has already validated. */
  const write = async (
    action: ContentReactionConfirmRequest["action"],
    previous: string[],
    next: string[],
    meta: { key: string; on: boolean } | undefined,
    confirmed: boolean,
  ): Promise<CallToolResult | null> => {
    const blocked = await guard(action, previous, next, confirmed);
    if (blocked) return blocked;
    const outcome = await commit(() => adapter.setValue(next, meta), `${action} failed.`);
    if (!outcome.ok) return errorResult(outcome.error);
    pushUndoEntry(agent.id, {
      timestamp: Date.now(),
      bridgeId,
      action,
      label: meta ? `${meta.on ? "Reacted" : "Removed reaction"} ${meta.key} on ${label}` : `Set reactions on ${label}`,
      undo: async () => {
        await adapter.setValue(previous);
      },
      redo: async () => {
        await adapter.setValue(next, meta);
      },
    });
    return null;
  };

  const raw: Record<string, Handler> = {
    reaction_read: async () => {
      const value = [...adapter.getValue()];
      const counts = adapter.getCounts?.();
      const out = {
        content: contentId,
        title: adapter.title,
        mode: mode(),
        value,
        ...(counts ? { counts } : {}),
        reactions: adapter.getReactions().map((r) => ({ key: r.key, emoji: r.emoji, label: r.label })),
      };
      return textResult(JSON.stringify(out, null, 2), out);
    },

    reaction_toggle: async (args) => {
      const key = typeof args.key === "string" ? args.key : "";
      const available = keys();
      if (!available.includes(key)) {
        return errorResult(`No reaction "${key}" on "${contentId}". Available: ${available.join(", ")}.`);
      }
      const previous = [...adapter.getValue()];
      const { next, on } = toggle(previous, key, mode());
      const failed = await write("reaction_toggle", previous, next, { key, on }, args.confirm === true);
      if (failed) return failed;
      const out = { content: contentId, key, on, value: next, previous };
      return textResult(`${on ? "Reacted" : "Removed reaction"} ${key} on ${label}.`, out);
    },

    reaction_set: async (args) => {
      if (!Array.isArray(args.value) || !args.value.every((k) => typeof k === "string")) {
        return errorResult("value must be an array of reaction keys.");
      }
      const requested = [...new Set(args.value as string[])];
      const available = keys();
      const unknown = requested.filter((k) => !available.includes(k));
      if (unknown.length > 0) {
        return errorResult(`Unknown reaction ${unknown.map((k) => `"${k}"`).join(", ")} on "${contentId}". Available: ${available.join(", ")}.`);
      }
      if (mode() === "single" && requested.length > 1) {
        return errorResult(`"${contentId}" is in single mode: pass at most one reaction key.`);
      }
      const previous = [...adapter.getValue()];
      if (sameKeys(previous, requested)) {
        const out = { content: contentId, value: previous, previous, changed: false };
        return textResult(`Reactions on ${label} are already ${previous.join(", ") || "empty"}.`, out);
      }
      const failed = await write("reaction_set", previous, requested, undefined, args.confirm === true);
      if (failed) return failed;
      const out = { content: contentId, value: requested, previous, changed: true };
      return textResult(`Set reactions on ${label} to ${requested.join(", ") || "none"}.`, out);
    },
  };

  const handlers: Record<string, Handler> = {};
  for (const [name, handler] of Object.entries(raw)) {
    const safe: Handler = async (args) => {
      try {
        return await handler(args);
      } catch (e) {
        return errorResult(message(e));
      }
    };
    handlers[name] =
      name === "reaction_read"
        ? safe
        : (wrapToolWithActivity(safe as never, {
            toolName: name,
            agent,
            kind: "reaction",
            screenId: adapter.screenId,
            // A write that changed nothing is not activity.
            resolveTarget: ({ result }) =>
              (result.structuredContent as { changed?: boolean } | undefined)?.changed === false
                ? null
                : { kind: "reaction", screenId: adapter.screenId, elementId: contentId, label },
          }) as Handler);
  }

  const membership = joinInstanceRouter<Instance>(
    host,
    {
      family: "content",
      argument: "content",
      listTool: "reaction_list",
      install: (router) => installTools(host, router),
    },
    contentId,
    { adapter, handlers },
  );

  return {
    id: bridgeId,
    title: label,
    dispose: () => membership.leave(),
  };
}
