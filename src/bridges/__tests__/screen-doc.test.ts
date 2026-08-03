import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerScreenDocBridge, SCREEN_TEXT_NODE_TYPE, type ScreenDocNode } from "../screen-doc";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import type { DocTree } from "@particle-academy/fancy-doc-commons";
import type { JsonObject } from "../../mcp/types";

/**
 * The shape fancy-screens' `toDocTree` produces for
 *
 *   { type: "Card", children: [
 *       { id: "title", type: "Heading", children: ["Hello"] },
 *       { type: "Text", children: ["anonymous"] } ] }
 *
 * — i.e. an authored id on the node the author meant to drive, minted ids
 * (flagged `synthetic`) everywhere else, and literal text as its own node.
 */
function screenTree(): DocTree<ScreenDocNode> {
  return {
    nodes: {
      ":root": { id: ":root", type: "Card", parent: null, order: "a0", props: {}, synthetic: true },
      title: { id: "title", type: "Heading", parent: ":root", order: "a0", props: { size: "xl" } },
      ":0.0": { id: ":0.0", type: SCREEN_TEXT_NODE_TYPE, parent: "title", order: "a0", props: { value: "Hello" }, synthetic: true },
      ":1": { id: ":1", type: "Text", parent: ":root", order: "a1", props: {}, synthetic: true },
      ":1.0": { id: ":1.0", type: SCREEN_TEXT_NODE_TYPE, parent: ":1", order: "a0", props: { value: "anonymous" }, synthetic: true },
    },
  };
}

function setup(initial: DocTree<ScreenDocNode> = screenTree()) {
  let tree = initial;
  const host = new ToolRegistry();
  const bridge = registerScreenDocBridge(host, {
    adapter: { get: () => tree, set: (n) => { tree = n; }, screenId: "checkout" },
  });
  const call = async (name: string, args: JsonObject = {}) => {
    const r = await host.callTool(name, args);
    const first = r.content?.[0];
    return {
      isError: r.isError,
      text: first && first.type === "text" ? first.text : "",
      sc: (r.structuredContent ?? {}) as Record<string, unknown>,
    };
  };
  return { host, bridge, call, tree: () => tree };
}

