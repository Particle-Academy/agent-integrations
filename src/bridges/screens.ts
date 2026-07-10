import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";
import type { AgentTarget } from "../presence/types";

/**
 * Loose snapshot of a screen — what's in fancy-screens' ScreenMeta plus
 * the host's optional activity status. Kept here so this bridge has no
 * hard dep on fancy-screens.
 */
export type ScreenSnapshot = {
  id: string;
  title?: string;
  /** Whether this screen is the one the human / agent is looking at. */
  active: boolean;
  /** Optional category / kind (e.g. "form", "whiteboard"). */
  kind?: string;
};

/**
 * Spec for a dynamically-created screen. The host's `createScreen`
 * implementation looks up `kind` in its template registry and instantiates
 * the matching surface (form / whiteboard / sheet / chart / markdown / etc.).
 */
export type ScreenCreateSpec = {
  id: string;
  title?: string;
  /** Template kind. Hosts decide the catalog. */
  kind: string;
  /** Template-specific config. Form: { fields }. Sheet: { headers }. etc. */
  config?: Record<string, unknown>;
};

/**
 * Adapter exposes the host's screen-navigation surface to the bridge.
 * Hosts wire this up against react-router, a custom tab state, or the
 * fancy-screens registry — wherever "current screen" lives.
 *
 * The optional create / destroy / update hooks let agents author screens
 * dynamically against a host-defined template catalog.
 */
export type ScreensBridgeAdapter = {
  /** List every available screen. */
  listScreens: () => ScreenSnapshot[];
  /** Read which screen is currently active. */
  getActive: () => string | null;
  /** Navigate to a screen by id. Host updates router / tab state. */
  setActive: (screenId: string) => void;
  /** Optional: instantiate a new screen from a template + config. */
  createScreen?: (spec: ScreenCreateSpec) => void;
  /** Optional: remove a previously-created screen. */
  destroyScreen?: (screenId: string) => void;
  /** Optional: shallow-merge new config into an existing screen. */
  updateScreenContent?: (screenId: string, partial: Record<string, unknown>) => void;
  /** Optional: enumerate the kinds the host knows how to instantiate. */
  listKinds?: () => Array<{ kind: string; label?: string; description?: string; configSchema?: unknown }>;
};

export type ScreensBridgeOptions = {
  adapter: ScreensBridgeAdapter;
  agent?: { id: string; name?: string; color?: string };
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };

/**
 * registerScreensBridge — top-level navigation bridge so agents can
 * switch between screens (`screens_navigate`) and discover what surfaces
 * exist (`screens_list`, `screens_describe_active`).
 *
 * Pair with the per-surface bridges (whiteboard, form, sheet, etc.) so
 * the agent has both navigation and per-screen control.
 */
