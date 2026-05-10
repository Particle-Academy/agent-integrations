import type {
  BoardItem,
  ConnectorItem,
  RemoteCursor,
  ShapeItem,
  ShapeKind,
  StickyNoteItem,
  Stroke,
  Viewport,
} from "@particle-academy/fancy-whiteboard";
import { textResult, errorResult } from "../mcp/server";
import type { MicroMcpServer } from "../mcp/server";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";

/**
 * State accessors / mutators the bridge needs from the host. The host owns
 * whiteboard state (controlled props on fancy-whiteboard components); the
 * bridge calls into these to read or change it.
 */
export type WhiteboardBridgeAdapter = {
  getNotes: () => StickyNoteItem[];
  setNotes: (next: StickyNoteItem[] | ((prev: StickyNoteItem[]) => StickyNoteItem[])) => void;
  getShapes: () => ShapeItem[];
  setShapes: (next: ShapeItem[] | ((prev: ShapeItem[]) => ShapeItem[])) => void;
  getConnectors: () => ConnectorItem[];
  setConnectors: (next: ConnectorItem[] | ((prev: ConnectorItem[]) => ConnectorItem[])) => void;
  getStrokes: () => Stroke[];
  setStrokes: (next: Stroke[] | ((prev: Stroke[]) => Stroke[])) => void;
  getViewport: () => Viewport;
  setViewport: (next: Viewport) => void;
  /** Optional: agent presence cursor (for the visualizer). */
  setAgentCursor?: (cursor: RemoteCursor | null) => void;
};

export type WhiteboardBridgeOptions = {
  adapter: WhiteboardBridgeAdapter;
  /** Identity used when the agent stamps authorId on items / cursor. */
  agent?: { id: string; name?: string; color?: string };
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };
const VALID_SHAPES: ShapeKind[] = ["rect", "rounded-rect", "ellipse", "diamond", "triangle", "line", "arrow", "text"];

