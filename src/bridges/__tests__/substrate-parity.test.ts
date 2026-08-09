import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerCmsBridge } from "../cms";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import { childrenOf, roots, treeReducer, type DocNode, type DocTree } from "@particle-academy/fancy-doc-commons";
import { emptyDoc, childrenOf as cmsChildrenOf, reduce as cmsReduce, rootIds } from "@particle-academy/fancy-cms-ui";
import { toDocTree } from "@particle-academy/fancy-screens";
import type { JsonObject } from "../../mcp/types";

/**
 * The "one document substrate" claim, asserted against the REAL packages rather
 * than by inspection.
 *
 * `fancy-cms-ui` and `fancy-screens` are supposed to read and write the *same*
 * node / tree / op types, so that one generic `registerDocBridge` drives either
 * one. That claim is easy to state and easy to quietly break — each package has
 * its own reducer, and two reducers that agree today can disagree on one edge
 * (ordering, cascade, a no-op guard) without anything failing, because each
 * package's own suite only ever exercises its own.
 *
 * These tests import the published packages, so a divergence in either one
 * fails here. `fancy-cms-ui` and `fancy-screens` are devDependencies for exactly
 * that reason — nothing at runtime depends on them.
 */

/** A real CMS document, built by the CMS's own factory. */
function cmsDoc() {
  return emptyDoc("p1");
}

/** The same three-node shape, as a plain doc-commons tree. */
function plainTree(): DocTree<DocNode> {
  return {
    nodes: {
      a: { id: "a", type: "section", parent: null, order: "a0", props: {} },
      b: { id: "b", type: "section", parent: null, order: "a1", props: {} },
      t: { id: "t", type: "text", parent: "a", order: "a0", props: {} },
    },
  };
}

function cmsTreeOf(): { doc: ReturnType<typeof cmsDoc> } {
  let doc = cmsDoc();
  for (const n of [
    { id: "a", type: "section", parent: null, order: "a0" },
    { id: "b", type: "section", parent: null, order: "a1" },
    { id: "t", type: "text", parent: "a", order: "a0" },
  ]) {
    doc = cmsReduce(doc, {
      t: "insert_node",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      node: { ...n, props: {}, style: { base: {} } } as any,
    });
  }
  return { doc };
}