export function registerScreensBridge(
  host: ToolHost,
  options: ScreensBridgeOptions,
): Bridge {
  const { adapter } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const disposers: Array<() => void> = [];

  // agent_undo / agent_redo / agent_history are registered whenever any bridge
  // mounts, so undo availability doesn't hinge on which bridges are co-present.
  ensureUndoToolsRegistered(host, { defaultAgentId: agent.id });

  const target = (screenId: string): AgentTarget => ({
    kind: "screens",
    screenId,
    label: `Screen ${screenId}`,
  });

  const reg = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: JsonObject) => Promise<any> | any,
    isMutation: boolean,
    targetFromArgs?: (args: JsonObject) => AgentTarget,
  ) => {
    const wrapped = async (args: JsonObject) => {
      try { return await handler(args); }
      catch (e) { return errorResult(e instanceof Error ? e.message : String(e)); }
    };
    const final = isMutation
      ? wrapToolWithActivity(wrapped, {
          toolName: name, agent, kind: "screens",
          resolveTarget: ({ args }) => targetFromArgs?.(args) ?? null,
        })
      : wrapped;
    disposers.push(
      host.registerTool(
        { name, description, inputSchema: { type: "object", properties: properties as any, required, additionalProperties: false } },
        final as any,
      ),
    );
  };

  reg(
    "screens_list",
    "List every screen the host has registered. Returns id, title, active flag, and optional kind.",
    {},
    [],
    () => {
      const screens = adapter.listScreens();
      const text = screens
        .map((s) => `${s.active ? "▸" : " "} ${s.id}${s.title ? ` — ${s.title}` : ""}${s.kind ? ` [${s.kind}]` : ""}`)
        .join("\n");
      return textResult(text || "(no screens)", { screens, active: adapter.getActive() });
    },
    false,
  );

  reg(
    "screens_describe_active",
    "Get the currently-active screen id (or null).",
    {},
    [],
    () => {
      const active = adapter.getActive();
      return textResult(active ?? "(none)", { active });
    },
    false,
  );

  reg(
    "screens_list_kinds",
    "List the screen kinds (templates) the host knows how to instantiate. Use this before screens_create to know what's available.",
    {},
    [],
    () => {
      if (!adapter.listKinds) return errorResult("Host did not register a kind catalog. Cannot create screens dynamically.");
      const kinds = adapter.listKinds();
      const text = kinds.map((k) => `${k.kind}${k.label ? ` — ${k.label}` : ""}${k.description ? ` (${k.description})` : ""}`).join("\n");
      return textResult(text || "(no kinds registered)", kinds);
    },
    false,
  );

  reg(
    "screens_create",
    "Instantiate a new screen from a template kind + config. Switches the active view to the new screen.",
    {
      id: { type: "string", description: "Stable screen id. Must be unique." },
      title: { type: "string" },
      kind: { type: "string", description: "Template kind — call screens_list_kinds for the catalog." },
      config: { type: "object", description: "Template-specific config (e.g. { fields: [...] } for a form)." },
    },
    ["id", "kind"],
    (args) => {
      if (!adapter.createScreen) return errorResult("Host did not provide createScreen.");
      const id = String(args.id);
      const kind = String(args.kind);
      if (adapter.listScreens().find((s) => s.id === id)) {
        return errorResult(`Screen ${id} already exists. Use screens_destroy first or pick a fresh id.`);
      }
      adapter.createScreen({
        id,
        title: typeof args.title === "string" ? args.title : undefined,
        kind,
        config: (args.config && typeof args.config === "object") ? args.config as Record<string, unknown> : undefined,
      });
      adapter.setActive(id);
      return textResult(`Created ${kind} screen "${id}"`, { id, kind });
    },
    true,
    (args) => target(String(args.id ?? "")),
  );

  reg(
    "screens_destroy",
    "Remove a previously-created screen. Active screen falls back to the first remaining one (or null).",
    { id: { type: "string" } },
    ["id"],
    (args) => {
      if (!adapter.destroyScreen) return errorResult("Host did not provide destroyScreen.");
      const id = String(args.id);
      if (!adapter.listScreens().find((s) => s.id === id)) {
        return errorResult(`No screen with id ${id}`);
      }
      adapter.destroyScreen(id);
      return textResult(`Destroyed screen ${id}`, { id });
    },
    true,
    (args) => target(String(args.id ?? "")),
  );

  reg(
    "screens_set_layout",
    "Change the layout of an existing composite screen. Layouts: 'single', 'split-h' (left/right), 'split-v' (top/bottom), 'grid-2x2', 'stack' (tabs).",
    {
      id: { type: "string" },
      layout: { type: "string", enum: ["single", "split-h", "split-v", "grid-2x2", "stack"] },
    },
    ["id", "layout"],
    (args) => {
      if (!adapter.updateScreenContent) return errorResult("Host did not provide updateScreenContent.");
      adapter.updateScreenContent(String(args.id), { layout: String(args.layout) });
      return textResult(`Layout of ${args.id} → ${args.layout}`, { id: args.id, layout: args.layout });
    },
    true,
    (args) => target(String(args.id ?? "")),
  );

  reg(
    "screens_update_content",
    "Merge new config into an existing screen (e.g. add a field to a form, append a sheet column, change chart series).",
    {
      id: { type: "string" },
      partial: { type: "object", description: "Shallow-merged into the screen's config." },
    },
    ["id", "partial"],
    (args) => {
      if (!adapter.updateScreenContent) return errorResult("Host did not provide updateScreenContent.");
      const id = String(args.id);
      const partial = (args.partial && typeof args.partial === "object") ? args.partial as Record<string, unknown> : {};
      adapter.updateScreenContent(id, partial);
      return textResult(`Updated content of ${id}`, { id });
    },
    true,
    (args) => target(String(args.id ?? "")),
  );

  reg(
    "screens_navigate",
    "Switch the human's view to a different screen. The host updates its router / tab state and re-renders.",
    { screen: { type: "string", description: "Screen id to activate." } },
    ["screen"],
    (args) => {
      const screenId = String(args.screen ?? "");
      const screens = adapter.listScreens();
      if (!screens.find((s) => s.id === screenId)) {
        return errorResult(`No screen registered with id "${screenId}". Call screens_list first.`);
      }
      adapter.setActive(screenId);
      return textResult(`Navigated to ${screenId}`, { screen: screenId });
    },
    true,
    (args) => target(String(args.screen ?? "")),
  );

  return {
    id: "screens",
    title: "Screens",
    dispose: () => { for (const d of disposers) d(); },
  };
}
