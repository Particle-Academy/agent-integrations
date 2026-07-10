// Loose types so this bridge builds standalone without a hard dep on
// @particle-academy/fancy-map. Hosts that use fancy-map pass its own
// MapMarker / MapView values straight through — the shapes match.
type LatLng = { lat: number; lng: number };
type MapView = { center: LatLng; zoom: number; bearing?: number; pitch?: number };
type MapMarker = {
  id: string;
  position: LatLng;
  label?: string;
  color?: string;
  icon?: string;
  draggable?: boolean;
  data?: Record<string, unknown>;
};

import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import type { AgentTarget as MapAgentTarget } from "../presence/types";
import { pushUndoEntry } from "../undo/undo-stack";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";

/**
 * Adapter the host provides — getters/setters over the SAME controlled state it
 * passes to fancy-map's `<Map>` (view, markers, selection), plus optional
 * `fitBounds` (from the map's onReady handle) and `setFollow` (drives the map's
 * `follow` prop so an agent can make the camera track a moving marker).
 */
export type MapBridgeAdapter = {
  getView: () => MapView;
  setView: (next: MapView) => void;
  getMarkers: () => MapMarker[];
  setMarkers: (next: MapMarker[] | ((prev: MapMarker[]) => MapMarker[])) => void;
  getSelected: () => string | null;
  setSelected: (id: string | null) => void;
  /** Fit the camera to points (wire to the `MapHandle.fitBounds` from `<Map onReady>`). */
  fitBounds?: (points: LatLng[], padding?: number) => void;
  /** Make the camera follow a marker as it moves (drives the map's `follow` prop). */
  setFollow?: (id: string | null) => void;
};

export type MapBridgeOptions = {
  adapter: MapBridgeAdapter;
  /** Identity tagged onto agent-authored markers. */
  agent?: { id: string; name?: string; color?: string };
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };

