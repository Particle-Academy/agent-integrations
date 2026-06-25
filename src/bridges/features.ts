import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import type { AgentTarget } from "../presence/types";
import { pushUndoEntry } from "../undo/undo-stack";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";

/**
 * Headless bridge for `@particle-academy/fancy-features` — feature management
 * with NO UI surface. The adapter is the `FeatureManager` (a `FeatureSource`
 * consumer): define features in the registry, check access for a subject,
 * grant/revoke via group assignment, and meter resource usage. Mutations
 * funnel through `wrapToolWithActivity` so presence + undo compose; `grant` /
 * `revoke` are `pendingMode`-gated (they change what a real user can do).
 *
 * The adapter shapes mirror fancy-features' public `FeatureManager` +
 * `FeatureRegistry` + `GroupStore`, defined LOCALLY so the bridge builds with
 * the sibling absent (optional peer). A live `FeatureManager` (plus its
 * `.registry` / `.groupStore`) satisfies this structurally with no import.
 *
 * SUBJECTS over the wire: `Subject` is opaque (`unknown`) in fancy-features.
 * Agents pass a JSON-serializable subject (string id or `{ id, … }` object);
 * the host's stores key on it via their `defaultSubjectKey`.
 */

export type FeatureGrant = {
  key: string;
  type: "boolean" | "resource";
  enabled: boolean;
  includedQuantity?: number | null;
  overageLimit?: number | null;
  source?: string;
  config?: Record<string, unknown>;
};

/** Normalized feature definition (mirror of fancy-features `FeatureDefinition`). */
export type FeatureDefinition = {
  key?: string;
  name?: string;
  description?: string;
  type?: "boolean" | "resource";
  enabled?: boolean;
  limit?: number;
  [k: string]: unknown;
};

/**
 * Adapter = the `FeatureManager` + its registry + group store. The bridge only
 * needs these members; a real manager exposes them directly.
 */
export type FeaturesBridgeAdapter = {
  /** Stable id for this feature manager instance. */
  id?: string;
  title?: string;
  screenId?: string;

  // ── Access checks (FeatureManager) ──
  /** Can the subject access the feature now? `manager.canAccess`. */
  canAccess(feature: string, subject?: unknown, context?: unknown): boolean | Promise<boolean>;
  /** Remaining quota for a resource feature (null = unlimited / n-a). `manager.remaining`. */
  remaining(feature: string, subject?: unknown, context?: unknown): number | null | Promise<number | null>;
  /** All enabled feature keys for the subject. `manager.enabled`. */
  enabled(subject?: unknown, context?: unknown): string[] | Promise<string[]>;
  /** Trace a feature's resolution to an AccessResult. `manager.explain`. */
  explain?(feature: string, subject?: unknown, context?: unknown): Promise<unknown> | unknown;

  // ── Registry (define) ──
  /** Register a programmatic feature. `manager.registerFeature` / `manager.registry.register`. */
  registerFeature(key: string, definition: FeatureDefinition): void;
  /** Registered feature keys. `manager.registry.keys`. */
  registryKeys(): string[];
  /** Resolve a registered definition (or null). `manager.registry.definition`. */
  definition?(key: string): FeatureDefinition | null | Promise<FeatureDefinition | null>;

  // ── Group store (grant / revoke) ──
  /** Assign a subject to a feature group (the grant primitive). `manager.groupStore.assign`. */
  assignGroup(subject: unknown, groupKey: string): void | Promise<void>;
  /** Detach a subject from a group (the revoke primitive). `manager.groupStore.detach`. */
  detachGroup(subject: unknown, groupKey: string): void | Promise<void>;
  /** Group keys assigned to a subject. `manager.groupStore.list`. */
  listGroups(subject: unknown): string[] | Promise<string[]>;

  // ── Usage / metering (resource features) ──
  /** Current usage for a resource feature. `manager.usageFor`. Optional. */
  usageFor?(feature: string, subject: unknown): number | Promise<number>;
  /** Atomic check-and-increment quota. `manager.tryConsume`. Optional. */
  tryConsume?(feature: string, subject: unknown, amount?: number, context?: unknown): boolean | Promise<boolean>;
};

