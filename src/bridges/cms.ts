/**
 * registerCmsBridge — the greenfield CMS agent bridge, built entirely on
 * {@link registerDocBridge}. cms had NO bridge before (its op-spine was
 * agent-ready but unwired); this is the §8-decided "build registerCmsBridge on
 * registerDocBridge BEFORE deprecating ScreenSchema" step.
 *
 * A CMS page is a `DocTree<StyledNode>` (fancy-doc-commons): the generic bridge
 * supplies `cms_describe/get/list/get_node` + `cms_add/update/remove/move` +
 * undo/activity/staging for free; this layer adds the two domain ops a page
 * needs — `cms_set_style` (per-node base StyleProps) and `cms_set_layout` — and a
 * reducer that handles them alongside the substrate tree ops.
 */
import type { ToolHost } from "../mcp/tool-host";
import type { Bridge } from "./types";
import { registerDocBridge, type DocAdapter } from "./doc";
import {
  treeReducer,
  type DocReducer,
  type DocTree,
  type LayoutMode,
  type StyledNode,
  type StyleProps,
  type TreeOp,
  type StagePolicy,
} from "@particle-academy/fancy-doc-commons";

/** The CMS op union: the substrate tree ops + per-node style/layout. */
export type CmsOp =
  | TreeOp<StyledNode>
  | { t: "set_style"; id: string; patch: Partial<StyleProps> }
  | { t: "set_layout"; id: string; layout?: LayoutMode };

/** A pure reducer over a `DocTree<StyledNode>` handling tree ops + style/layout. */
export function cmsReducer(): DocReducer<DocTree<StyledNode>, CmsOp> {
  const base = treeReducer<StyledNode>();
  return {
    reduce(doc, op) {
      if (op.t === "set_style") {
        const node = doc.nodes[op.id];
        if (!node) return doc;
        return { nodes: { ...doc.nodes, [op.id]: { ...node, style: { ...node.style, base: { ...node.style.base, ...op.patch } } } } };
      }
      if (op.t === "set_layout") {
        const node = doc.nodes[op.id];
        if (!node) return doc;
        return { nodes: { ...doc.nodes, [op.id]: { ...node, layout: op.layout } } };
      }
      return base.reduce(doc, op);
    },
    invert(doc, op) {
      if (op.t === "set_style") {
        const node = doc.nodes[op.id];
        if (!node) return [];
        const prev: Partial<StyleProps> = {};
        for (const k in op.patch) (prev as Record<string, unknown>)[k as keyof StyleProps] = node.style.base[k as keyof StyleProps];
        return [{ t: "set_style", id: op.id, patch: prev }];
      }
      if (op.t === "set_layout") {
        const node = doc.nodes[op.id];
        if (!node) return [];
        return [{ t: "set_layout", id: op.id, layout: node.layout }];
      }
      return base.invert(doc, op) as CmsOp[];
    },
  };
}

export interface CmsBridgeOptions {
  adapter: DocAdapter<StyledNode>;
  agent?: { id: string; name?: string; color?: string };
  /** Auto-apply vs. confirm per op (trust-but-verify). Default: auto. */
  stagePolicy?: StagePolicy<CmsOp>;
  onPending?: (staged: { id: string; op: CmsOp; label: string }) => void;
}

/** Register the CMS bridge (prefix `cms_`) over a `DocTree<StyledNode>`. */
export function registerCmsBridge(host: ToolHost, options: CmsBridgeOptions): Bridge {
  return registerDocBridge<StyledNode, CmsOp>(host, {
    adapter: options.adapter,
    surface: "cms",
    agent: options.agent,
    reducer: cmsReducer(),
    stagePolicy: options.stagePolicy,
    onPending: options.onPending,
    // New nodes get an empty base style so they satisfy StyledNode.
    makeNode: ({ id, type, parent, order }, props) => ({ id, type, parent, order, props, style: { base: {} } }),
    describeNode: (n) => ({ id: n.id, type: n.type, parent: n.parent, layout: n.layout }),
    opTools: [
      {
        verb: "set_style",
        description: "Merge a StyleProps patch into a node's base style (color, background, padding, fontSize, gap, …).",
        properties: { id: { type: "string" }, patch: { type: "object", description: "Partial StyleProps." } },
        required: ["id", "patch"],
        build: (args, tree) => {
          const id = String(args.id);
          if (!tree.nodes[id]) return { error: `No node ${id}` };
          return { t: "set_style", id, patch: (args.patch && typeof args.patch === "object" ? args.patch : {}) as Partial<StyleProps> };
        },
        targetId: (args) => String(args.id),
      },
      {
        verb: "set_layout",
        description: "Set a container node's layout mode (free | stack | grid).",
        properties: { id: { type: "string" }, layout: { type: "string", enum: ["free", "stack", "grid"] } },
        required: ["id"],
        build: (args, tree) => {
          const id = String(args.id);
          if (!tree.nodes[id]) return { error: `No node ${id}` };
          return { t: "set_layout", id, layout: args.layout as LayoutMode | undefined };
        },
        targetId: (args) => String(args.id),
      },
    ],
  });
}
