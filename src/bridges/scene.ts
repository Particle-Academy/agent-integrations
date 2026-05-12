import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import type { AgentTarget } from "../presence/types";

/**
 * Loose Scene types — mirror the public surface of fancy-3d's Scene
 * descriptor (engine-agnostic JSON the package's adapters consume).
 */
export type SceneObjectKind = "box" | "sphere" | "cylinder" | "plane" | "screen" | "group" | "custom";

export type SceneObject = {
  id: string;
  kind: SceneObjectKind | string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  color?: string;
  /** Free-form per-kind config (e.g. text content for screens). */
  props?: Record<string, unknown>;
  children?: SceneObject[];
};

export type SceneCamera = {
  position?: [number, number, number];
  target?: [number, number, number];
  fov?: number;
};

export type SceneState = {
  objects: SceneObject[];
  camera?: SceneCamera;
  background?: string;
};

export type SceneBridgeAdapter = {
  id: string;
  title?: string;
  screenId?: string;
  getScene: () => SceneState;
  setScene: (next: SceneState) => void;
  /** Convenience: set just the camera without touching objects. */
  setCamera?: (next: SceneCamera) => void;
};

export type SceneBridgeOptions = {
  adapter: SceneBridgeAdapter;
  agent?: { id: string; name?: string; color?: string };
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };

/**
 * registerSceneBridge — schema-aware MCP access to a fancy-3d Scene.
 * Tools cover read, add/update/delete object, set camera, set background.
 */
