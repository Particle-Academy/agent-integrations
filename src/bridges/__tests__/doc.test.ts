import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerCmsBridge } from "../cms";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import type { DocTree, StyledNode, StagePolicy } from "@particle-academy/fancy-doc-commons";
import type { CmsOp } from "../cms";
import type { JsonObject } from "../../mcp/types";

function setup(stagePolicy?: StagePolicy<CmsOp>) {
  let tree: DocTree<StyledNode> = { nodes: {} };
  const host = new ToolRegistry();
  registerCmsBridge(host, { adapter: { get: () => tree, set: (n) => { tree = n; } }, stagePolicy });
  const call = async (name: string, args: JsonObject = {}) => {
    const r = await host.callTool(name, args);
    return { isError: r.isError, sc: (r.structuredContent ?? {}) as Record<string, unknown> };
  };
  return { host, call, tree: () => tree };
}

describe("registerCmsBridge (on registerDocBridge)", () => {
  beforeEach(() => resetAllUndoStacks());

  it("generates the uniform tool set + unconditional undo tools", () => {
    const { host } = setup();
    const names = host.listTools().map((t) => t.name);
    for (const v of [
      "cms_describe", "cms_get", "cms_list", "cms_get_node",
      "cms_add", "cms_update", "cms_remove", "cms_move",
      "cms_set_style", "cms_set_layout", "cms_confirm", "cms_reject",
    ]) expect(names).toContain(v);
    expect(names).toContain("agent_undo");
    expect(names).toContain("agent_redo");
    expect(names).toContain("agent_history");
  });

  it("add / set_style / remove mutate the tree; agent_undo reverts (subtree + style restored)", async () => {
    const { call, tree } = setup();
    const add = await call("cms_add", { type: "text", props: { content: "hi" } });
    const id = add.sc.id as string;
    expect(tree().nodes[id]?.type).toBe("text");
    expect(tree().nodes[id]?.style).toEqual({ base: {} });

    await call("cms_set_style", { id, patch: { color: "#f00" } });
    expect(tree().nodes[id]?.style.base.color).toBe("#f00");

    // add a child, then remove the parent → subtree gone
    const child = await call("cms_add", { type: "box", parent: id });
    expect(tree().nodes[child.sc.id as string]?.parent).toBe(id);
    await call("cms_remove", { id });
    expect(tree().nodes[id]).toBeUndefined();
    expect(Object.keys(tree().nodes).length).toBe(0);

    // undo the remove → parent + child + the earlier style all come back
    await call("agent_undo");
    expect(tree().nodes[id]?.style.base.color).toBe("#f00");
    expect(tree().nodes[child.sc.id as string]).toBeTruthy();
  });

  it("stagePolicy 'confirm' stages ops until cms_confirm (and cms_reject discards)", async () => {
    const { call, tree } = setup(() => "confirm");
    const add = await call("cms_add", { type: "box" });
    expect(add.sc.staged).toBe(true);
    expect(Object.keys(tree().nodes).length).toBe(0); // nothing applied yet

    await call("cms_confirm", { id: add.sc.id as string });
    expect(Object.keys(tree().nodes).length).toBe(1); // now applied

    const add2 = await call("cms_add", { type: "box" });
    await call("cms_reject", { id: add2.sc.id as string });
    expect(Object.keys(tree().nodes).length).toBe(1); // rejected → still 1
  });
});