export type FeaturesBridgeOptions = {
  adapter: FeaturesBridgeAdapter;
  agent?: { id: string; name?: string; color?: string };
  /**
   * Trust-but-verify. When on (default), `features_grant` / `features_revoke`
   * (they change a real subject's entitlements) require `confirm:true` OR a
   * host `confirm` hook. Checks + define + usage are unaffected.
   */
  pendingMode?: boolean;
  confirm?: (req: { action: string; subject: unknown; groupKey: string }) => Promise<boolean> | boolean;
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/**
 * registerFeaturesBridge — full MCP tool set over a headless feature manager.
 *
 *   features_list      enabled feature keys for a subject
 *   features_check     can a subject access a feature? (+ remaining for resources)
 *   features_explain   trace why a feature is on/off for a subject
 *   features_define    register a feature definition (boolean / resource)
 *   features_grant     assign a subject to a group (pendingMode-gated, undoable)
 *   features_revoke    detach a subject from a group (pendingMode-gated, undoable)
 *   features_groups    list a subject's assigned groups
 *   features_consume   meter a resource feature (atomic check-and-increment)
 */
export function registerFeaturesBridge(host: ToolHost, options: FeaturesBridgeOptions): Bridge {
  const { adapter } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const pendingMode = options.pendingMode ?? true;
  const featuresId = adapter.id ?? "features";
  const disposers: Array<() => void> = [];

  ensureUndoToolsRegistered(host, { defaultAgentId: agent.id });

  const target = (elementId?: string, label?: string): AgentTarget => ({
    kind: "custom",
    screenId: adapter.screenId,
    elementId,
    label: label ?? featuresId,
  });

  const reg = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: JsonObject) => Promise<unknown> | unknown,
    resolveTarget: false | ((args: JsonObject) => AgentTarget),
  ) => {
    const wrapped = async (args: JsonObject) => {
      try {
        return await handler(args);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    };
    const final = resolveTarget
      ? wrapToolWithActivity(wrapped as never, {
          toolName: name,
          agent,
          kind: "custom",
          screenId: adapter.screenId,
          resolveTarget: ({ args }) => resolveTarget(args as JsonObject),
        })
      : wrapped;
    disposers.push(
      host.registerTool(
        { name, description, inputSchema: { type: "object", properties: properties as Record<string, never>, required, additionalProperties: false } },
        final as never,
      ),
    );
  };

  const guardGrant = async (action: string, subject: unknown, groupKey: string, hasConfirmArg: boolean) => {
    if (!pendingMode) return null;
    if (options.confirm) {
      const ok = await options.confirm({ action, subject, groupKey });
      return ok ? null : errorResult(`Declined: ${action} ${groupKey} (human did not confirm).`);
    }
    if (!hasConfirmArg) {
      return errorResult(`${action} is staged (pendingMode). Re-call with confirm:true to apply, or wire a host confirm hook.`);
    }
    return null;
  };

  // ─── Read / check tools ──────────────────────────────────────────────────

  reg(
    "features_list",
    "List the feature keys enabled for a subject. Pass `subject` (a string id or object).",
    { subject: { description: "Opaque subject — string id or { id, … } object." }, context: { description: "Optional resolution context." } },
    [],
    async (args) => {
      const keys = await adapter.enabled(args.subject, args.context);
      return textResult(JSON.stringify(keys, null, 2), { subject: args.subject, enabled: keys });
    },
    false,
  );

  reg(
    "features_check",
    "Check whether a subject can access a feature. For resource features also returns the remaining quota.",
    { feature: { type: "string" }, subject: { description: "Opaque subject." }, context: { description: "Optional context." } },
    ["feature"],
    async (args) => {
      const feature = str(args.feature);
      const allowed = await adapter.canAccess(feature, args.subject, args.context);
      const remaining = await adapter.remaining(feature, args.subject, args.context);
      const out = { feature, allowed, remaining };
      return textResult(JSON.stringify(out), out);
    },
    false,
  );

  reg(
    "features_explain",
    "Trace why a feature is on/off for a subject — returns the AccessResult (source, remaining, limit, used).",
    { feature: { type: "string" }, subject: { description: "Opaque subject." }, context: { description: "Optional context." } },
    ["feature"],
    async (args) => {
      if (!adapter.explain) return errorResult("Host did not wire explain().");
      const result = await adapter.explain(str(args.feature), args.subject, args.context);
      return textResult(JSON.stringify(result, null, 2), result as Record<string, unknown>);
    },
    false,
  );

  reg(
    "features_groups",
    "List the feature groups a subject is assigned to.",
    { subject: { description: "Opaque subject." } },
    ["subject"],
    async (args) => {
      const groups = await adapter.listGroups(args.subject);
      return textResult(JSON.stringify(groups, null, 2), { subject: args.subject, groups });
    },
    false,
  );

  // ─── Define ──────────────────────────────────────────────────────────────

  reg(
    "features_define",
    "Register a feature definition. type 'boolean' (on/off) or 'resource' (metered with a `limit`). `enabled` sets the default gate.",
    {
      key: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      type: { type: "string", enum: ["boolean", "resource"] },
      enabled: { type: "boolean" },
      limit: { type: "number", description: "Resource quota per period (resource type)." },
    },
    ["key"],
    (args) => {
      const key = str(args.key);
      if (!key) return errorResult("key is required.");
      const existed = adapter.registryKeys().includes(key);
      const definition: FeatureDefinition = {
        ...(args.name !== undefined ? { name: str(args.name) } : {}),
        ...(args.description !== undefined ? { description: str(args.description) } : {}),
        ...(args.type !== undefined ? { type: str(args.type) as "boolean" | "resource" } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled === true } : {}),
        ...(args.limit !== undefined ? { limit: num(args.limit) } : {}),
      };
      adapter.registerFeature(key, definition);
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: featuresId,
        action: "features_define",
        // Registry has no unregister; undo re-registers the prior definition when we had one.
        label: existed ? `Redefined feature ${key}` : `Defined feature ${key}`,
        undo: () => {},
        redo: () => adapter.registerFeature(key, definition),
      });
      return textResult(`${existed ? "Redefined" : "Defined"} feature ${key} (${definition.type ?? "boolean"})`, { key, definition });
    },
    (args) => target(str(args.key), `define ${str(args.key)}`),
  );

  // ─── Grant / revoke (pendingMode-gated) ──────────────────────────────────

  reg(
    "features_grant",
    "Grant a subject access by assigning it to a feature group. Staged in pendingMode — pass confirm:true or wire a host confirm hook.",
    { subject: { description: "Opaque subject." }, group: { type: "string", description: "Feature group key." }, confirm: { type: "boolean" } },
    ["subject", "group"],
    async (args) => {
      const groupKey = str(args.group);
      if (!groupKey) return errorResult("group is required.");
      const blocked = await guardGrant("features_grant", args.subject, groupKey, args.confirm === true);
      if (blocked) return blocked;
      const already = (await adapter.listGroups(args.subject)).includes(groupKey);
      await adapter.assignGroup(args.subject, groupKey);
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: featuresId,
        action: "features_grant",
        label: `Granted group ${groupKey}`,
        // Only reverse if WE added it (idempotent assign — don't revoke a pre-existing grant).
        undo: () => { if (!already) void adapter.detachGroup(args.subject, groupKey); },
        redo: () => void adapter.assignGroup(args.subject, groupKey),
      });
      return textResult(`Granted group ${groupKey}`, { subject: args.subject, group: groupKey });
    },
    (args) => target(str(args.group), `grant ${str(args.group)}`),
  );

  reg(
    "features_revoke",
    "Revoke access by detaching a subject from a feature group. Staged in pendingMode — pass confirm:true or wire a host confirm hook.",
    { subject: { description: "Opaque subject." }, group: { type: "string" }, confirm: { type: "boolean" } },
    ["subject", "group"],
    async (args) => {
      const groupKey = str(args.group);
      if (!groupKey) return errorResult("group is required.");
      const blocked = await guardGrant("features_revoke", args.subject, groupKey, args.confirm === true);
      if (blocked) return blocked;
      const had = (await adapter.listGroups(args.subject)).includes(groupKey);
      await adapter.detachGroup(args.subject, groupKey);
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: featuresId,
        action: "features_revoke",
        label: `Revoked group ${groupKey}`,
        undo: () => { if (had) void adapter.assignGroup(args.subject, groupKey); },
        redo: () => void adapter.detachGroup(args.subject, groupKey),
      });
      return textResult(`Revoked group ${groupKey}`, { subject: args.subject, group: groupKey });
    },
    (args) => target(str(args.group), `revoke ${str(args.group)}`),
  );

  // ─── Usage / metering ────────────────────────────────────────────────────

  reg(
    "features_consume",
    "Meter a resource feature: atomic check-and-increment. Returns ok:false if the quota would be exceeded (nothing recorded).",
    { feature: { type: "string" }, subject: { description: "Opaque subject." }, amount: { type: "number", description: "Units to consume. Default 1." }, context: { description: "Optional context." } },
    ["feature", "subject"],
    async (args) => {
      if (!adapter.tryConsume) return errorResult("Host did not wire usage metering (tryConsume).");
      const feature = str(args.feature);
      const amount = num(args.amount, 1);
      const ok = await adapter.tryConsume(feature, args.subject, amount, args.context);
      const remaining = await adapter.remaining(feature, args.subject, args.context);
      const out = { feature, ok, amount, remaining };
      return textResult(JSON.stringify(out), out);
    },
    (args) => target(str(args.feature), `consume ${str(args.feature)}`),
  );

  return {
    id: `features:${featuresId}`,
    title: adapter.title ?? "Features",
    dispose: () => {
      for (const d of disposers.splice(0)) d();
    },
  };
}