describe("registerScreenDocBridge", () => {
  beforeEach(() => resetAllUndoStacks());

  it("exposes the generic doc tool set plus the screen-specific ones", () => {
    const { host } = setup();
    const names = host.listTools().map((t) => t.name);
    for (const v of [
      "screen_describe", "screen_get", "screen_list", "screen_get_node",
      "screen_add", "screen_update", "screen_remove", "screen_move",
      "screen_set_text", "screen_addressable", "screen_confirm", "screen_reject",
    ]) expect(names).toContain(v);
    expect(names).toContain("agent_undo");
  });

  it("prefixes tools per screen, so two doc-driven screens can coexist", () => {
    const host = new ToolRegistry();
    let a: DocTree<ScreenDocNode> = { nodes: {} };
    let b: DocTree<ScreenDocNode> = { nodes: {} };
    registerScreenDocBridge(host, { adapter: { get: () => a, set: (n) => { a = n; } }, surface: "screen_cart" });
    registerScreenDocBridge(host, { adapter: { get: () => b, set: (n) => { b = n; } }, surface: "screen_pay" });

    const names = host.listTools().map((t) => t.name);
    expect(names).toContain("screen_cart_add");
    expect(names).toContain("screen_pay_add");
  });

  // ── The whole point: which ids an agent may keep ────────────────────────────

  it("offers ONLY authored ids as addressable, and says how many it withheld", async () => {
    const { call } = setup();
    const res = await call("screen_addressable");

    expect(res.sc.addressable).toEqual([{ id: "title", type: "Heading" }]);
    expect(res.sc.syntheticCount).toBe(4);
  });

  it("flags a positional id in every listing, so it is never mistaken for a handle", async () => {
    const { call } = setup();
    const listed = (await call("screen_list", { parent: ":root" })).sc.nodes as Array<Record<string, unknown>>;

    expect(listed.find((n) => n.id === "title")?.synthetic).toBeUndefined();
    expect(listed.find((n) => n.id === ":1")?.synthetic).toBe(true);
  });

  it("shows literal text inline rather than making the agent open the text node", async () => {
    const { call } = setup();
    const listed = (await call("screen_list", { parent: "title" })).sc.nodes as Array<Record<string, unknown>>;

    expect(listed[0]?.text).toBe("Hello");
  });

  it("marks a node the AGENT added as authored — otherwise it could not address its own work", async () => {
    const { call, tree } = setup();
    const id = (await call("screen_add", { type: "Button", parent: ":root", props: { color: "violet" } })).sc.id as string;

    expect(tree().nodes[id]?.synthetic).toBeUndefined();
    expect((await call("screen_addressable")).sc.addressable).toContainEqual({ id, type: "Button" });
  });

  it("lets the agent name the handle it is about to depend on", async () => {
    const { call, tree } = setup();
    await call("screen_add", { type: "Button", parent: ":root", id: "submit" });

    expect(tree().nodes.submit?.type).toBe("Button");
  });

  it("refuses to add over an existing id instead of silently replacing that node", async () => {
    const { call, tree } = setup();
    const res = await call("screen_add", { type: "Button", parent: ":root", id: "title" });

    expect(res.isError).toBe(true);
    expect(tree().nodes.title?.type).toBe("Heading");
  });

  // ── set_text: the reserved #text type stays the bridge's problem ────────────

  it("retexts an element by the element's own id", async () => {
    const { call, tree } = setup();
    await call("screen_set_text", { id: "title", text: "Goodbye" });

    expect(tree().nodes[":0.0"]?.props.value).toBe("Goodbye");
  });

  it("accepts the text node's id too, since a read may well have returned that", async () => {
    const { call, tree } = setup();
    await call("screen_set_text", { id: ":0.0", text: "Direct" });

    expect(tree().nodes[":0.0"]?.props.value).toBe("Direct");
  });

  it("gives text to an element that had none", async () => {
    const { call, tree } = setup();
    const id = (await call("screen_add", { type: "Button", parent: ":root", id: "cta" })).sc.id as string;
    await call("screen_set_text", { id, text: "Buy" });

    const child = Object.values(tree().nodes).find((n) => n.parent === "cta");
    expect(child?.type).toBe(SCREEN_TEXT_NODE_TYPE);
    expect(child?.props.value).toBe("Buy");
  });

  it("errors on an ambiguous target rather than picking one and looking like it worked", async () => {
    const tree = screenTree();
    tree.nodes[":0.1"] = { id: ":0.1", type: SCREEN_TEXT_NODE_TYPE, parent: "title", order: "a1", props: { value: " world" }, synthetic: true };
    const { call } = setup(tree);

    const res = await call("screen_set_text", { id: "title", text: "nope" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/2 text children/);
  });

  // ── Inherited from the substrate, asserted because a screen host relies on it ─

  it("undoes a retext through the shared undo stack", async () => {
    const { call, tree } = setup();
    await call("screen_set_text", { id: "title", text: "Goodbye" });
    await call("agent_undo", {});

    expect(tree().nodes[":0.0"]?.props.value).toBe("Hello");
  });

  it("removes a subtree and restores it whole", async () => {
    const { call, tree } = setup();
    await call("screen_remove", { id: "title" });
    expect(tree().nodes.title).toBeUndefined();
    expect(tree().nodes[":0.0"]).toBeUndefined();

    await call("agent_undo", {});
    expect(tree().nodes.title?.type).toBe("Heading");
    expect(tree().nodes[":0.0"]?.props.value).toBe("Hello");
  });

  it("stages a write when the host asks for confirmation, and applies nothing until confirmed", async () => {
    let tree = screenTree();
    const host = new ToolRegistry();
    registerScreenDocBridge(host, {
      adapter: { get: () => tree, set: (n) => { tree = n; } },
      stagePolicy: (op) => (op.t === "remove" ? "confirm" : "auto"),
    });
    const call = async (n: string, a: JsonObject = {}) =>
      ((await host.callTool(n, a)).structuredContent ?? {}) as Record<string, unknown>;

    const staged = await call("screen_remove", { id: "title" });
    expect(staged.staged).toBe(true);
    expect(tree.nodes.title).toBeDefined();

    // The node id and the pending id are both reported, under separate keys —
    // a staged remove used to overwrite the latter with the former, which made
    // it unconfirmable.
    expect(staged.id).toBe("title");
    await call("screen_confirm", { id: staged.pendingId as string });
    expect(tree.nodes.title).toBeUndefined();
  });

  it("unregisters every tool it added, including the screen-specific ones", () => {
    const { host, bridge } = setup();
    bridge.dispose();

    const names = host.listTools().map((t) => t.name);
    expect(names).not.toContain("screen_addressable");
    expect(names).not.toContain("screen_set_text");
    expect(names).not.toContain("screen_add");
  });
});
