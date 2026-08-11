import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerSceneBridge } from "../scene";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import type { JsonObject } from "../../mcp/types";

function setup() {
  let scene: Record<string, unknown> = {
    objects: [{ id: "cube", kind: "box", position: [0, 0, 0] }],
    camera: { position: [0, 2, 5], target: [0, 0, 0] },
  };
  const host = new ToolRegistry();

  registerSceneBridge(host, {
    adapter: {
      id: "stage",
      title: "Stage",
      getScene: () => scene as never,
      setScene: (next) => {
        scene = next as Record<string, unknown>;
      },
    },
  });

  const call = async (name: string, args: JsonObject = {}) => {
    const r = await host.callTool(name, args);
    return { isError: r.isError, text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "" };
  };

  const objects = () => scene.objects as Array<{ id: string; kind?: string; position?: number[] }>;

  return { host, call, scene: () => scene, objects };
}

describe("registerSceneBridge", () => {
  beforeEach(() => resetAllUndoStacks());

  it("registers its tools", () => {
    const names = setup().host.listTools().map((t) => t.name);

    for (const t of ["scene_get_state", "scene_describe", "scene_add_object", "scene_update_object", "scene_delete_object", "scene_set_camera", "scene_set_background"]) {
      expect(names, `missing ${t}`).toContain(t);
    }
  });

  it("adds an object without disturbing the ones already there", async () => {
    // The bridge MINTS the id — the caller supplies a kind and gets the id
    // back. An agent cannot choose one, which is what keeps ids unique when
    // two agents add to the same scene.
    const { call, objects } = setup();

    await call("scene_add_object", { kind: "sphere", position: [1, 0, 0] });

    expect(objects()).toHaveLength(2);
    expect(objects()[0]!.id, "the existing object must survive").toBe("cube");
    expect(objects()[1]!.kind).toBe("sphere");
  });

  it("updates one object and leaves its siblings alone", async () => {
    const { call, objects } = setup();

    await call("scene_add_object", { kind: "sphere" });
    await call("scene_update_object", { id: "cube", position: [5, 5, 5] });

    expect(objects().find((o) => o.id === "cube")?.position).toEqual([5, 5, 5]);
    expect(objects().find((o) => o.kind === "sphere")).toBeDefined();
  });

  it("deletes by id", async () => {
    const { call, objects } = setup();

    await call("scene_delete_object", { id: "cube" });

    expect(objects().map((o) => o.id)).not.toContain("cube");
  });

  it("replaces the scene object rather than mutating what it read", async () => {
    // fancy-3d takes the Scene as a prop. Mutating in place skips the re-render,
    // so the agent's own read-back looks right while nothing on screen moves.
    const { call, scene } = setup();
    const before = scene();

    await call("scene_set_camera", { camera: { position: [9, 9, 9], target: [0, 0, 0] } });

    expect(scene()).not.toBe(before);
  });

  it("reports an unknown object id instead of silently doing nothing", async () => {
    const { call } = setup();

    expect((await call("scene_delete_object", { id: "nope" })).isError).toBe(true);
  });
});
