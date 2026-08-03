/**
 * registerDocBridge — a GENERIC MCP bridge over a `@particle-academy/fancy-doc-commons`
 * `DocTree`. Give it an adapter (`{ get, set }`) and it generates, from the shared
 * op-spine, a full Human+ surface: uniform read tools + the canonical node op tools
 * (add / update / remove / move) under one verb lexicon, with **undo derived from
 * the reducer**, agent-activity broadcasts, unconditional `agent_undo/redo/history`,
 * and an optional **staged-write** (confirm / reject) channel — replacing the ~500-line
 * bespoke bridges (whiteboard/flow/artboard/…) with one builder. A surface adds its
 * domain ops (e.g. cms `set_style`) via `opTools` + a matching reducer.
 */
import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import type { AgentTarget } from "../presence/types";
import { pushUndoEntry } from "../undo/undo-stack";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";
import {
  treeReducer,
  childrenOf,
  descendantsOf,
  appendOrder,
  autoApply,
  type DocTree,
  type DocNode,
  type TreeOp,
  type DocReducer,
  type StagePolicy,
} from "@particle-academy/fancy-doc-commons";

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };

/** Host-provided access to the document tree. */
export interface DocAdapter<N extends DocNode> {
  /** Read the current tree. */
  get(): DocTree<N>;
  /** Replace the tree — host wires this to its `onChange` / `setState`. */
  set(next: DocTree<N>): void;
  /** Optional fancy-screens screen id, for presence scoping. */
  screenId?: string;
  /** Mint a fresh, unique node id. Default: `<surface>-<n>`. */
  newId?(): string;
}

/**
 * A domain op tool beyond the built-in add/update/remove/move — lets a surface
 * expose its own ops (e.g. cms `set_style`) through the same undo + activity path.
 */
export interface DocOpTool<N extends DocNode, TOp> {
  /** Verb, prefixed with the surface (e.g. `set_style` → `cms_set_style`). */
  verb: string;
  description: string;
  properties: Record<string, unknown>;
  required: string[];
  /** Build the op from the args (or return `{ error }`). */
  build(args: JsonObject, tree: DocTree<N>): TOp | { error: string };
  /** Node id this op targets (for the activity target + undo label). */
  targetId?(args: JsonObject): string | undefined;
}

export interface DocBridgeOptions<N extends DocNode, TOp = TreeOp<N>> {
  adapter: DocAdapter<N>;
  /** Tool-name prefix + activity kind (e.g. `"cms"` → `cms_add`, kind `"cms"`). */
  surface: string;
  agent?: { id: string; name?: string; color?: string };
  /** Reducer for reduce + invert. Default: the substrate `treeReducer<N>()`. */
  reducer?: DocReducer<DocTree<N>, TOp>;
  /** Build a full node from the core fields + props (fill surface defaults, e.g. `style`). */
  makeNode?: (core: { id: string; type: string; parent: string | null; order: string }, props: Record<string, unknown>) => N;
  /** Domain op tools beyond the built-ins. */
  opTools?: DocOpTool<N, TOp>[];
  /** Decide auto-apply vs. confirm per op. Default: everything auto-applies. */
  stagePolicy?: StagePolicy<TOp>;
  /** Fired when an op is staged pending human confirmation. */
  onPending?: (staged: { id: string; op: TOp; label: string }) => void;
  /** Summarize a node for describe/list. Default: id/type/parent + prop keys. */
  describeNode?: (node: N) => Record<string, unknown>;
}