const num = (v: unknown, fallback?: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback ?? 0;
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/**
 * registerMapBridge — an MCP tool set over a fancy-map `<Map>`'s controlled
 * state, so a human and an agent cohabit one map. The agent moves the camera,
 * drops/updates/removes markers, selects, fits bounds, and follows a live
 * track; every mutation broadcasts AgentActivity (for presence) and pushes an
 * undo entry (so the human can step the agent back). Mirrors the whiteboard /
 * flow bridges in shape.
 */
export function registerMapBridge(host: ToolHost, options: MapBridgeOptions): Bridge {
  const { adapter } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const disposers: Array<() => void> = [];

  // Register agent_undo / agent_redo / agent_history once per host. Idempotent.
  ensureUndoToolsRegistered(host, { defaultAgentId: agent.id });

  const mTarget = (args: any, result: any): MapAgentTarget => ({
    kind: "map",
    elementId:
      (result?.structuredContent?.id as string | undefined) ?? (args?.id as string | undefined),
  });

  const reg = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: JsonObject) => Promise<any> | any,
    resolveTarget?: (args: JsonObject, result: any) => MapAgentTarget | null,
  ) => {
    const wrapped = async (args: JsonObject) => {
      try {
        return await handler(args);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    };
    const final = resolveTarget
      ? wrapToolWithActivity(wrapped, {
          toolName: name,
          agent: { id: agent.id, name: agent.name, color: agent.color },
          kind: "map",
          resolveTarget: ({ args, result }) => resolveTarget(args, result),
        })
      : wrapped;
    disposers.push(
      host.registerTool(
        {
          name,
          description,
          inputSchema: {
            type: "object",
            properties: properties as any,
            required,
            additionalProperties: false,
          },
        },
        final as any,
      ),
    );
  };

  // ───────────── Read ─────────────

  reg("map_get_state", "Get the map's camera, markers, and current selection.", {}, [], () => {
    const state = {
      view: adapter.getView(),
      markers: adapter.getMarkers(),
      selectedId: adapter.getSelected(),
    };
    return textResult(JSON.stringify(state, null, 2), state);
  });

  // ───────────── Camera ─────────────

  reg(
    "map_set_view",
    "Move the camera to an absolute position. Any omitted field is left unchanged.",
    {
      lat: { type: "number", description: "New center latitude." },
      lng: { type: "number", description: "New center longitude." },
      zoom: { type: "number", description: "New zoom level (higher = closer)." },
    },
    [],
    (args) => {
      const prev = adapter.getView();
      const next: MapView = {
        center: {
          lat: args.lat !== undefined ? num(args.lat) : prev.center.lat,
          lng: args.lng !== undefined ? num(args.lng) : prev.center.lng,
        },
        zoom: args.zoom !== undefined ? num(args.zoom) : prev.zoom,
      };
      adapter.setView(next);
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: "map",
        action: "map_set_view",
        label: `Moved camera to ${next.center.lat.toFixed(4)},${next.center.lng.toFixed(4)} z${next.zoom}`,
        undo: () => adapter.setView(prev),
        redo: () => adapter.setView(next),
      });
      return textResult(`Camera → ${next.center.lat.toFixed(4)},${next.center.lng.toFixed(4)} z${next.zoom}`, next);
    },
    mTarget,
  );

  reg(
    "map_pan",
    "Pan the camera by a relative offset in degrees (positive dLat = north, positive dLng = east).",
    { dLat: { type: "number" }, dLng: { type: "number" } },
    [],
    (args) => {
      const prev = adapter.getView();
      const next: MapView = {
        ...prev,
        center: { lat: prev.center.lat + num(args.dLat), lng: prev.center.lng + num(args.dLng) },
      };
      adapter.setView(next);
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: "map",
        action: "map_pan",
        label: "Panned camera",
        undo: () => adapter.setView(prev),
        redo: () => adapter.setView(next),
      });
      return textResult(`Panned to ${next.center.lat.toFixed(4)},${next.center.lng.toFixed(4)}`, next);
    },
    mTarget,
  );

  reg(
    "map_zoom",
    "Zoom the camera by a relative delta (e.g. +1 zooms in one level, -2 out two).",
    { delta: { type: "number" } },
    ["delta"],
    (args) => {
      const prev = adapter.getView();
      const next: MapView = { ...prev, zoom: prev.zoom + num(args.delta) };
      adapter.setView(next);
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: "map",
        action: "map_zoom",
        label: `Zoom → ${next.zoom}`,
        undo: () => adapter.setView(prev),
        redo: () => adapter.setView(next),
      });
      return textResult(`Zoom → ${next.zoom}`, next);
    },
  );

  reg(
    "map_fit_bounds",
    "Fit the camera to enclose points. Pass `points`, or omit to fit all current markers.",
    {
      points: {
        type: "array",
        description: "Points to enclose, e.g. [{lat,lng},…].",
        items: {
          type: "object",
          properties: { lat: { type: "number" }, lng: { type: "number" } },
          required: ["lat", "lng"],
        },
      },
      padding: { type: "number", description: "Padding in pixels (default 40)." },
    },
    [],
    (args) => {
      if (!adapter.fitBounds) {
        return errorResult("Host did not wire fitBounds (pass the <Map onReady> handle's fitBounds).");
      }
      const points: LatLng[] = Array.isArray(args.points)
        ? (args.points as any[]).map((p) => ({ lat: num(p?.lat), lng: num(p?.lng) }))
        : adapter.getMarkers().map((m) => m.position);
      if (!points.length) {
        return errorResult("No points to fit (map has no markers).");
      }
      adapter.fitBounds(points, args.padding !== undefined ? num(args.padding) : undefined);
      return textResult(`Fit camera to ${points.length} point(s).`);
    },
  );

  // ───────────── Markers ─────────────

  reg(
    "map_add_marker",
    "Drop a marker. `id` is optional (auto-generated); `icon` is an emoji or 1–2 chars.",
    {
      id: { type: "string" },
      lat: { type: "number" },
      lng: { type: "number" },
      label: { type: "string" },
      color: { type: "string", description: "CSS color, e.g. #2563eb." },
      icon: { type: "string", description: "Emoji / short text in the pin." },
      draggable: { type: "boolean" },
      data: { type: "object", description: "Arbitrary JSON payload carried with the marker." },
    },
    ["lat", "lng"],
    (args) => {
      const id = args.id ? str(args.id) : newId("m");
      if (adapter.getMarkers().some((m) => m.id === id)) {
        return errorResult(`A marker with id ${id} already exists — use map_update_marker.`);
      }
      const marker: MapMarker = {
        id,
        position: { lat: num(args.lat), lng: num(args.lng) },
        ...(args.label !== undefined ? { label: str(args.label) } : {}),
        ...(args.color !== undefined ? { color: str(args.color) } : {}),
        ...(args.icon !== undefined ? { icon: str(args.icon) } : {}),
        ...(args.draggable !== undefined ? { draggable: !!args.draggable } : {}),
        ...(args.data && typeof args.data === "object"
          ? { data: args.data as Record<string, unknown> }
          : {}),
      };
      adapter.setMarkers((all) => [...all, marker]);
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: "map",
        action: "map_add_marker",
        label: `Added marker ${id}`,
        undo: () => adapter.setMarkers((all) => all.filter((m) => m.id !== id)),
        redo: () => adapter.setMarkers((all) => [...all, marker]),
      });
      return textResult(`Added marker ${id} at ${marker.position.lat.toFixed(4)},${marker.position.lng.toFixed(4)}`, marker);
    },
    mTarget,
  );

  reg(
    "map_update_marker",
    "Update a marker. Only provided fields change — update lat/lng repeatedly to drive a live track.",
    {
      id: { type: "string" },
      lat: { type: "number" },
      lng: { type: "number" },
      label: { type: "string" },
      color: { type: "string" },
      icon: { type: "string" },
      draggable: { type: "boolean" },
    },
    ["id"],
    (args) => {
      const id = str(args.id);
      const prev = adapter.getMarkers().find((m) => m.id === id);
      if (!prev) {
        return errorResult(`No marker with id ${id}`);
      }
      const next: MapMarker = {
        ...prev,
        position: {
          lat: args.lat !== undefined ? num(args.lat) : prev.position.lat,
          lng: args.lng !== undefined ? num(args.lng) : prev.position.lng,
        },
        ...(args.label !== undefined ? { label: str(args.label) } : {}),
        ...(args.color !== undefined ? { color: str(args.color) } : {}),
        ...(args.icon !== undefined ? { icon: str(args.icon) } : {}),
        ...(args.draggable !== undefined ? { draggable: !!args.draggable } : {}),
      };
      adapter.setMarkers((all) => all.map((m) => (m.id === id ? next : m)));
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: "map",
        action: "map_update_marker",
        label: `Updated marker ${id}`,
        undo: () => adapter.setMarkers((all) => all.map((m) => (m.id === id ? prev : m))),
        redo: () => adapter.setMarkers((all) => all.map((m) => (m.id === id ? next : m))),
      });
      return textResult(`Updated marker ${id}`, next);
    },
    mTarget,
  );

  reg(
    "map_remove_marker",
    "Remove a marker by id.",
    { id: { type: "string" } },
    ["id"],
    (args) => {
      const id = str(args.id);
      const prev = adapter.getMarkers().find((m) => m.id === id);
      if (!prev) {
        return errorResult(`No marker with id ${id}`);
      }
      adapter.setMarkers((all) => all.filter((m) => m.id !== id));
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: "map",
        action: "map_remove_marker",
        label: `Removed marker ${id}`,
        undo: () => adapter.setMarkers((all) => [...all, prev]),
        redo: () => adapter.setMarkers((all) => all.filter((m) => m.id !== id)),
      });
      return textResult(`Removed marker ${id}`);
    },
    mTarget,
  );

  reg(
    "map_select",
    "Select a marker (or pass no id / null to clear the selection).",
    { id: { type: "string" } },
    [],
    (args) => {
      const prev = adapter.getSelected();
      const id = args.id === undefined || args.id === null ? null : str(args.id);
      if (id !== null && !adapter.getMarkers().some((m) => m.id === id)) {
        return errorResult(`No marker with id ${id}`);
      }
      adapter.setSelected(id);
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: "map",
        action: "map_select",
        label: id ? `Selected ${id}` : "Cleared selection",
        undo: () => adapter.setSelected(prev),
        redo: () => adapter.setSelected(id),
      });
      return textResult(id ? `Selected marker ${id}` : "Cleared selection", { selectedId: id });
    },
    mTarget,
  );

  // ───────────── Live tracking (camera follow) ─────────────

  reg(
    "map_start_track",
    "Make the camera follow a marker as its position updates (live tracking). Requires the host to wire setFollow.",
    { id: { type: "string" } },
    ["id"],
    (args) => {
      if (!adapter.setFollow) {
        return errorResult("Host did not wire setFollow (pass the map's `follow` setter).");
      }
      const id = str(args.id);
      if (!adapter.getMarkers().some((m) => m.id === id)) {
        return errorResult(`No marker with id ${id}`);
      }
      adapter.setFollow(id);
      return textResult(`Camera now following ${id}`, { follow: id });
    },
    mTarget,
  );

  reg(
    "map_stop_track",
    "Stop following any marker (releases the camera). Requires the host to wire setFollow.",
    {},
    [],
    () => {
      if (!adapter.setFollow) {
        return errorResult("Host did not wire setFollow.");
      }
      adapter.setFollow(null);
      return textResult("Camera released (no longer following).", { follow: null });
    },
  );

  return {
    id: "map",
    title: "Map",
    dispose: () => {
      for (const d of disposers) d();
    },
  };
}
