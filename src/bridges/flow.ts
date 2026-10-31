// Loose types so this bridge builds standalone without a hard dep on
// fancy-flow. Hosts that have fancy-flow installed get full editor
// integration via the runtime dynamic imports below.
type FlowNode = {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: { kind?: string; label?: string; description?: string; status?: string; statusText?: string; config?: Record<string, unknown>; [k: string]: unknown };
};
type FlowEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
  [k: string]: unknown;
};
type FlowGraph = { nodes: FlowNode[]; edges: FlowEdge[] };
type NodeRunStatus = "idle" | "queued" | "running" | "done" | "error";
type ExecutorRegistry = Record<string, unknown>;
type RunResult = { ok: boolean; outputs: Record<string, unknown>; error?: string };

import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";
import type { AgentTarget as FlAgentTarget } from "../presence/types";
import { commit as runCommit } from "./host-commit";
import type { CallToolResult } from "../mcp/types";

/**
 * The live flow bridge per host. A second `registerFlowBridge` on the same host
 * replaces the first's tools (same owner); this lets it also settle the first
 * one's pending commits, whose results would otherwise land for a surface that
 * is no longer the one the agent is talking to.
 */
const liveFlowBridge = new WeakMap<ToolHost, () => void>();

/**
 * Adapter the host provides — same shape as the editor's local state plus
 * an optional `run`/`cancel` pair so agents can trigger executions.
 */
export type FlowBridgeAdapter = {
  getNodes: () => FlowNode[];
  setNodes: (next: FlowNode[] | ((prev: FlowNode[]) => FlowNode[])) => void;
  getEdges: () => FlowEdge[];
  setEdges: (next: FlowEdge[] | ((prev: FlowEdge[]) => FlowEdge[])) => void;
  /** Optional: invoke runFlow with the host's executor registry. */
  run?: (executors?: ExecutorRegistry) => Promise<RunResult>;
  /** Optional: cancel the in-flight run. */
  cancel?: () => void;
  /** Optional: set per-node status text without going through the runner
   *  (useful for agents narrating). */
  setNodeStatus?: (id: string, status: NodeRunStatus, text?: string) => void;
  /**
   * Human confirm gate for staged actions (trust-but-verify). When
   * `pendingMode` is on, the bridge calls this before a destructive action;
   * return false to decline. Wire it to a human control.
   */
  confirm?: (request: FlowConfirmRequest) => Promise<boolean> | boolean;
  /**
   * Optional (since 0.54.0): commit ONE whole graph operation, authoritatively.
   * When present, every mutating tool (`flow_add_node`, `flow_update_node`,
   * `flow_delete_node`, `flow_connect`, `flow_disconnect`, and
   * `flow_set_node_status` when no `setNodeStatus` is wired) builds a
   * {@link FlowGraphOp} and hands it here INSTEAD of calling
   * `setNodes` / `setEdges`. The bridge waits: the tool reports success, and
   * emits its AgentActivity event, only once this resolves to `void` or
   * `{ ok: true }`. A rejection, a throw, or `{ ok: false, error, code? }` is
   * that call's error result, with no activity.
   *
   * Atomicity is yours: `remove_node` carries the node AND the ids of the edges
   * it removes, and must be applied as one. Check `op.revision` against your
   * current graph and refuse with `{ ok: false, code: "stale" }` if it moved;
   * the op was computed from the graph at call time and is not recomputed.
   * Update the state `getNodes` / `getEdges` return BEFORE resolving, so a read
   * straight after a success sees it.
   *
   * When absent, the bridge calls `setNodes` / `setEdges` exactly as before
   * (fire-and-forget).
   */
  commit?: (op: FlowGraphOp) => FlowAdapterCommit;
  /**
   * Optional (since 0.54.0): the revision of the graph `getNodes` / `getEdges`
   * currently return (a counter, an ETag, a version). Read at the moment the
   * bridge computes an op and carried as `op.revision`, so `commit` can refuse
   * an op computed against a graph that has since moved.
   */
  getRevision?: () => string | number;
};