/** Register the generic doc-surface bridge. Returns a {@link Bridge}. */
export function registerDocBridge<N extends DocNode, TOp = TreeOp<N>>(
  host: ToolHost,
  options: DocBridgeOptions<N, TOp>,
): Bridge {
  const { adapter, surface } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const reducer = (options.reducer ?? (treeReducer<N>() as unknown as DocReducer<DocTree<N>, TOp>));
  const stage = options.stagePolicy ?? (autoApply as StagePolicy<TOp>);
  const makeNode =
    options.makeNode ?? (({ id, type, parent, order }, props) => ({ id, type, parent, order, props }) as N);
  const describeNode =
    options.describeNode ?? ((n: N) => ({ id: n.id, type: n.type, parent: n.parent, props: Object.keys(n.props ?? {}) }));
  const disposers: Array<() => void> = [];

  // agent_undo / agent_redo / agent_history — always present (undo derives from
  // the reducer, so every doc surface gets working undo for free).
  ensureUndoToolsRegistered(host, { defaultAgentId: agent.id });

  let idSeq = 0;
  // The counter restarts with the bridge, so on a tree loaded from elsewhere
  // `surface-1` may well be taken. Skip past anything that already exists
  // rather than minting an id that silently overwrites a node.
  const mintId = () => {
    if (adapter.newId) return adapter.newId();
    const taken = adapter.get().nodes;
    let id: string;
    do id = `${surface}-${(idSeq += 1)}`;
    while (taken[id]);
    return id;
  };
  const target = (elementId?: string): AgentTarget => ({ kind: surface, screenId: adapter.screenId, elementId });

  // Staged ops awaiting confirmation.
  const pending = new Map<string, { op: TOp; label: string; targetId?: string }>();

  /** Apply an op immediately: reduce → set → push a snapshot-based undo entry. */
  function commit(op: TOp, label: string, targetId?: string): Record<string, unknown> {
    const prev = adapter.get();
    const next = reducer.reduce(prev, op);
    adapter.set(next);
    pushUndoEntry(agent.id, {
      timestamp: Date.now(),
      bridgeId: surface,
      action: label,
      label,
      undo: () => adapter.set(prev),
      redo: () => adapter.set(next),
    });
    return { ok: true, id: targetId };
  }

  /**
   * Auto-apply, or stage for confirmation per the stage policy.
   *
   * The staged case reports the pending id under its OWN key. Returning it as
   * `id` — as this used to — collided with the node id every mutation already
   * reports, so `update`/`remove`/`move` overwrote it and left the agent holding
   * a node id that `confirm` does not accept. The staged write was unconfirmable
   * for three of the four canonical ops, and looked fine from the outside.
   */
  function submit(op: TOp, label: string, targetId?: string): { staged: boolean; id?: string; pendingId?: string } {
    if (stage(op) === "confirm") {
      const pendingId = `${surface}-pending-${(idSeq += 1)}`;
      pending.set(pendingId, { op, label, targetId });
      options.onPending?.({ id: pendingId, op, label });
      return { staged: true, id: targetId, pendingId };
    }
    commit(op, label, targetId);
    return { staged: false, id: targetId };
  }

  const reg = (
    verb: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: JsonObject) => Record<string, unknown> | Promise<Record<string, unknown>>,
    isMutation: boolean,
    resolveTarget?: (args: JsonObject, result: Record<string, unknown>) => AgentTarget | null,
  ): void => {
    const name = `${surface}_${verb}`;
    const wrapped = async (args: JsonObject) => {
      try {
        // `_text` is the human-facing line; the rest is structuredContent.
        const { _text, ...structured } = await handler(args);
        return textResult(typeof _text === "string" ? _text : name, structured);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    };
    const final = isMutation
      ? wrapToolWithActivity(wrapped, {
          toolName: name,
          agent,
          kind: surface,
          screenId: adapter.screenId,
          resolveTarget: ({ args, result }) => {
            if ((result.structuredContent as JsonObject | undefined)?.staged) return null;
            return resolveTarget?.(args, (result.structuredContent as JsonObject) ?? {}) ?? target();
          },
        })
      : wrapped;
    disposers.push(
      host.registerTool(
        { name, description, inputSchema: { type: "object", properties: properties as never, required, additionalProperties: false } },
        final as never,
      ),
    );
  };

  // ── Read tools ──────────────────────────────────────────────────────────
  reg(
    "describe",
    `Summarize the ${surface} document: node count, roots, and the active surface. Call before reading or writing.`,
    {},
    [],
    () => {
      const tree = adapter.get();
      const ids = Object.keys(tree.nodes);
      return { nodeCount: ids.length, roots: childrenOf(tree, null).map((n) => n.id), _text: `${ids.length} nodes` };
    },
    false,
  );
  reg(
    "get",
    `Get the whole ${surface} document tree as JSON.`,
    {},
    [],
    () => ({ tree: adapter.get(), _text: "full tree" }),
    false,
  );
  reg(
    "list",
    "List nodes (optionally the children of `parent`), in order.",
    { parent: { type: ["string", "null"], description: "Parent id, or null/omitted for roots." } },
    [],
    (args) => {
      const tree = adapter.get();
      const parent = typeof args.parent === "string" ? args.parent : null;
      return { nodes: childrenOf(tree, parent).map(describeNode), _text: `children of ${parent ?? "root"}` };
    },
    false,
  );
  reg(
    "get_node",
    "Get one node by id.",
    { id: { type: "string" } },
    ["id"],
    (args) => {
      const node = adapter.get().nodes[String(args.id)];
      if (!node) throw new Error(`No node ${args.id}`);
      return { node, _text: `node ${node.id}` };
    },
    false,
  );

  // ── Canonical op tools ──────────────────────────────────────────────────
  reg(
    "add",
    "Insert a node. Returns its id. Appends under `parent` (or roots) unless `order` is given.",
    {
      type: { type: "string", description: "Node type discriminant." },
      parent: { type: ["string", "null"], description: "Parent id, or null for a root." },
      props: { type: "object", description: "JSON props bag." },
      order: { type: "string", description: "Fractional order key (default: append)." },
      id: {
        type: "string",
        description:
          "Id for the new node. Supply a meaningful one if you intend to address this node later; omitted means one is minted for you. Must not already exist.",
      },
    },
    ["type"],
    (args) => {
      const tree = adapter.get();
      const parent = typeof args.parent === "string" ? args.parent : null;
      // An agent that names the node names the handle it will use afterwards.
      // Minted ids are addressable too, just less memorable.
      const requested = typeof args.id === "string" ? args.id : undefined;
      if (requested !== undefined && tree.nodes[requested]) {
        throw new Error(`Node ${requested} already exists — pick a different id or update it instead`);
      }
      const id = requested ?? mintId();
      const order = typeof args.order === "string" ? args.order : appendOrder(tree, parent);
      const props = (args.props && typeof args.props === "object" ? args.props : {}) as Record<string, unknown>;
      const node = makeNode({ id, type: String(args.type), parent, order }, props);
      const res = submit({ t: "insert", node } as unknown as TOp, `add ${args.type} ${id}`, id);
      return { ...res, _text: res.staged ? `staged add ${id} — confirm ${res.pendingId}` : `added ${id}` };
    },
    true,
    (_args, result) => target(result.id as string | undefined),
  );
  reg(
    "update",
    "Merge a props patch into a node.",
    { id: { type: "string" }, patch: { type: "object" } },
    ["id", "patch"],
    (args) => {
      const id = String(args.id);
      if (!adapter.get().nodes[id]) throw new Error(`No node ${id}`);
      const patch = (args.patch && typeof args.patch === "object" ? args.patch : {}) as Record<string, unknown>;
      const res = submit({ t: "set_props", id, patch } as unknown as TOp, `update ${id}`, id);
      return { ...res, id, _text: res.staged ? `staged update ${id} — confirm ${res.pendingId}` : `updated ${id}` };
    },
    true,
    (args) => target(String(args.id)),
  );
  reg(
    "remove",
    "Remove a node and its subtree.",
    { id: { type: "string" } },
    ["id"],
    (args) => {
      const id = String(args.id);
      const tree = adapter.get();
      if (!tree.nodes[id]) throw new Error(`No node ${id}`);
      const count = descendantsOf(tree, id).length + 1;
      const res = submit({ t: "remove", id } as unknown as TOp, `remove ${id} (${count} node${count === 1 ? "" : "s"})`, id);
      return { ...res, id, removed: count, _text: res.staged ? `staged remove ${id} — confirm ${res.pendingId}` : `removed ${id}` };
    },
    true,
    (args) => target(String(args.id)),
  );
  reg(
    "move",
    "Reparent + reorder a node.",
    { id: { type: "string" }, parent: { type: ["string", "null"] }, order: { type: "string", description: "Fractional order key (default: append under the new parent)." } },
    ["id"],
    (args) => {
      const id = String(args.id);
      const tree = adapter.get();
      if (!tree.nodes[id]) throw new Error(`No node ${id}`);
      const parent = args.parent === null ? null : typeof args.parent === "string" ? args.parent : tree.nodes[id]!.parent;
      const order = typeof args.order === "string" ? args.order : appendOrder(tree, parent);
      const res = submit({ t: "move", id, parent, order } as unknown as TOp, `move ${id}`, id);
      return { ...res, id, _text: res.staged ? `staged move ${id} — confirm ${res.pendingId}` : `moved ${id}` };
    },
    true,
    (args) => target(String(args.id)),
  );

  // ── Domain op tools ─────────────────────────────────────────────────────
  for (const t of options.opTools ?? []) {
    reg(
      t.verb,
      t.description,
      t.properties,
      t.required,
      (args) => {
        const built = t.build(args, adapter.get());
        if (built && typeof built === "object" && "error" in built) throw new Error((built as { error: string }).error);
        const tid = t.targetId?.(args);
        const res = submit(built as TOp, `${t.verb} ${tid ?? ""}`.trim(), tid);
        return { ...res, id: tid, _text: res.staged ? `staged ${t.verb} — confirm ${res.pendingId}` : t.verb };
      },
      true,
      (args) => target(t.targetId?.(args)),
    );
  }

  // ── Staged-write confirm / reject ───────────────────────────────────────
  reg(
    "confirm",
    "Apply a staged op. Pass the `pendingId` a staged mutation returned — not the node `id` it also returns.",
    { id: { type: "string", description: "The `pendingId` from a staged mutation." } },
    ["id"],
    (args) => {
      const id = String(args.id);
      const p = pending.get(id);
      if (!p) throw new Error(`No pending op ${id}`);
      pending.delete(id);
      commit(p.op, p.label, p.targetId);
      return { ok: true, applied: p.label, id: p.targetId, _text: `applied ${p.label}` };
    },
    true,
    (_args, result) => target(result.id as string | undefined),
  );
  reg(
    "reject",
    "Discard a staged op. Pass the `pendingId` a staged mutation returned — not the node `id` it also returns.",
    { id: { type: "string", description: "The `pendingId` from a staged mutation." } },
    ["id"],
    (args) => {
      const id = String(args.id);
      const p = pending.get(id);
      if (!p) throw new Error(`No pending op ${id}`);
      pending.delete(id);
      return { ok: true, rejected: p.label, _text: `rejected ${p.label}` };
    },
    false,
  );

  return {
    id: surface,
    title: surface,
    dispose: () => {
      for (const d of disposers) d();
      pending.clear();
    },
  };
}
