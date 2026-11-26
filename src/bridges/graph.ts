// Loose types so this bridge builds standalone, with no dependency on
// @particle-academy/fancy-graph or three. Hosts pass fancy-graph's own
// GraphData straight through; the shapes match.
type GraphNodeLike = { id: string; label?: string; group?: string };
type GraphLinkLike = { source: string; target: string; kind?: string; weight?: number };
type GraphDataLike = { nodes: GraphNodeLike[]; links: GraphLinkLike[] };
type StepDirection = "up" | "down" | "left" | "right" | "next" | "previous";

import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import { oneLine } from "./text-safety";

/**
 * What the host wires: getters over the SAME data and controlled state it
 * passes to fancy-graph's `<GraphView>` / `<GraphView3D>`, plus the view
 * handle's camera methods. There is deliberately no way to hand the bridge a
 * data setter: agents move the view, they never change the app's graph.
 */
export type GraphBridgeAdapter = {
  getGraph: () => GraphDataLike;
  getSelected: () => string | null;
  setSelected: (id: string | null) => void;
  /** The keyboard / gamepad focus (`focused` / `onFocusedChange`). */
  getFocused?: () => string | null;
  setFocused?: (id: string | null) => void;
  /** The view handle's `stepFocus`. */
  stepFocus?: (direction: StepDirection) => string | null;
  /** The view handle's `flyTo`. */
  flyTo?: (id: string) => void;
  /** The view handle's `fit` (no ids: the whole graph). */
  fit?: (ids?: string[]) => void;
  /** The view's `search` prop. */
  getSearch?: () => string;
  setSearch?: (query: string) => void;
};

export type GraphBridgeLimits = {
  /** Nodes per list page. Default 100. */
  maxListed: number;
  /** Links listed per node. Default 50. */
  maxNeighbors: number;
  /** Characters per label returned to the agent. Default 120. */
  maxLabelLength: number;
  /** Characters accepted in a search query. Default 200. */
  maxQueryLength: number;
  /** Ids accepted by graph_fit. Default 500. */
  maxFitIds: number;
};

export type GraphBridgeOptions = {
  adapter: GraphBridgeAdapter;
  agent?: { id: string; name?: string; color?: string };
  limits?: Partial<GraphBridgeLimits>;
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };
const DEFAULT_LIMITS: GraphBridgeLimits = { maxListed: 100, maxNeighbors: 50, maxLabelLength: 120, maxQueryLength: 200, maxFitIds: 500 };
const DIRECTIONS: StepDirection[] = ["up", "down", "left", "right", "next", "previous"];

const int = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : fallback);

/**
 * registerGraphBridge — opt-in, view-only MCP tools over a fancy-graph view:
 * read the graph and the view state, then select, focus, step along links,
 * fly, fit and search. No tool writes nodes or links; text the agent did not
 * author (labels, kinds) comes back on one line and capped.
 */