/**
 * What `commit` may return or resolve to, to acknowledge (or refuse) a graph
 * operation. Same shape as `FormAdapterResult`. `error` is shown to the agent
 * verbatim (message only; a stack is cut), so keep it a sentence the agent can
 * act on ("Graph changed since you read it; re-read and retry"). `code` (e.g.
 * `"stale"`, `"forbidden"`) is returned alongside it in the error result's
 * `structuredContent` as `{ ok: false, op, error, code }`.
 */
export type FlowAdapterResult = { ok: true } | { ok: false; error: string; code?: string };

/**
 * Return type of `commit`. `void` or `{ ok: true }` (sync or resolved) means
 * accepted. If the bridge is disposed, or replaced by another flow bridge on
 * the same host, while a commit is pending, the call settles at once as an
 * error saying the outcome is unknown, and a later settle is ignored.
 */
export type FlowAdapterCommit = void | FlowAdapterResult | Promise<void | FlowAdapterResult>;

/** Who asked for an op, and through which tool. Carried on every {@link FlowGraphOp}. */
export type FlowGraphOpBase = {
  /** Revision from `adapter.getRevision()` when the op was computed; undefined without one. */
  revision?: string | number;
  /** The acting agent (the bridge's `agent` option). */
  agent: { id: string; name?: string; color?: string };
  /** The MCP tool that produced the op. */
  tool: string;
};

/**
 * ONE whole graph operation, as handed to `adapter.commit`. Discriminated on
 * `op`. Every node / edge is the complete record the bridge would have written.
 */
export type FlowGraphOp = FlowGraphOpBase & FlowGraphOpBody;

/** The operation-specific half of a {@link FlowGraphOp}. */
export type FlowGraphOpBody =
  | { op: "add_node"; node: FlowNode }
  | { op: "update_node"; id: string; node: FlowNode; previous: FlowNode }
  | { op: "remove_node"; id: string; node: FlowNode; edgeIds: string[] }
  | { op: "connect"; edge: FlowEdge }
  | { op: "disconnect"; id: string; edge: FlowEdge }
  | { op: "set_node_status"; id: string; status: NodeRunStatus; text?: string };

/** What a staged (pendingMode) flow action asks a human to approve. */
export type FlowConfirmRequest =
  | { action: "delete_node"; nodeId: string; label?: string }
  | { action: "run" };

export type FlowBridgeOptions = {
  adapter: FlowBridgeAdapter;
  /** Identity tagged onto agent-authored nodes. */
  agent?: { id: string; name?: string; color?: string };
  /**
   * Enforce port-type compatibility on `flow_connect`, using fancy-flow's
   * `createConnectionValidator` — the SAME rule `<FlowCanvas>` applies, so an
   * agent can't build an edge the canvas would refuse. `true` (default) uses the
   * default rule (untyped ports permissive); pass `ConnectionValidatorOptions`
   * to tune it, or `false` to disable. No-ops if fancy-flow (>= 0.18.0) isn't
   * importable — the bridge falls back to the existence-only check.
   */
  validateConnections?: boolean | Record<string, unknown>;
  /**
   * Validate a node's config against its kind's `configSchema` on
   * `flow_add_node` / `flow_update_node`. `"reject"` (default) refuses an
   * invalid write; `"warn"` applies it but reports the issues; `"off"` skips.
   * No-ops for the legacy 6-pack (no schema) and when fancy-flow isn't importable.
   */
  validateConfig?: "reject" | "warn" | "off";
  /**
   * Stage destructive/human-visible actions (`flow_delete_node`, `flow_run`) for
   * human confirmation via `adapter.confirm` instead of applying immediately.
   * **Default: OFF** — flow authoring is high-frequency, unlike a form submit.
   * When on without an `adapter.confirm`, the action proceeds (nothing to gate).
   */
  pendingMode?: boolean;
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };
const KINDS: string[] = ["trigger", "action", "decision", "output", "note", "subgraph"];

