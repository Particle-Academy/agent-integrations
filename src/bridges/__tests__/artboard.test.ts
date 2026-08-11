import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerArtboardBridge } from "../artboard";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import type { JsonObject } from "../../mcp/types";

type Piece = { id: string; label?: string; content?: unknown; pending?: boolean };
type Section = { id: string; title?: string; pieces: Piece[] };

function setup() {
  let value: { sections: Section[] } = {
    sections: [{ id: "sec1", title: "Ideas", pieces: [{ id: "p0", label: "Existing" }] }],
  };
  let viewport = { x: 0, y: 0, zoom: 1 };
  let focus: string | null = null;
  const host = new ToolRegistry();

  registerArtboardBridge(host, {
    adapter: {
      getValue: () => value as never,
      setValue: (next) => {
        value = (typeof next === "function" ? (next as (p: typeof value) => typeof value)(value) : next) as typeof value;
      },
      getViewport: () => viewport as never,
      setViewport: (next) => {
        viewport = next as typeof viewport;
      },
      getFocus: () => focus,
      setFocus: (id) => {
        focus = id;
      },
    },
  });

  const call = async (name: string, args: JsonObject = {}) => {
    const r = await host.callTool(name, args);
    return { isError: r.isError, text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "" };
  };

  const pieces = (sectionId = "sec1") => value.sections.find((s) => s.id === sectionId)!.pieces;

  return { host, call, value: () => value, pieces, viewport: () => viewport, focus: () => focus };
}

describe("registerArtboardBridge", () => {
  beforeEach(() => resetAllUndoStacks());

  it("registers its tools", () => {
    const names = setup().host.listTools().map((t) => t.name);

    for (const t of ["artboard_get_state", "artboard_list_pieces", "artboard_add_piece", "artboard_remove_piece", "artboard_reorder_piece", "artboard_rename_piece", "artboard_set_piece_content", "artboard_add_section", "artboard_set_viewport"]) {
      expect(names, `missing ${t}`).toContain(t);
    }
    expect(names).toContain("agent_undo");
  });

  it("adds a piece as PENDING, so a human confirms before it counts", async () => {
    // Trust-but-verify: an agent proposes, the human accepts. A piece that
    // arrived already-accepted would make the board unreviewable.
    const { call, pieces } = setup();

    await call("artboard_add_piece", { sectionId: "sec1", piece: { label: "Proposed" } });

    const added = pieces().find((p) => p.label === "Proposed");
    expect(added, "the piece should exist").toBeDefined();
    expect(added!.pending).toBe(true);
  });

  it("keeps the pieces that were already there", async () => {
    const { call, pieces } = setup();

    await call("artboard_add_piece", { sectionId: "sec1", piece: { label: "Second" } });

    expect(pieces().map((p) => p.label)).toEqual(["Existing", "Second"]);
  });

  it("refuses an unknown section instead of inventing one", async () => {
    const { call, value } = setup();

    expect((await call("artboard_add_piece", { sectionId: "nope", piece: {} })).isError).toBe(true);
    expect(value().sections).toHaveLength(1);
  });

  it("renames a piece by id", async () => {
    const { call, pieces } = setup();

    await call("artboard_rename_piece", { pieceId: "p0", label: "Renamed" });

    expect(pieces()[0]!.label).toBe("Renamed");
  });

  it("sets content on a piece that had none", async () => {
    // The regression: the undo snapshot cloned `existing.content` through
    // JSON.parse(JSON.stringify(...)), and `JSON.stringify(undefined)` returns
    // the VALUE undefined rather than a string — so JSON.parse threw
    // `"undefined" is not valid JSON` for every piece without content yet.
    //
    // Invisible from inside the bridge, because a piece the BRIDGE adds always
    // has content (`coerceContent` returns at least `{kind:"node"}`). It only
    // fired on a piece the host app built — which is every piece on a board a
    // human made, i.e. the normal case.
    const { call, pieces } = setup();

    const r = await call("artboard_set_piece_content", { pieceId: "p0", content: { kind: "html", html: "<p>body</p>" } });

    expect(r.isError, r.text).toBeFalsy();
    expect(pieces()[0]!.content).toEqual({ kind: "html", html: "<p>body</p>" });
  });

  it("undoes back to having no content at all", async () => {
    // The other half: `undefined` must survive the round trip, or undo restores
    // a piece to a state it was never in.
    const { call, pieces } = setup();

    await call("artboard_set_piece_content", { pieceId: "p0", content: { kind: "html", html: "<p>x</p>" } });
    await call("agent_undo", {});

    expect(pieces()[0]!.content).toBeUndefined();
  });

  it("coerces an unrecognised content shape to a bare node", async () => {
    // `coerceContent` whitelists image / html / node and drops anything else.
    // Pinned because the discard is SILENT — an agent sending
    // `content: "hello"` gets a success and a piece holding nothing. The
    // whitelist is defensible (it is what the component renders); reporting
    // success for a value that was thrown away is the part worth knowing about,
    // and this test is where that shows up if it is ever tightened.
    const { call, pieces } = setup();

    await call("artboard_set_piece_content", { pieceId: "p0", content: "just a string" });

    expect(pieces()[0]!.content).toEqual({ kind: "node" });
  });

  it("reorders within a section", async () => {
    const { call, pieces } = setup();

    await call("artboard_add_piece", { sectionId: "sec1", piece: { label: "Second" } });
    const secondId = pieces()[1]!.id;

    await call("artboard_reorder_piece", { pieceId: secondId, toIndex: 0 });

    expect(pieces()[0]!.id).toBe(secondId);
  });

  it("removes a piece", async () => {
    const { call, pieces } = setup();

    await call("artboard_remove_piece", { pieceId: "p0" });

    expect(pieces()).toHaveLength(0);
  });

  it("moves the camera and focus without editing the document", async () => {
    const { call, viewport, focus, pieces } = setup();

    await call("artboard_set_viewport", { x: 10, y: 20, zoom: 1.5 });
    await call("artboard_focus_piece", { pieceId: "p0" });

    expect(viewport().zoom).toBe(1.5);
    expect(focus()).toBe("p0");
    expect(pieces()[0]!.label, "focusing must not rewrite the piece").toBe("Existing");
  });
});