describe("one document substrate: fancy-cms-ui and fancy-doc-commons agree", () => {
  it("a CMS document IS a DocTree — doc-commons walks it with no adaptation", () => {
    const { doc } = cmsTreeOf();

    // The whole point: doc-commons' own walkers, run against the CMS's own
    // document object. No toDocTree(), no mapping layer.
    expect(roots(doc).map((n) => n.id)).toEqual(["a", "b"]);
    expect(childrenOf(doc, "a").map((n) => n.id)).toEqual(["t"]);
    expect(childrenOf(doc, null).map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("the two packages' walkers return identical results", () => {
    // If these ever disagree, one of them is wrong and neither suite would say
    // so — each only tests itself.
    const { doc } = cmsTreeOf();

    // Two empty lists are equal, and prove nothing. Pin the content first.
    expect(childrenOf(doc, null).map((n) => n.id), "fixture built no roots").toEqual(["a", "b"]);
    expect(childrenOf(doc, "a").map((n) => n.id), "fixture built no children").toEqual(["t"]);

    expect(cmsChildrenOf(doc, null).map((n) => n.id)).toEqual(childrenOf(doc, null).map((n) => n.id));
    expect(cmsChildrenOf(doc, "a").map((n) => n.id)).toEqual(childrenOf(doc, "a").map((n) => n.id));
    expect(rootIds(doc)).toEqual(roots(doc).map((n) => n.id));
  });

  it("the same tree op produces the same ordering in both reducers", () => {
    // Ordering is where a divergence would actually bite, and it is the thing
    // two independent fractional-key implementations get subtly different.
    const base = treeReducer<DocNode>();
    const moved = base.reduce(plainTree(), { t: "move", id: "t", parent: "b", order: "a5" });

    const { doc } = cmsTreeOf();
    const cmsMoved = cmsReduce(doc, { t: "move_node", id: "t", parent: "b", order: "a5" });

    expect(childrenOf(moved, "b").map((n) => n.id)).toEqual(["t"]);
    expect(childrenOf(cmsMoved, "b").map((n) => n.id)).toEqual(["t"]);
    expect(childrenOf(cmsMoved, "a")).toEqual([]);
  });

  it("removing a parent cascades identically in both", () => {
    const base = treeReducer<DocNode>();
    const afterPlain = base.reduce(plainTree(), { t: "remove", id: "a" });

    const { doc } = cmsTreeOf();
    const afterCms = cmsReduce(doc, { t: "remove_node", id: "a" });

    expect(Object.keys(afterPlain.nodes).sort()).toEqual(["b"]);
    expect(Object.keys(afterCms.nodes).sort()).toEqual(["b"]);
  });

  it("a screens document and a CMS document are the same shape", () => {
    // fancy-screens reaches the substrate through toDocTree; the CMS IS one
    // already. Both have to satisfy the same structural contract, or
    // registerDocBridge could not drive both.
    const screenTree = toDocTree({
      id: "s1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      children: [{ id: "c1", type: "panel" }] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const { doc } = cmsTreeOf();

    for (const tree of [screenTree as DocTree<DocNode>, doc as unknown as DocTree<DocNode>]) {
      expect(tree.nodes, "every substrate document exposes a flat `nodes` map").toBeTypeOf("object");
      // An empty map would satisfy every per-node assertion below vacuously.
      expect(Object.keys(tree.nodes).length, "document has no nodes to check").toBeGreaterThan(0);

      for (const node of Object.values(tree.nodes)) {
        expect(node.id, "every node carries its own id").toBeTypeOf("string");
        expect(node, "every node carries a parent pointer (null for a root)").toHaveProperty("parent");
        expect(node.order, "every node carries a fractional order key").toBeTypeOf("string");
      }
    }
  });
});

describe("registerDocBridge drives a real CMS document", () => {
  beforeEach(() => resetAllUndoStacks());

  /**
   * The acceptance criterion in its own words: the generic bridge works against
   * a CMS document with no CMS-specific bridge. `registerCmsBridge` adds two
   * domain ops and nothing else — every tool exercised below comes from the
   * shared builder.
   */
  function setup() {
    let doc = cmsDoc() as unknown as DocTree<DocNode>;
    const host = new ToolRegistry();

    registerCmsBridge(host, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapter: { get: () => doc as any, set: (n) => { doc = n as unknown as DocTree<DocNode>; } },
    });

    const call = async (name: string, args: JsonObject = {}) => {
      const r = await host.callTool(name, args);
      return { isError: r.isError, sc: (r.structuredContent ?? {}) as Record<string, unknown> };
    };

    return { call, doc: () => doc };
  }

  it("adds, styles and moves nodes on a document the CMS itself created", async () => {
    const { call, doc } = setup();

    const hero = await call("cms_add", { type: "section", props: {} });
    const heroId = hero.sc.id as string;
    const text = await call("cms_add", { type: "text", parent: heroId, props: { content: "hi" } });
    const textId = text.sc.id as string;

    expect(doc().nodes[heroId]?.type).toBe("section");
    expect(childrenOf(doc(), heroId).map((n) => n.id)).toEqual([textId]);

    await call("cms_set_style", { id: textId, patch: { color: "#fff" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((doc().nodes[textId] as any).style.base.color).toBe("#fff");

    // And the CMS's own walker sees every one of those mutations, because the
    // bridge wrote into the CMS's actual document rather than a copy.
    expect(cmsChildrenOf(doc() as never, heroId).map((n) => n.id)).toEqual([textId]);
  });

  it("agent_undo reverts a bridge mutation on the real document", async () => {
    const { call, doc } = setup();

    const added = await call("cms_add", { type: "section", props: {} });
    const id = added.sc.id as string;
    expect(doc().nodes[id]).toBeTruthy();

    await call("agent_undo", {});
    expect(doc().nodes[id]).toBeUndefined();
  });
});
