import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerCmsBridge, cmsReducer } from "../cms";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import type { JsonObject } from "../../mcp/types";

type Node = {
  id: string;
  type: string;
  parent: string | null;
  order: string;
  props: Record<string, unknown>;
  style: { base: Record<string, unknown> };
  layout?: string;
};

const tree = (): { nodes: Record<string, Node> } => ({
  nodes: {
    root: { id: "root", type: "page", parent: null, order: "a0", props: {}, style: { base: { color: "black" } } },
    hero: { id: "hero", type: "section", parent: "root", order: "a1", props: {}, style: { base: {} } },
  },
});

function setup() {
  let doc = tree();
  const host = new ToolRegistry();

  registerCmsBridge(host, {
    // `get` / `set`, not `getDoc` / `setDoc`. Worth stating: the first draft of
    // this file used the wrong names behind an `as never`, so the adapter
    // type-checked, every tool "succeeded", and nothing was ever written.
    adapter: {
      get: () => doc as never,
      set: (next) => {
        doc = next as typeof doc;
      },
    },
  });

  const call = async (name: string, args: JsonObject = {}) => {
    const r = await host.callTool(name, args);
    return { isError: r.isError, text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "" };
  };

  return { host, call, doc: () => doc };
}

describe("cmsReducer", () => {
  it("merges a style patch instead of replacing the base style", () => {
    // A CMS edit sets one property. Replacing `base` would silently drop every
    // other style the page already had.
    const r = cmsReducer();
    const next = r.reduce(tree() as never, { t: "set_style", id: "root", patch: { background: "red" } } as never) as ReturnType<typeof tree>;

    expect(next.nodes.root!.style.base).toEqual({ color: "black", background: "red" });
  });

  it("inverts a style patch back to the values it displaced", () => {
    // The invert has to capture the PREVIOUS values of exactly the keys the
    // patch touched — not the whole style, or undo would revert unrelated edits
    // made in between.
    const doc = tree();
    const op = { t: "set_style", id: "root", patch: { color: "blue" } } as never;
    const r = cmsReducer();

    const inverse = r.invert(doc as never, op);
    const after = r.reduce(doc as never, op);
    const restored = inverse.reduce((d, o) => r.reduce(d, o), after) as ReturnType<typeof tree>;

    expect(restored.nodes.root!.style.base.color).toBe("black");
  });

  it("captures undefined for a key that had no previous value", () => {
    // Undo of "set a style that wasn't set" must clear it, not leave it behind.
    const doc = tree();
    const r = cmsReducer();
    const op = { t: "set_style", id: "hero", patch: { padding: 8 } } as never;

    const restored = r.invert(doc as never, op).reduce((d, o) => r.reduce(d, o), r.reduce(doc as never, op)) as ReturnType<typeof tree>;

    expect(restored.nodes.hero!.style.base.padding).toBeUndefined();
  });

  it("leaves the tree untouched for an unknown node", () => {
    const doc = tree();
    const r = cmsReducer();

    expect(r.reduce(doc as never, { t: "set_style", id: "nope", patch: { color: "x" } } as never)).toBe(doc);
    expect(r.invert(doc as never, { t: "set_layout", id: "nope" } as never)).toEqual([]);
  });

  it("still handles the substrate tree ops it inherits", () => {
    // The CMS union extends TreeOp. If the reducer swallowed unknown ops rather
    // than delegating, add/remove/move would silently stop working.
    const r = cmsReducer();
    const next = r.reduce(tree() as never, { t: "remove", id: "hero" } as never) as ReturnType<typeof tree>;

    expect(next.nodes.hero).toBeUndefined();
    expect(next.nodes.root, "the rest of the tree survives").toBeDefined();
  });
});

describe("registerCmsBridge", () => {
  beforeEach(() => resetAllUndoStacks());

  it("registers the substrate doc tools plus the CMS-specific ones", () => {
    const names = setup().host.listTools().map((t) => t.name);

    for (const t of ["cms_set_style", "cms_set_layout"]) {
      expect(names, `missing ${t}`).toContain(t);
    }
    // Inherited from registerDocBridge — the whole reason this bridge is thin.
    expect(names.some((n) => n.startsWith("cms_") && n.includes("describe"))).toBe(true);
    expect(names).toContain("agent_undo");
  });

  it("sets a style through the tool and merges it", async () => {
    const { call, doc } = setup();

    await call("cms_set_style", { id: "root", patch: { background: "red" } });

    expect(doc().nodes.root!.style.base).toEqual({ color: "black", background: "red" });
  });

  it("sets a layout", async () => {
    const { call, doc } = setup();

    await call("cms_set_layout", { id: "hero", layout: "row" });

    expect(doc().nodes.hero!.layout).toBe("row");
  });

  it("refuses an unknown node rather than writing nothing and reporting success", async () => {
    const { call } = setup();

    expect((await call("cms_set_style", { id: "nope", patch: { color: "x" } })).isError).toBe(true);
  });
});