export function registerSceneBridge(
  host: ToolHost,
  options: SceneBridgeOptions,
): Bridge {
  const { adapter } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const disposers: Array<() => void> = [];

  const target = (objectId?: string): AgentTarget => ({
    kind: "scene",
    screenId: adapter.screenId,
    elementId: objectId ? `${adapter.id}:${objectId}` : adapter.id,
    label: objectId ? `${adapter.title ?? adapter.id} → ${objectId}` : adapter.title ?? adapter.id,
  });

  const reg = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: JsonObject) => Promise<any> | any,
    isMutation: boolean,
    objectIdFromArgs?: (args: JsonObject) => string | undefined,
  ) => {
    const wrapped = async (args: JsonObject) => {
      try { return await handler(args); }
      catch (e) { return errorResult(e instanceof Error ? e.message : String(e)); }
    };
    const final = isMutation
      ? wrapToolWithActivity(wrapped, {
          toolName: name, agent, kind: "scene", screenId: adapter.screenId,
          resolveTarget: ({ args }) => target(objectIdFromArgs?.(args)),
        })
      : wrapped;
    disposers.push(
      host.registerTool(
        { name, description, inputSchema: { type: "object", properties: properties as any, required, additionalProperties: false } },
        final as any,
      ),
    );
  };

  const newId = (kind: string) => `${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  // ───────────── Read ─────────────

  reg(
    "scene_describe",
    "Describe the scene — object count, kinds, camera position.",
    {},
    [],
    () => {
      const scene = adapter.getScene();
      const summary = {
        id: adapter.id,
        objectCount: scene.objects.length,
        kinds: scene.objects.map((o) => o.kind),
        camera: scene.camera,
        background: scene.background,
      };
      return textResult(JSON.stringify(summary, null, 2), summary);
    },
    false,
  );

  reg(
    "scene_get_state",
    "Read the full SceneState (objects + camera + background).",
    {},
    [],
    () => {
      const scene = adapter.getScene();
      return textResult(JSON.stringify(scene, null, 2), scene);
    },
    false,
  );

  // ───────────── Mutations ─────────────

  reg(
    "scene_add_object",
    "Add an object to the scene root. Returns the new object's id.",
    {
      kind: { type: "string", description: "box | sphere | cylinder | plane | screen | group | custom kind" },
      position: { type: "array", description: "[x, y, z]" },
      rotation: { type: "array", description: "[x, y, z] euler" },
      scale: { type: "array", description: "[x, y, z]" },
      color: { type: "string" },
      props: { type: "object", description: "Per-kind config." },
    },
    ["kind"],
    (args) => {
      const obj: SceneObject = {
        id: newId(String(args.kind)),
        kind: String(args.kind),
        position: parseTriple(args.position),
        rotation: parseTriple(args.rotation),
        scale: parseTriple(args.scale),
        color: typeof args.color === "string" ? args.color : undefined,
        props: (args.props && typeof args.props === "object") ? args.props as Record<string, unknown> : undefined,
      };
      const scene = adapter.getScene();
      adapter.setScene({ ...scene, objects: [...scene.objects, obj] });
      return textResult(`Added ${obj.kind} ${obj.id}`, obj);
    },
    true,
    (args) => undefined, // id resolved from result.structuredContent.id
  );

  reg(
    "scene_update_object",
    "Update fields on an object. Only provided fields change.",
    {
      id: { type: "string" },
      position: { type: "array" },
      rotation: { type: "array" },
      scale: { type: "array" },
      color: { type: "string" },
      props: { type: "object" },
    },
    ["id"],
    (args) => {
      const id = String(args.id);
      const scene = adapter.getScene();
      const idx = scene.objects.findIndex((o) => o.id === id);
      if (idx === -1) return errorResult(`No object ${id}`);
      const orig = scene.objects[idx];
      const next: SceneObject = {
        ...orig,
        ...(args.position !== undefined ? { position: parseTriple(args.position) } : {}),
        ...(args.rotation !== undefined ? { rotation: parseTriple(args.rotation) } : {}),
        ...(args.scale !== undefined ? { scale: parseTriple(args.scale) } : {}),
        ...(args.color !== undefined ? { color: String(args.color) } : {}),
        ...(args.props && typeof args.props === "object" ? { props: { ...(orig.props ?? {}), ...(args.props as Record<string, unknown>) } } : {}),
      };
      const objects = [...scene.objects];
      objects[idx] = next;
      adapter.setScene({ ...scene, objects });
      return textResult(`Updated ${id}`, next);
    },
    true,
    (args) => String(args.id ?? ""),
  );

  reg(
    "scene_delete_object",
    "Remove an object from the scene root.",
    { id: { type: "string" } },
    ["id"],
    (args) => {
      const id = String(args.id);
      const scene = adapter.getScene();
      const next = scene.objects.filter((o) => o.id !== id);
      if (next.length === scene.objects.length) return errorResult(`No object ${id}`);
      adapter.setScene({ ...scene, objects: next });
      return textResult(`Deleted ${id}`);
    },
    true,
    (args) => String(args.id ?? ""),
  );

  reg(
    "scene_set_camera",
    "Move the camera. Pass any subset of position/target/fov.",
    {
      position: { type: "array", description: "[x, y, z]" },
      target: { type: "array", description: "[x, y, z] look-at point" },
      fov: { type: "number" },
    },
    [],
    (args) => {
      const scene = adapter.getScene();
      const next: SceneCamera = {
        ...(scene.camera ?? {}),
        ...(args.position !== undefined ? { position: parseTriple(args.position) } : {}),
        ...(args.target !== undefined ? { target: parseTriple(args.target) } : {}),
        ...(args.fov !== undefined ? { fov: Number(args.fov) } : {}),
      };
      if (adapter.setCamera) {
        adapter.setCamera(next);
      } else {
        adapter.setScene({ ...scene, camera: next });
      }
      return textResult(`Camera updated`, next);
    },
    true,
  );

  reg(
    "scene_set_background",
    "Change the scene background color (CSS color).",
    { color: { type: "string" } },
    ["color"],
    (args) => {
      const scene = adapter.getScene();
      adapter.setScene({ ...scene, background: String(args.color) });
      return textResult(`Background → ${args.color}`, { background: args.color });
    },
    true,
  );

  return {
    id: `scene:${adapter.id}`,
    title: adapter.title ?? adapter.id,
    dispose: () => { for (const d of disposers) d(); },
  };
}

function parseTriple(v: unknown): [number, number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 3) return undefined;
  const out = v.map((x) => Number(x));
  if (out.some((x) => !Number.isFinite(x))) return undefined;
  return out as [number, number, number];
}
