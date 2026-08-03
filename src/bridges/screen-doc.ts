/**
 * registerScreenDocBridge — an agent bridge over the CONTENT of one rendered
 * `<Screen doc={…}>` (fancy-screens ≥ 0.6), built on {@link registerDocBridge}.
 *
 * This is the other half of {@link registerScreensBridge}, and the halves are
 * not interchangeable. That one moves *between* screens and creates them from
 * host templates, treating a screen's contents as an opaque `config` blob. This
 * one addresses the nodes *inside* one screen: read them, patch a prop, retext a
 * label, reparent a card.
 *
 * Until fancy-screens 0.6 there was no way to do that at all — `ScreenSchema`
 * nodes had no `id`, so an agent could emit a whole surface and then not touch
 * anything in it. That was a standing violation of the component contract's
 * stable-handles requirement, on the one shipped "agent emits a UI" path.
 *
 * A screen document is a plain `DocTree`, so the generic bridge supplies
 * describe/get/list/get_node + add/update/remove/move + undo + agent activity +
 * staged writes for free. What this layer adds is everything that is specific to
 * a screen being a rendered React tree:
 *
 * - **Synthetic ids are reported as such.** fancy-screens mints a position-derived
 *   id for any node the author left anonymous. It looks like a handle and is not
 *   one: insert a sibling above it and it points at a different node, silently.
 *   Every read here says which kind of id it handed back, and `screen_addressable`
 *   lists only the durable ones.
 * - **Literal text is a node**, not a prop, so that a string and an element can be
 *   siblings without losing their order. `screen_set_text` hides that from the
 *   agent, which otherwise has to know the reserved `#text` type to change a label.
 *
 * No dependency on fancy-screens — the contract is the `DocTree`, mirroring how
 * `bridges/screens.ts` keeps its own snapshot types loose.
 */
import { textResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { Bridge } from "./types";
import { registerDocBridge, type DocAdapter, type DocOpTool } from "./doc";
import {
  childrenOf,
  appendOrder,
  type DocNode,
  type StagePolicy,
  type TreeOp,
} from "@particle-academy/fancy-doc-commons";

/**
 * Reserved node type for a literal string child. Must match fancy-screens'
 * `TEXT_NODE_TYPE`; duplicated rather than imported to keep this bridge free of
 * a fancy-screens dependency.
 */
export const SCREEN_TEXT_NODE_TYPE = "#text";

/** A screen document node — a `DocNode` plus the minted-id flag. */
export interface ScreenDocNode extends DocNode {
  /**
   * True when fancy-screens minted this id because the author supplied none.
   * A synthetic id is derived from position, so it is not a durable handle.
   */
  synthetic?: boolean;
}

export type ScreenDocOp = TreeOp<ScreenDocNode>;

export interface ScreenDocBridgeOptions {
  adapter: DocAdapter<ScreenDocNode>;
  /**
   * Tool-name prefix. Default `"screen"` → `screen_add`, `screen_set_text`, …
   *
   * Tool names are global, so a host wiring more than one doc-driven screen at
   * once must give each a distinct prefix (`"screen_checkout"`).
   */
  surface?: string;
  agent?: { id: string; name?: string; color?: string };
  /** Auto-apply vs. confirm per op (trust-but-verify). Default: auto. */
  stagePolicy?: StagePolicy<ScreenDocOp>;
  onPending?: (staged: { id: string; op: ScreenDocOp; label: string }) => void;
}

/** Register the screen-content bridge (prefix `screen_`) over a screen's `DocTree`. */
export function registerScreenDocBridge(host: ToolHost, options: ScreenDocBridgeOptions): Bridge {
  const { adapter } = options;
  const surface = options.surface ?? "screen";

  const setText: DocOpTool<ScreenDocNode, ScreenDocOp> = {
    verb: "set_text",
    description:
      "Replace the literal text of an element node — the natural way to change a label, heading or paragraph. Pass the ELEMENT's id, not the text node's.",
    properties: {
      id: { type: "string", description: "Id of the element whose text to set." },
      text: { type: "string" },
    },
    required: ["id", "text"],
    build: (args, tree) => {
      const id = String(args.id);
      const node = tree.nodes[id];
      if (!node) return { error: `No node ${id}` };
      if (node.type === SCREEN_TEXT_NODE_TYPE) {
        return { t: "set_props", id, patch: { value: String(args.text) } };
      }

      const texts = childrenOf(tree, id).filter((c) => c.type === SCREEN_TEXT_NODE_TYPE);
      if (texts.length === 1) {
        return { t: "set_props", id: texts[0]!.id, patch: { value: String(args.text) } };
      }
      if (texts.length === 0) {
        // Nothing to retext, so give it text. The minted child is addressable in
        // its own right, which is what makes the follow-up edit possible.
        return {
          t: "insert",
          node: {
            id: `${id}-text`,
            type: SCREEN_TEXT_NODE_TYPE,
            parent: id,
            order: appendOrder(tree, id),
            props: { value: String(args.text) },
          },
        };
      }
      // Ambiguous on purpose: picking one would look like it worked.
      return {
        error: `Node ${id} has ${texts.length} text children (${texts.map((t) => t.id).join(", ")}) — set_text on the one you mean`,
      };
    },
    targetId: (args) => String(args.id),
  };

  const bridge = registerDocBridge<ScreenDocNode, ScreenDocOp>(host, {
    adapter,
    surface,
    agent: options.agent,
    stagePolicy: options.stagePolicy,
    onPending: options.onPending,
    // Anything the AGENT adds is authored by definition — it chose or was given
    // the id — so it must not inherit the synthetic flag from its neighbours.
    makeNode: ({ id, type, parent, order }, props) => ({ id, type, parent, order, props }),
    describeNode: (n) => ({
      id: n.id,
      type: n.type,
      parent: n.parent,
      ...(n.synthetic ? { synthetic: true } : {}),
      ...(n.type === SCREEN_TEXT_NODE_TYPE ? { text: String(n.props?.value ?? "") } : { props: Object.keys(n.props ?? {}) }),
    }),
    opTools: [setText],
  });

  // A read tool, so it lives here rather than in `opTools` (which are mutations).
  const disposeAddressable = host.registerTool(
    {
      name: `${surface}_addressable`,
      description:
        "List the node ids that are safe to remember and use later. Ids NOT listed here were minted from a node's position: they resolve today and silently point at a different node once a sibling is inserted above them. Address those in the same turn you read them, and never store one.",
      inputSchema: { type: "object", properties: {} as never, required: [], additionalProperties: false },
    },
    (async () => {
      const nodes = Object.values(adapter.get().nodes);
      const authored = nodes.filter((n) => !n.synthetic).map((n) => ({ id: n.id, type: n.type }));
      const syntheticCount = nodes.length - authored.length;

      return textResult(
        authored.length
          ? `${authored.length} addressable, ${syntheticCount} positional`
          : `no addressable ids — all ${syntheticCount} nodes are positional`,
        { addressable: authored, syntheticCount },
      );
    }) as never,
  );

  return {
    id: surface,
    title: "Screen content",
    dispose: () => {
      disposeAddressable();
      bridge.dispose();
    },
  };
}