export function registerGraphBridge(host: ToolHost, options: GraphBridgeOptions): Bridge {
  const { adapter } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const limits: GraphBridgeLimits = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(DEFAULT_LIMITS) as (keyof GraphBridgeLimits)[]) {
    const v = options.limits?.[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) limits[k] = Math.floor(v);
  }
  const bridgeId = "graph";
  const disposers: Array<() => void> = [];
  const text = (v: unknown) => oneLine(v, limits.maxLabelLength);

  // Rebuilt only when the host hands over a different graph object.
  let cached: { data: GraphDataLike; ids: Set<string>; degree: Map<string, number> } | null = null;
  const index = () => {
    const data = adapter.getGraph();
    if (cached?.data === data) return cached;
    const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
    const ids = new Set(nodes.filter((n) => typeof n?.id === "string").map((n) => n.id));
    const degree = new Map<string, number>();
    for (const l of Array.isArray(data?.links) ? data.links : []) {
      if (!ids.has(l?.source) || !ids.has(l?.target) || l.source === l.target) continue;
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
    }
    cached = { data, ids, degree };
    return cached;
  };
  const nodeId = (v: unknown): string | null | undefined => {
    if (v === null) return null;
    if (typeof v !== "string") return undefined;
    return index().ids.has(v) ? v : undefined;
  };

  const reg = (name: string, description: string, properties: Record<string, unknown>, required: string[], handler: (args: JsonObject) => unknown, activity = false) => {
    const wrapped = async (args: JsonObject) => {
      try {
        return await handler(args);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    };
    const final = activity
      ? wrapToolWithActivity(wrapped as never, {
          toolName: name,
          agent,
          kind: "graph",
          resolveTarget: ({ args }) => ({ kind: "graph", elementId: typeof (args as JsonObject)?.id === "string" ? ((args as JsonObject).id as string) : undefined }),
        })
      : wrapped;
    disposers.push(host.registerTool({ name, description, inputSchema: { type: "object", properties: properties as never, required, additionalProperties: false } }, final as never, { owner: bridgeId }));
  };

  // ───────────── Read ─────────────

  reg("graph_get_state", "The graph view: node and link counts, the selection, the focused node, and the search query.", {}, [], () => {
    const g = adapter.getGraph();
    const state = {
      nodeCount: Array.isArray(g?.nodes) ? g.nodes.length : 0,
      linkCount: Array.isArray(g?.links) ? g.links.length : 0,
      selected: adapter.getSelected(),
      focused: adapter.getFocused?.() ?? null,
      search: adapter.getSearch?.() ?? "",
    };
    return textResult(`${state.nodeCount} nodes, ${state.linkCount} links; selected ${state.selected ?? "none"}; focused ${state.focused ?? "none"}`, state);
  });

  reg(
    "graph_list_nodes",
    "List nodes, a page at a time: id, label, group and link count. Filter by `query` (label or id contains) and `group`.",
    { query: { type: "string" }, group: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } },
    [],
    (args) => {
      const g = adapter.getGraph();
      const { degree } = index();
      const q = typeof args.query === "string" ? args.query.slice(0, limits.maxQueryLength).toLowerCase() : "";
      const group = typeof args.group === "string" ? args.group : null;
      const all = (Array.isArray(g?.nodes) ? g.nodes : []).filter(
        (n) => typeof n?.id === "string" && (!group || n.group === group) && (!q || `${n.label ?? ""} ${n.id}`.toLowerCase().includes(q)),
      );
      const offset = int(args.offset, 0);
      const limit = Math.min(limits.maxListed, Math.max(1, int(args.limit, limits.maxListed)));
      const nodes = all.slice(offset, offset + limit).map((n) => ({ id: n.id, label: text(n.label ?? n.id), group: n.group === undefined ? null : text(n.group), degree: degree.get(n.id) ?? 0 }));
      const lines = nodes.map((n) => `- ${text(n.id)}: ${n.label}${n.group ? ` [${n.group}]` : ""} (${n.degree} links)`);
      return textResult(`${all.length} matching; showing ${nodes.length} from ${offset}.\n${lines.join("\n")}`, { total: all.length, offset, nodes });
    },
  );

  reg("graph_get_node", "One node: its label, group, and its links in a stable order with the node at the other end.", { id: { type: "string" } }, ["id"], (args) => {
    const id = nodeId(args.id);
    if (!id) return errorResult(`No node with id ${text(args.id)}`);
    const g = adapter.getGraph();
    const node = g.nodes.find((n) => n.id === id)!;
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const all = g.links.filter((l) => (l.source === id || l.target === id) && l.source !== l.target && byId.has(l.source) && byId.has(l.target));
    const neighbors = all.slice(0, limits.maxNeighbors).map((l) => {
      const other = l.source === id ? l.target : l.source;
      return { id: other, label: text(byId.get(other)?.label ?? other), direction: l.source === id ? "out" : "in", kind: l.kind === undefined ? null : text(l.kind) };
    });
    const out = { id, label: text(node.label ?? id), group: node.group === undefined ? null : text(node.group), linkCount: all.length, neighbors };
    const lines = neighbors.map((nb) => `- ${nb.direction === "out" ? "->" : "<-"} ${text(nb.id)}: ${nb.label}${nb.kind ? ` (${nb.kind})` : ""}`);
    return textResult(`${text(id)}: ${out.label}, ${all.length} links${all.length > neighbors.length ? ` (first ${neighbors.length})` : ""}\n${lines.join("\n")}`, out);
  });

  // ───────────── Move the view ─────────────

  reg("graph_select", "Select a node, or pass null to clear the selection.", { id: { type: ["string", "null"] } }, [], (args) => {
    const id = args.id === undefined ? null : nodeId(args.id);
    if (id === undefined) return errorResult(`No node with id ${text(args.id)}`);
    adapter.setSelected(id);
    return textResult(id ? `Selected ${text(id)}` : "Cleared the selection", { selected: id });
  }, true);

  reg("graph_focus", "Move the keyboard / gamepad focus to a node (null clears it). The view keeps the focused node in sight.", { id: { type: ["string", "null"] } }, [], (args) => {
    if (!adapter.setFocused) return textResult("Focus is not wired by this host.", { focused: null });
    const id = args.id === undefined ? null : nodeId(args.id);
    if (id === undefined) return errorResult(`No node with id ${text(args.id)}`);
    adapter.setFocused(id);
    return textResult(id ? `Focused ${text(id)}` : "Cleared the focus", { focused: id });
  }, true);

  reg(
    "graph_step_focus",
    "Move the focus along a link: up, down, left or right on screen, or next / previous through the focused node's links.",
    { direction: { type: "string", enum: DIRECTIONS } },
    ["direction"],
    (args) => {
      const dir = args.direction as StepDirection;
      if (!DIRECTIONS.includes(dir)) return errorResult(`direction must be one of ${DIRECTIONS.join(", ")}`);
      if (!adapter.stepFocus) return textResult("Stepping focus is not wired by this host.", { focused: null });
      const id = adapter.stepFocus(dir);
      return textResult(id ? `Focused ${text(id)}` : "Nothing to focus", { focused: id });
    },
    true,
  );

  reg("graph_fly_to", "Fly the camera to a node.", { id: { type: "string" } }, ["id"], (args) => {
    if (!adapter.flyTo) return textResult("Flying the camera is not wired by this host.", {});
    const id = nodeId(args.id);
    if (!id) return errorResult(`No node with id ${text(args.id)}`);
    adapter.flyTo(id);
    return textResult(`Flying to ${text(id)}`, { id });
  }, true);

  reg("graph_fit", "Fit the camera to some nodes, or to the whole graph when `ids` is omitted.", { ids: { type: "array", items: { type: "string" } } }, [], (args) => {
    if (!adapter.fit) return textResult("Fitting the camera is not wired by this host.", {});
    if (args.ids === undefined) {
      adapter.fit();
      return textResult("Fitted the whole graph", { ids: null });
    }
    if (!Array.isArray(args.ids)) return errorResult("ids must be an array of node ids");
    const ids = (args.ids as unknown[]).slice(0, limits.maxFitIds).map(nodeId).filter((v): v is string => typeof v === "string");
    if (!ids.length) return errorResult("None of those ids are nodes in this graph");
    adapter.fit(ids);
    return textResult(`Fitted ${ids.length} nodes`, { ids });
  }, true);

  reg("graph_search", "Highlight nodes whose label or id contains `query` (empty clears it). Returns the matching ids, best connected first.", { query: { type: "string" } }, ["query"], (args) => {
    const query = typeof args.query === "string" ? args.query.slice(0, limits.maxQueryLength) : "";
    adapter.setSearch?.(query);
    const g = adapter.getGraph();
    const { degree } = index();
    const q = query.trim().toLowerCase();
    const ids = q
      ? (Array.isArray(g?.nodes) ? g.nodes : [])
          .filter((n) => typeof n?.id === "string" && `${n.label ?? ""} ${n.id}`.toLowerCase().includes(q))
          .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
          .slice(0, limits.maxListed)
          .map((n) => n.id)
      : [];
    return textResult(`${ids.length} matching${adapter.setSearch ? "" : " (highlighting is not wired by this host)"}: ${ids.map(text).join(", ")}`, { ids });
  }, true);

  return {
    id: bridgeId,
    title: "Graph",
    dispose: () => {
      for (const d of disposers) d();
    },
  };
}