const num = (v: unknown, fallback?: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback ?? 0;
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/**
 * registerFlowBridge — wires an MCP tool set against a fancy-flow editor's
 * controlled state. Mirrors the whiteboard bridge in shape: read tools,
 * mutation tools (add / update / delete nodes + edges), and optional
 * run/cancel if the host provides those callbacks.
 */
export function registerFlowBridge(
  host: ToolHost,
  options: FlowBridgeOptions,
): Bridge {
  const { adapter } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const disposers: Array<() => void> = [];
  // The bridge id is also its registrant identity on the host: the same bridge
  // may re-register (a remount), a different one claiming a name is refused.
  const bridgeId = "flow";

  const pendingMode = options.pendingMode ?? false;
  const validateConfigMode = options.validateConfig ?? "reject";

  // Lazily build the connection validator from fancy-flow (>= 0.18.0) and cache
  // it. `undefined` = not yet tried, `null` = unavailable/disabled → fall back
  // to the existence-only check. The validator reads nodes live via the getter.
  let connValidator: ((c: any) => boolean) | null | undefined = undefined;
  const getConnValidator = async (): Promise<((c: any) => boolean) | null> => {
    if (connValidator !== undefined) return connValidator;
    if (options.validateConnections === false) return (connValidator = null);
    try {
      // @ts-ignore — optional peer dep, may not be installed
      const { createConnectionValidator } = await import("@particle-academy/fancy-flow" as any);
      const opts =
        options.validateConnections && options.validateConnections !== true
          ? options.validateConnections
          : undefined;
      connValidator = createConnectionValidator(() => adapter.getNodes() as any, opts);
    } catch {
      connValidator = null;
    }
    return connValidator ?? null;
  };

  // agent_undo / agent_redo / agent_history are registered whenever any bridge
  // mounts, so undo availability doesn't hinge on which bridges are co-present.
  ensureUndoToolsRegistered(host, { defaultAgentId: agent.id });

  // ── Awaited commits (0.54.0) ──
  // Close handling, as in the form bridge (0.52.0). The bridge may be disposed,
  // or replaced by another flow bridge on this host, while a commit or a human
  // confirm is pending; its promise may then never settle. Every awaited host
  // call on the commit path is raced against close, so the tool call settles at
  // once instead of hanging, and a late settle is ignored (no activity).
  let closed = false;
  const onClose = new Set<() => void>();
  const CLOSED: unique symbol = Symbol("flow-closed");
  const untilClosed = <T>(p: Promise<T>): Promise<T | typeof CLOSED> => {
    if (closed) {
      p.catch(() => {}); // a late rejection must never be unhandled
      return Promise.resolve(CLOSED);
    }
    return new Promise<T | typeof CLOSED>((resolve, reject) => {
      const close = () => {
        p.catch(() => {});
        resolve(CLOSED);
      };
      onClose.add(close);
      p.then(
        (v) => { onClose.delete(close); resolve(v); },
        (e) => { onClose.delete(close); reject(e); },
      );
    });
  };
  const close = () => {
    if (closed) return;
    closed = true;
    for (const c of [...onClose]) c();
    onClose.clear();
  };
  const closedUnknown = (tool: string) =>
    errorResult(
      `The flow editor was closed or replaced before the host confirmed ${tool}, so whether it was applied is unknown. ` +
        "Do not assume it was. Read the graph back (flow_get_state) before retrying.",
    );
  const revisionNow = () => adapter.getRevision?.();

  /**
   * Hand ONE whole op to `adapter.commit` and wait. Returns null when the host
   * accepted it, or the tool's error result. Only called when `commit` exists.
   */
  const commitOp = async (
    tool: string,
    revision: string | number | undefined,
    body: FlowGraphOpBody,
  ): Promise<CallToolResult | null> => {
    const commitFn = adapter.commit!;
    const op = { ...body, revision, agent: { id: agent.id, name: agent.name, color: agent.color }, tool } as FlowGraphOp;
    const done = await untilClosed(runCommit(() => commitFn(op), `Host refused ${tool}.`));
    if (done === CLOSED) return closedUnknown(tool);
    if (!done.ok) {
      return {
        ...errorResult(done.error),
        structuredContent: { ok: false, op: op.op, error: done.error, ...(done.code ? { code: done.code } : {}) },
      };
    }
    return null;
  };

  // Activity-target resolver shared by every mutation tool. Pulls element id
  // from the freshly-added node/edge (structuredContent), falling back to args.
  const flTarget = (args: any, result: any): FlAgentTarget => ({
    kind: "flow",
    elementId: (result?.structuredContent?.id as string | undefined) ?? (args?.id as string | undefined),
  });

  const reg = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: JsonObject) => Promise<any> | any,
    resolveTarget?: (args: JsonObject, result: any) => FlAgentTarget | null,
  ) => {
    const wrapped = async (args: JsonObject) => {
      try {
        return await handler(args);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    };
    const final = resolveTarget
      ? wrapToolWithActivity(wrapped, {
          toolName: name,
          agent: { id: agent.id, name: agent.name, color: agent.color },
          kind: "flow",
          resolveTarget: ({ args, result }) => resolveTarget(args, result),
        })
      : wrapped;
    disposers.push(
      host.registerTool(
        {
          name,
          description,
          inputSchema: { type: "object", properties: properties as any, required, additionalProperties: false },
        },
        final as any,
        { owner: bridgeId },
      ),
    );
  };

  // ───────────── Read tools ─────────────

  reg("flow_get_state", "Get the full graph: nodes + edges.", {}, [], () => {
    const state: FlowGraph = { nodes: adapter.getNodes(), edges: adapter.getEdges() };
    return textResult(JSON.stringify(state, null, 2), state);
  });

  reg("flow_list_nodes", "Summarise every node: id, kind, label, position, status.", {}, [], () => {
    const items = adapter.getNodes().map((n) => ({
      id: n.id,
      kind: n.type,
      label: n.data?.label,
      x: Math.round(n.position.x),
      y: Math.round(n.position.y),
      status: n.data?.status ?? "idle",
    }));
    const text = items.map((i) => `${i.kind} ${i.id}: "${i.label}" @(${i.x},${i.y}) [${i.status}]`).join("\n") || "(empty graph)";
    return textResult(text, items);
  });

  reg(
    "flow_get_node",
    "Get a single node's full record by id.",
    { id: { type: "string" } },
    ["id"],
    (args) => {
      const id = str(args.id);
      const node = adapter.getNodes().find((n) => n.id === id);
      if (!node) return errorResult(`No node with id ${id}`);
      return textResult(JSON.stringify(node, null, 2), node);
    },
  );

  reg(
    "flow_list_node_kinds",
    "List every node kind registered in fancy-flow's registry. Use this to discover what's authorable before adding nodes.",
    { category: { type: "string", description: "Optional category filter: trigger | logic | data | ai | io | human | output | custom." } },
    [],
    async (args) => {
      // Dynamic import keeps the bridge usable even when fancy-flow isn't loaded.
      try {
        // @ts-ignore — optional peer dep, may not be installed
        const { listNodeKinds } = await import("@particle-academy/fancy-flow" as any);
        const category = typeof args.category === "string" ? args.category : undefined;
        const all = (category ? listNodeKinds().filter((k: any) => k.category === category) : listNodeKinds()).map((k: any) => ({
          name: k.name,
          category: k.category,
          label: k.label,
          description: k.description,
          icon: k.icon,
          accent: k.accent,
          inputs: k.inputs ?? [],
          outputs: k.outputs ?? [],
          configFields: (k.configSchema ?? []).map((f: any) => ({ key: f.key, type: f.type, label: f.label, required: !!f.required })),
        }));
        const text = all.map((k: any) => `${k.category}/${k.name}: ${k.label}${k.description ? " — " + k.description : ""}`).join("\n");
        return textResult(text || "(no kinds registered)", all);
      } catch (e) {
        return errorResult(`fancy-flow registry not available: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  reg(
    "flow_get_node_schema",
    "Get the full configSchema + ports for a node kind. Use to know exactly what fields a kind accepts before calling flow_add_node.",
    { name: { type: "string" } },
    ["name"],
    async (args) => {
      try {
        // @ts-ignore — optional peer dep
        const { getNodeKind } = await import("@particle-academy/fancy-flow" as any);
        const k: any = getNodeKind(str(args.name));
        if (!k) return errorResult(`No kind registered: ${args.name}`);
        const summary = {
          name: k.name,
          category: k.category,
          label: k.label,
          description: k.description,
          inputs: k.inputs ?? [],
          outputs: k.outputs ?? [],
          configSchema: k.configSchema ?? [],
          defaultConfig: k.defaultConfig ?? null,
        };
        return textResult(JSON.stringify(summary, null, 2), summary);
      } catch (e) {
        return errorResult(`fancy-flow registry not available: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  reg("flow_list_edges", "Summarise every edge.", {}, [], () => {
    const items = adapter.getEdges().map((e) => ({
      id: e.id,
      from: `${e.source}${e.sourceHandle ? `:${e.sourceHandle}` : ""}`,
      to: `${e.target}${e.targetHandle ? `:${e.targetHandle}` : ""}`,
    }));
    return textResult(items.map((i) => `${i.id}: ${i.from} → ${i.to}`).join("\n") || "(no edges)", items);
  });

  // ───────────── Node CRUD ─────────────

  reg(
    "flow_add_node",
    "Add a node of any kind registered in fancy-flow's registry. Call flow_list_node_kinds first to discover what's available.",
    {
      kind: { type: "string", description: "Registry kind name (e.g. memory_store, llm_call, branch)." },
      label: { type: "string" },
      x: { type: "number" },
      y: { type: "number" },
      description: { type: "string" },
      config: { type: "object", description: "Config fields per the kind's configSchema." },
      body: { type: "string", description: "Note kinds only — body text." },
    },
    ["kind", "label", "x", "y"],
    async (args) => {
      // Add depends on no prior graph state; the revision is read at call time.
      const revision = revisionNow();
      const kindName = str(args.kind);
      // Resolve the kind dynamically from the registry. Falls back to the
      // legacy 6-pack so old graphs keep working.
      let kindDef: any = null;
      try {
        // @ts-ignore — optional peer dep
        const { getNodeKind, defaultConfigFor } = await import("@particle-academy/fancy-flow" as any);
        kindDef = getNodeKind(kindName);
        var defaults: Record<string, unknown> = kindDef ? defaultConfigFor(kindDef) : {};
      } catch {
        var defaults: Record<string, unknown> = {};
      }
      const isLegacy = ["trigger", "action", "decision", "output", "note", "subgraph"].includes(kindName);
      if (!kindDef && !isLegacy) {
        return errorResult(`Unknown kind: ${kindName} — call flow_list_node_kinds for the registry.`);
      }
      const id = newId("n");
      const config = { ...defaults, ...((args.config && typeof args.config === "object") ? (args.config as Record<string, unknown>) : {}) };
      let configWarnings: string[] = [];
      if (kindDef && validateConfigMode !== "off") {
        try {
          // @ts-ignore — optional peer dep
          const { validateConfig } = await import("@particle-academy/fancy-flow" as any);
          const issues = (validateConfig(kindDef, config) ?? []) as Array<{ message: string }>;
          if (issues.length) {
            if (validateConfigMode === "reject") {
              return errorResult(
                `Config invalid for ${kindName}: ${issues.map((i) => i.message).join("; ")}. Call flow_get_node_schema for the accepted fields.`,
              );
            }
            configWarnings = issues.map((i) => i.message);
          }
        } catch {
          /* fancy-flow not importable → skip validation */
        }
      }
      const node: FlowNode = {
        id,
        type: kindName,
        position: { x: num(args.x), y: num(args.y) },
        data: {
          kind: kindName,
          label: str(args.label),
          ...(args.description ? { description: str(args.description) } : {}),
          config,
          ...(kindName === "note" && args.body ? { body: str(args.body) } : {}),
        } as any,
      };
      if (adapter.commit) {
        const refused = await commitOp("flow_add_node", revision, { op: "add_node", node });
        if (refused) return refused;
      } else {
        adapter.setNodes((all) => [...all, node]);
      }
      return textResult(
        `Added ${kindName} ${id} ("${str(args.label)}")${configWarnings.length ? ` — config warnings: ${configWarnings.join("; ")}` : ""}`,
        node,
      );
    },
    flTarget,
  );

  reg(
    "flow_update_node",
    "Update fields on a node. Only provided fields change.",
    {
      id: { type: "string" },
      label: { type: "string" },
      x: { type: "number" },
      y: { type: "number" },
      description: { type: "string" },
      config: { type: "object" },
    },
    ["id"],
    async (args) => {
      const id = str(args.id);
      // Read first so config validation can veto BEFORE any mutation applies.
      const current = adapter.getNodes().find((n) => n.id === id);
      // Read with `current`: the op below is computed from this graph.
      const revision = revisionNow();
      if (!current) return errorResult(`No node with id ${id}`);

      const mergedConfig =
        args.config && typeof args.config === "object"
          ? { ...(current.data.config ?? {}), ...(args.config as Record<string, unknown>) }
          : current.data.config;

      let configWarnings: string[] = [];
      if (args.config && typeof args.config === "object" && validateConfigMode !== "off") {
        try {
          // @ts-ignore — optional peer dep
          const { getNodeKind, validateConfig } = await import("@particle-academy/fancy-flow" as any);
          const kindDef = getNodeKind((current.data as any).kind ?? current.type);
          if (kindDef) {
            const issues = (validateConfig(kindDef, mergedConfig ?? {}) ?? []) as Array<{ message: string }>;
            if (issues.length) {
              if (validateConfigMode === "reject") {
                return errorResult(`Config invalid for ${id}: ${issues.map((i) => i.message).join("; ")}.`);
              }
              configWarnings = issues.map((i) => i.message);
            }
          }
        } catch {
          /* fancy-flow not importable → skip validation */
        }
      }

      const updated: FlowNode = {
        ...current,
        position: {
          x: args.x !== undefined ? num(args.x) : current.position.x,
          y: args.y !== undefined ? num(args.y) : current.position.y,
        },
        data: {
          ...current.data,
          ...(args.label !== undefined ? { label: str(args.label) } : {}),
          ...(args.description !== undefined ? { description: str(args.description) } : {}),
          ...(args.config && typeof args.config === "object" ? { config: mergedConfig } : {}),
        },
      };
      if (adapter.commit) {
        const refused = await commitOp("flow_update_node", revision, { op: "update_node", id, node: updated, previous: current });
        if (refused) return refused;
      } else {
        adapter.setNodes((all) => all.map((n) => (n.id === id ? updated : n)));
      }
      return textResult(
        `Updated node ${id}${configWarnings.length ? ` — config warnings: ${configWarnings.join("; ")}` : ""}`,
        updated,
      );
    },
    flTarget,
  );

  reg(
    "flow_delete_node",
    "Remove a node by id (also removes any connected edges).",
    { id: { type: "string" } },
    ["id"],
    async (args) => {
      const id = str(args.id);
      // Validate existence BEFORE scheduling the state update — React's
      // functional updaters may run async in strict mode, so checking a
      // flag set inside the updater would race the response.
      const target = adapter.getNodes().find((n) => n.id === id);
      if (!target) return errorResult(`No node with id ${id}`);
      // Destructive → stage for human confirmation when pendingMode is on.
      if (adapter.commit) {
        if (pendingMode && adapter.confirm) {
          const confirm = adapter.confirm;
          const ok = await untilClosed(
            Promise.resolve().then(() => confirm({ action: "delete_node", nodeId: id, label: target.data?.label })),
          );
          // Never delete from an editor that is no longer the one on screen.
          if (ok === CLOSED) {
            return errorResult(`The flow editor was closed before the delete of node ${id} was confirmed. Nothing was deleted.`);
          }
          if (!ok) return textResult(`Delete of node ${id} was declined by the human.`);
        }
        // Compute the op AFTER the human decided, from the graph as it is now:
        // ONE op carrying the node and every edge it takes with it.
        const node = adapter.getNodes().find((n) => n.id === id);
        const revision = revisionNow();
        if (!node) return errorResult(`No node with id ${id}`);
        const edgeIds = adapter.getEdges().filter((e) => e.source === id || e.target === id).map((e) => e.id);
        const refused = await commitOp("flow_delete_node", revision, { op: "remove_node", id, node, edgeIds });
        if (refused) return refused;
        return textResult(`Deleted node ${id}`);
      }
      if (pendingMode && adapter.confirm) {
        const ok = await adapter.confirm({ action: "delete_node", nodeId: id, label: target.data?.label });
        if (!ok) return textResult(`Delete of node ${id} was declined by the human.`);
      }
      adapter.setNodes((all) => all.filter((n) => n.id !== id));
      adapter.setEdges((all) => all.filter((e) => e.source !== id && e.target !== id));
      return textResult(`Deleted node ${id}`);
    },
    flTarget,
  );

  // ───────────── Edges ─────────────

  reg(
    "flow_connect",
    "Create an edge between two nodes (optionally specifying handle ids).",
    {
      source: { type: "string" },
      target: { type: "string" },
      sourceHandle: { type: "string" },
      targetHandle: { type: "string" },
      label: { type: "string" },
    },
    ["source", "target"],
    async (args) => {
      const source = str(args.source);
      const target = str(args.target);
      const sourceHandle = args.sourceHandle ? str(args.sourceHandle) : undefined;
      const targetHandle = args.targetHandle ? str(args.targetHandle) : undefined;
      const all = adapter.getNodes();
      const revision = revisionNow();
      if (!all.find((n) => n.id === source)) return errorResult(`No source node ${source}`);
      if (!all.find((n) => n.id === target)) return errorResult(`No target node ${target}`);

      // Enforce port-type compatibility with the SAME rule <FlowCanvas> applies,
      // so an agent can't build an edge the canvas would refuse (no drift).
      const validate = await getConnValidator();
      if (validate && !validate({ source, target, sourceHandle: sourceHandle ?? null, targetHandle: targetHandle ?? null })) {
        if (source === target) return errorResult(`Cannot connect node ${source} to itself.`);
        return errorResult(
          `Invalid connection ${source}${sourceHandle ? `:${sourceHandle}` : ""} → ${target}${targetHandle ? `:${targetHandle}` : ""}: incompatible port types or unknown handle. Call flow_get_node_schema to check the ports.`,
        );
      }

      const edge: FlowEdge = {
        id: newId("e"),
        source,
        target,
        ...(sourceHandle ? { sourceHandle } : {}),
        ...(targetHandle ? { targetHandle } : {}),
        ...(args.label ? { label: str(args.label) } : {}),
      };
      if (adapter.commit) {
        const refused = await commitOp("flow_connect", revision, { op: "connect", edge });
        if (refused) return refused;
      } else {
        adapter.setEdges((existing) => [...existing, edge]);
      }
      return textResult(`Connected ${source}${edge.sourceHandle ? `:${edge.sourceHandle}` : ""} → ${target}${edge.targetHandle ? `:${edge.targetHandle}` : ""}`, edge);
    },
    flTarget,
  );

  reg(
    "flow_disconnect",
    "Remove an edge by id.",
    { id: { type: "string" } },
    ["id"],
    async (args) => {
      const id = str(args.id);
      const edge = adapter.getEdges().find((e) => e.id === id);
      const revision = revisionNow();
      if (!edge) {
        return errorResult(`No edge ${id}`);
      }
      if (adapter.commit) {
        const refused = await commitOp("flow_disconnect", revision, { op: "disconnect", id, edge });
        if (refused) return refused;
        return textResult(`Disconnected ${id}`);
      }
      adapter.setEdges((all) => all.filter((e) => e.id !== id));
      return textResult(`Disconnected ${id}`);
    },
    flTarget,
  );

  // ───────────── Status / run ─────────────

  reg(
    "flow_set_node_status",
    "Manually set a node's status badge (idle | queued | running | done | error) and optional text. Useful for narration outside a run.",
    {
      id: { type: "string" },
      status: { type: "string", enum: ["idle", "queued", "running", "done", "error"] },
      text: { type: "string" },
    },
    ["id", "status"],
    async (args) => {
      const id = str(args.id);
      const status = str(args.status) as NodeRunStatus;
      const text = args.text !== undefined ? str(args.text) : undefined;
      if (adapter.setNodeStatus) {
        adapter.setNodeStatus(id, status, text);
      } else if (adapter.commit) {
        // No dedicated status channel: the badge lives in node data, so it is
        // a graph write and goes through commit like any other.
        const exists = adapter.getNodes().some((n) => n.id === id);
        const revision = revisionNow();
        if (!exists) return errorResult(`No node with id ${id}`);
        const refused = await commitOp("flow_set_node_status", revision, {
          op: "set_node_status",
          id,
          status,
          ...(text !== undefined ? { text } : {}),
        });
        if (refused) return refused;
      } else {
        // Fall back to mutating the node data directly.
        let found = false;
        adapter.setNodes((all) =>
          all.map((n) => {
            if (n.id !== id) return n;
            found = true;
            return { ...n, data: { ...n.data, status, statusText: text } };
          }),
        );
        if (!found) return errorResult(`No node with id ${id}`);
      }
      return textResult(`${id} → ${status}${text ? ` (${text})` : ""}`);
    },
    flTarget,
  );

  reg(
    "flow_run",
    "Trigger a run of the current graph. Returns the topological result. Requires the host to have wired `run` into the adapter.",
    {},
    [],
    async () => {
      if (!adapter.run) return errorResult("Host did not provide a run handler.");
      if (pendingMode && adapter.confirm) {
        const ok = await adapter.confirm({ action: "run" });
        if (!ok) return textResult("Run was declined by the human.");
      }
      const result = await adapter.run();
      return textResult(result.ok ? "Run complete" : `Run failed: ${result.error ?? "unknown"}`, result);
    },
    flTarget,
  );

  reg(
    "flow_cancel",
    "Cancel an in-flight run.",
    {},
    [],
    () => {
      if (!adapter.cancel) return errorResult("Host did not provide a cancel handler.");
      adapter.cancel();
      return textResult("Run cancelled");
    },
    flTarget,
  );

  // Every tool registered: this bridge is now the host's live flow bridge. A
  // predecessor it replaced settles its pending commits as "outcome unknown".
  liveFlowBridge.get(host)?.();
  liveFlowBridge.set(host, close);

  return {
    id: bridgeId,
    title: "Flow",
    dispose: () => {
      for (const d of disposers) d();
      if (liveFlowBridge.get(host) === close) liveFlowBridge.delete(host);
      // Settle every call still waiting on the host; see untilClosed.
      close();
    },
  };
}
