import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerWhiteboardBridge } from "../whiteboard";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import type { JsonObject } from "../../mcp/types";

type Item = { id: string; [k: string]: unknown };

function setup() {
  let notes: Item[] = [];
  let shapes: Item[] = [];
  let connectors: Item[] = [];
  let strokes: Item[] = [];
  let viewport = { x: 0, y: 0, zoom: 1 };
  let cursor: unknown = undefined;
  const host = new ToolRegistry();

  const updater = <T,>(cur: T[], next: T[] | ((p: T[]) => T[])): T[] =>
    typeof next === "function" ? (next as (p: T[]) => T[])(cur) : next;

  registerWhiteboardBridge(host, {
    adapter: {
      getNotes: () => notes as never,
      setNotes: (next) => {
        notes = updater(notes, next as never);
      },
      getShapes: () => shapes as never,
      setShapes: (next) => {
        shapes = updater(shapes, next as never);
      },
      getConnectors: () => connectors as never,
      setConnectors: (next) => {
        connectors = updater(connectors, next as never);
      },
      getStrokes: () => strokes as never,
      setStrokes: (next) => {
        strokes = updater(strokes, next as never);
      },
      getViewport: () => viewport as never,
      setViewport: (next) => {
        viewport = next as typeof viewport;
      },
      setAgentCursor: (c) => {
        cursor = c;
      },
    },
  });

  const call = async (name: string, args: JsonObject = {}) => {
    const r = await host.callTool(name, args);
    return { isError: r.isError, text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "" };
  };

  return { host, call, notes: () => notes, connectors: () => connectors, strokes: () => strokes, viewport: () => viewport, cursor: () => cursor };
}

describe("registerWhiteboardBridge", () => {
  beforeEach(() => resetAllUndoStacks());

  it("registers its tools", () => {
    const names = setup().host.listTools().map((t) => t.name);

    for (const t of ["whiteboard_get_state", "whiteboard_list_items", "whiteboard_get_item", "whiteboard_add_sticky", "whiteboard_add_shape", "whiteboard_add_connector", "whiteboard_add_stroke", "whiteboard_delete_item", "whiteboard_set_viewport"]) {
      expect(names, `missing ${t}`).toContain(t);
    }
    expect(names).toContain("agent_undo");
  });

  it("adds a sticky and can read it back by id", async () => {
    const { call, notes } = setup();

    await call("whiteboard_add_sticky", { x: 10, y: 20, text: "hello" });
    expect(notes()).toHaveLength(1);

    const id = notes()[0]!.id;
    expect((await call("whiteboard_get_item", { id })).text).toContain("hello");
  });

  it("keeps earlier items when another is added", async () => {
    // Every setter takes an updater. A bridge that rebuilt the list from the
    // item it just made would silently wipe the board.
    const { call, notes } = setup();

    await call("whiteboard_add_sticky", { x: 0, y: 0, text: "one" });
    await call("whiteboard_add_sticky", { x: 1, y: 1, text: "two" });

    expect(notes()).toHaveLength(2);
  });

  it("updates a sticky in place", async () => {
    const { call, notes } = setup();

    await call("whiteboard_add_sticky", { x: 0, y: 0, text: "before" });
    const id = notes()[0]!.id;
    await call("whiteboard_update_sticky", { id, text: "after" });

    expect(notes()[0]!.text).toBe("after");
    expect(notes(), "an update must not add a second note").toHaveLength(1);
  });

  it("deletes by id across item kinds", async () => {
    const { call, notes, strokes } = setup();

    await call("whiteboard_add_sticky", { x: 0, y: 0, text: "note" });
    await call("whiteboard_add_stroke", { points: [[0, 0], [1, 1]] });
    const noteId = notes()[0]!.id;

    await call("whiteboard_delete_item", { id: noteId });

    expect(notes()).toHaveLength(0);
    expect(strokes(), "deleting a note must not touch strokes").toHaveLength(1);
  });

  it("connects two items", async () => {
    const { call, notes, connectors } = setup();

    await call("whiteboard_add_sticky", { x: 0, y: 0, text: "a" });
    await call("whiteboard_add_sticky", { x: 5, y: 5, text: "b" });
    const [a, b] = notes().map((n) => n.id);

    await call("whiteboard_add_connector", { from: a, to: b });

    expect(connectors()).toHaveLength(1);
  });

  it("moves the viewport and the agent cursor without touching items", async () => {
    // Presence and camera are not document state — an agent panning to look at
    // something must not register as an edit.
    const { call, viewport, cursor, notes } = setup();

    await call("whiteboard_set_viewport", { x: 100, y: 50, zoom: 2 });
    await call("whiteboard_set_agent_cursor", { x: 5, y: 5 });

    expect(viewport().zoom).toBe(2);
    expect(cursor()).toBeTruthy();
    expect(notes()).toHaveLength(0);
  });

  it("reports an unknown id rather than silently doing nothing", async () => {
    const { call } = setup();

    expect((await call("whiteboard_get_item", { id: "nope" })).isError).toBe(true);
  });
});