const num = (v: unknown, fallback?: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback ?? 0;
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const bool = (v: unknown, fallback = false): boolean => (typeof v === "boolean" ? v : fallback);

const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/**
 * registerWhiteboardBridge — wires a full MCP tool set against a fancy-
 * whiteboard session controlled by the host. Returns a Bridge handle the
 * host can dispose to tear everything down.
 */
export function registerWhiteboardBridge(
  server: MicroMcpServer,
  options: WhiteboardBridgeOptions,
): Bridge {
  const { adapter } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const disposers: Array<() => void> = [];

  // Cursor narration is the agent's responsibility — call
  // whiteboard_set_agent_cursor as a separate prerequisite before any
  // mutation. This keeps the protocol honest: each tool does one thing.


  const reg = (
    name: string,
    description: string,
    inputProperties: Record<string, unknown>,
    required: string[],
    handler: (args: JsonObject) => Promise<any> | any,
  ) => {
    disposers.push(
      server.registerTool(
        {
          name,
          description,
          inputSchema: {
            type: "object",
            properties: inputProperties as any,
            required,
            additionalProperties: false,
          },
        },
        async (args) => {
          try {
            return await handler(args);
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : String(e));
          }
        },
      ),
    );
  };

  // ───────────── Read tools ─────────────

  reg("whiteboard_get_state", "Get the full board state: viewport, all items, strokes.", {}, [], () => {
    const state = {
      viewport: adapter.getViewport(),
      notes: adapter.getNotes(),
      shapes: adapter.getShapes(),
      connectors: adapter.getConnectors(),
      strokes: adapter.getStrokes(),
    };
    return textResult(JSON.stringify(state, null, 2), state);
  });

  reg("whiteboard_list_items", "List notes, shapes, and connectors with id, kind, and bounds.", {}, [], () => {
    const items: Array<{ id: string; kind: string; summary: string }> = [];
    for (const n of adapter.getNotes()) {
      items.push({
        id: n.id,
        kind: "sticky",
        summary: `"${(n.text ?? "").slice(0, 40)}" @(${Math.round(n.x)},${Math.round(n.y)}) ${n.width}×${n.height}`,
      });
    }
    for (const s of adapter.getShapes()) {
      items.push({
        id: s.id,
        kind: `shape:${s.shape}`,
        summary: `${s.text ? `"${s.text}" ` : ""}@(${Math.round(s.x)},${Math.round(s.y)}) ${s.width}×${s.height}`,
      });
    }
    for (const c of adapter.getConnectors()) {
      items.push({ id: c.id, kind: "connector", summary: `from=${JSON.stringify(c.from)} to=${JSON.stringify(c.to)}` });
    }
    return textResult(items.map((i) => `${i.kind} ${i.id}: ${i.summary}`).join("\n") || "(empty board)", items);
  });

  reg(
    "whiteboard_get_item",
    "Get a single item (sticky / shape / connector) by id.",
    { id: { type: "string" } },
    ["id"],
    (args) => {
      const id = str(args.id);
      const all: BoardItem[] = [...adapter.getNotes(), ...adapter.getShapes(), ...adapter.getConnectors()];
      const found = all.find((x) => x.id === id);
      if (!found) return errorResult(`No item with id ${id}`);
      return textResult(JSON.stringify(found, null, 2), found);
    },
  );

  // ───────────── Sticky CRUD ─────────────

  reg(
    "whiteboard_add_sticky",
    "Add a sticky note. Position is in world coordinates.",
    {
      x: { type: "number" },
      y: { type: "number" },
      text: { type: "string" },
      width: { type: "number" },
      height: { type: "number" },
      color: { type: "string", description: "CSS color, e.g. #fde68a" },
    },
    ["x", "y"],
    async (args) => {
      const x = num(args.x);
      const y = num(args.y);
      const width = num(args.width, 180);
      const height = num(args.height, 140);
// (cursor narration is now an explicit separate tool call)
      const note: StickyNoteItem = {
        id: newId("n"),
        kind: "sticky",
        x, y, width, height,
        text: str(args.text),
        color: typeof args.color === "string" ? args.color : "#fde68a",
        authorId: agent.id,
      };
      adapter.setNotes((all) => [...all, note]);
      return textResult(`Added sticky ${note.id}`, note);
    },
  );

  reg(
    "whiteboard_stream_text",
    "Type text into a sticky note character-by-character so the human can read it forming. The tool returns once streaming finishes.",
    {
      id: { type: "string" },
      text: { type: "string" },
      cps: { type: "number", description: "Characters per second. Default 25." },
      append: { type: "boolean", description: "Append to existing text instead of replacing. Default false." },
    },
    ["id", "text"],
    async (args) => {
      const id = str(args.id);
      const target = str(args.text);
      const cps = Math.max(1, num(args.cps, 25));
      const append = bool(args.append);
      const startNote = adapter.getNotes().find((n) => n.id === id);
      if (!startNote) return errorResult(`No sticky with id ${id}`);
      const base = append ? (startNote.text ?? "") : "";
      const interval = Math.max(8, Math.round(1000 / cps));
      for (let i = 0; i <= target.length; i++) {
        const nextText = base + target.slice(0, i);
        adapter.setNotes((all) => all.map((n) => (n.id === id ? { ...n, text: nextText } : n)));
        if (i < target.length) await new Promise((r) => setTimeout(r, interval));
      }
      return textResult(`Streamed ${target.length} chars to ${id}`, { id, text: base + target });
    },
  );

  reg(
    "whiteboard_update_sticky",
    "Update fields on a sticky note. Only provided fields are changed.",
    {
      id: { type: "string" },
      x: { type: "number" },
      y: { type: "number" },
      width: { type: "number" },
      height: { type: "number" },
      text: { type: "string" },
      color: { type: "string" },
    },
    ["id"],
    async (args) => {
      const id = str(args.id);
      const existing = adapter.getNotes().find((n) => n.id === id);
      if (!existing) return errorResult(`No sticky with id ${id}`);
      const nextX = args.x !== undefined ? num(args.x) : existing.x;
      const nextY = args.y !== undefined ? num(args.y) : existing.y;
      const nextW = args.width !== undefined ? num(args.width) : existing.width;
      const nextH = args.height !== undefined ? num(args.height) : existing.height;
// (cursor narration is now an explicit separate tool call)
      let updated: StickyNoteItem | null = null;
      adapter.setNotes((all) =>
        all.map((n) => {
          if (n.id !== id) return n;
          updated = {
            ...n,
            x: nextX, y: nextY, width: nextW, height: nextH,
            ...(args.text !== undefined ? { text: str(args.text) } : {}),
            ...(args.color !== undefined ? { color: str(args.color) } : {}),
          };
          return updated;
        }),
      );
      return textResult(`Updated sticky ${id}`, updated);
    },
  );

  // ───────────── Shape CRUD ─────────────

  reg(
    "whiteboard_add_shape",
    `Add a shape. Kind must be one of: ${VALID_SHAPES.join(", ")}.`,
    {
      shape: { type: "string", enum: VALID_SHAPES },
      x: { type: "number" },
      y: { type: "number" },
      width: { type: "number" },
      height: { type: "number" },
      text: { type: "string" },
      fill: { type: "string" },
      stroke: { type: "string" },
      flipX: { type: "boolean" },
      flipY: { type: "boolean" },
    },
    ["shape", "x", "y", "width", "height"],
    async (args) => {
      const kind = str(args.shape) as ShapeKind;
      if (!VALID_SHAPES.includes(kind)) return errorResult(`Invalid shape kind: ${kind}`);
      const x = num(args.x);
      const y = num(args.y);
      const width = num(args.width);
      const height = num(args.height);
// (cursor narration is now an explicit separate tool call)
      const shape: ShapeItem = {
        id: newId("s"),
        kind: "shape",
        shape: kind,
        x, y, width, height,
        ...(args.text !== undefined ? { text: str(args.text) } : {}),
        ...(args.fill !== undefined ? { fill: str(args.fill) } : {}),
        ...(args.stroke !== undefined ? { stroke: str(args.stroke) } : {}),
        ...(args.flipX !== undefined ? { flipX: bool(args.flipX) } : {}),
        ...(args.flipY !== undefined ? { flipY: bool(args.flipY) } : {}),
      };
      adapter.setShapes((all) => [...all, shape]);
      return textResult(`Added ${kind} ${shape.id}`, shape);
    },
  );

  reg(
    "whiteboard_update_shape",
    "Update fields on a shape.",
    {
      id: { type: "string" },
      x: { type: "number" },
      y: { type: "number" },
      width: { type: "number" },
      height: { type: "number" },
      text: { type: "string" },
      fill: { type: "string" },
      stroke: { type: "string" },
    },
    ["id"],
    async (args) => {
      const id = str(args.id);
      const existing = adapter.getShapes().find((s) => s.id === id);
      if (!existing) return errorResult(`No shape with id ${id}`);
      const nextX = args.x !== undefined ? num(args.x) : existing.x;
      const nextY = args.y !== undefined ? num(args.y) : existing.y;
      const nextW = args.width !== undefined ? num(args.width) : existing.width;
      const nextH = args.height !== undefined ? num(args.height) : existing.height;
// (cursor narration is now an explicit separate tool call)
      let updated: ShapeItem | null = null;
      adapter.setShapes((all) =>
        all.map((s) => {
          if (s.id !== id) return s;
          updated = {
            ...s,
            x: nextX, y: nextY, width: nextW, height: nextH,
            ...(args.text !== undefined ? { text: str(args.text) } : {}),
            ...(args.fill !== undefined ? { fill: str(args.fill) } : {}),
            ...(args.stroke !== undefined ? { stroke: str(args.stroke) } : {}),
          };
          return updated;
        }),
      );
      return textResult(`Updated shape ${id}`, updated);
    },
  );

  // ───────────── Connectors ─────────────

  reg(
    "whiteboard_add_connector",
    "Connect two items by id, or specify explicit world-space points.",
    {
      from: { description: "Item id (string) or {x,y}" },
      to: { description: "Item id (string) or {x,y}" },
      color: { type: "string" },
    },
    ["from", "to"],
    (args) => {
      const c: ConnectorItem = {
        id: newId("c"),
        kind: "connector",
        from: args.from as any,
        to: args.to as any,
        ...(args.color !== undefined ? { color: str(args.color) } : {}),
      };
      adapter.setConnectors((all) => [...all, c]);
      return textResult(`Added connector ${c.id}`, c);
    },
  );

  // ───────────── Drawing ─────────────

  reg(
    "whiteboard_add_stroke",
    "Add a freeform pen stroke. Points are absolute screen coords (matching the Drawing layer).",
    {
      points: {
        type: "array",
        description: "Array of {x,y} points",
      },
      color: { type: "string" },
      size: { type: "number" },
    },
    ["points"],
    (args) => {
      const points = (Array.isArray(args.points) ? args.points : []).map((p: any) => ({
        x: num(p?.x),
        y: num(p?.y),
      }));
      if (!points.length) return errorResult("Stroke requires at least one point");
      const stroke: Stroke = {
        id: newId("st"),
        points,
        color: typeof args.color === "string" ? args.color : "#0f172a",
        size: typeof args.size === "number" ? args.size : 2,
        authorId: agent.id,
      };
      adapter.setStrokes((all) => [...all, stroke]);
      return textResult(`Added stroke ${stroke.id} (${points.length} points)`, stroke);
    },
  );

  // ───────────── Generic delete ─────────────

  reg(
    "whiteboard_delete_item",
    "Remove any item by id (sticky / shape / connector / stroke).",
    { id: { type: "string" } },
    ["id"],
    (args) => {
      const id = str(args.id);
      let removed = false;
      adapter.setNotes((all) => {
        const next = all.filter((x) => x.id !== id);
        if (next.length !== all.length) removed = true;
        return next;
      });
      adapter.setShapes((all) => {
        const next = all.filter((x) => x.id !== id);
        if (next.length !== all.length) removed = true;
        return next;
      });
      adapter.setConnectors((all) => {
        const next = all.filter((x) => x.id !== id);
        if (next.length !== all.length) removed = true;
        return next;
      });
      adapter.setStrokes((all) => {
        const next = all.filter((x) => x.id !== id);
        if (next.length !== all.length) removed = true;
        return next;
      });
      return removed ? textResult(`Deleted ${id}`) : errorResult(`No item with id ${id}`);
    },
  );

  // ───────────── Viewport / agent presence ─────────────

  reg(
    "whiteboard_set_viewport",
    "Pan / zoom the viewport.",
    { x: { type: "number" }, y: { type: "number" }, zoom: { type: "number" } },
    [],
    (args) => {
      const v = adapter.getViewport();
      const next: Viewport = {
        x: args.x !== undefined ? num(args.x) : v.x,
        y: args.y !== undefined ? num(args.y) : v.y,
        zoom: args.zoom !== undefined ? num(args.zoom) : v.zoom,
      };
      adapter.setViewport(next);
      return textResult(`Viewport → ${JSON.stringify(next)}`, next);
    },
  );

  reg(
    "whiteboard_set_agent_cursor",
    "Move the agent's presence cursor (or pass null to hide it).",
    {
      x: { type: "number" },
      y: { type: "number" },
      hide: { type: "boolean" },
    },
    [],
    (args) => {
      if (!adapter.setAgentCursor) return errorResult("Host did not provide setAgentCursor");
      if (bool(args.hide)) {
        adapter.setAgentCursor(null);
        return textResult("Agent cursor hidden");
      }
      const cursor: RemoteCursor = {
        userId: agent.id,
        name: agent.name,
        color: agent.color,
        x: num(args.x),
        y: num(args.y),
      };
      adapter.setAgentCursor(cursor);
      return textResult(`Cursor → (${cursor.x}, ${cursor.y})`, cursor);
    },
  );

  return {
    id: "whiteboard",
    title: "Whiteboard",
    dispose: () => {
      for (const d of disposers) d();
      adapter.setAgentCursor?.(null);
    },
  };
}
