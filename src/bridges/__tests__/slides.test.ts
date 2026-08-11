import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerSlidesBridge } from "../slides";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import type { JsonObject } from "../../mcp/types";

type Deck = {
  title?: string;
  slides: Array<{ id: string; layout?: string; notes?: string; elements: Array<{ id: string; type?: string; x?: number; y?: number }> }>;
};

/**
 * The host owns the reducer. The bridge only emits typed `DeckOp`s, so this
 * fake applies them the way the real editor does — which is the point of the
 * design: agent and human edits travel the same path and share one undo stack.
 */
function reduce(deck: Deck, op: { op: string } & Record<string, unknown>): Deck {
  switch (op.op) {
    case "deck.setTitle":
      return { ...deck, title: op.title as string };
    case "slide.add": {
      const slide = op.slide as Deck["slides"][number];
      const at = typeof op.index === "number" ? op.index : deck.slides.length;
      const next = [...deck.slides];
      next.splice(at, 0, { ...slide, elements: slide.elements ?? [] });
      return { ...deck, slides: next };
    }
    case "slide.remove":
      return { ...deck, slides: deck.slides.filter((s) => s.id !== (op.slideId ?? op.id)) };
    case "slide.setLayout":
      return { ...deck, slides: deck.slides.map((s) => (s.id === op.slideId ? { ...s, layout: op.layout as string } : s)) };
    case "slide.setNotes":
      return { ...deck, slides: deck.slides.map((s) => (s.id === op.slideId ? { ...s, notes: op.notes as string } : s)) };
    case "element.add":
      return {
        ...deck,
        slides: deck.slides.map((s) =>
          s.id === op.slideId ? { ...s, elements: [...s.elements, op.element as { id: string }] } : s,
        ),
      };
    case "element.move":
      return {
        ...deck,
        slides: deck.slides.map((s) =>
          s.id !== op.slideId
            ? s
            : { ...s, elements: s.elements.map((e) => (e.id === op.elementId ? { ...e, x: op.x as number, y: op.y as number } : e)) },
        ),
      };
    default:
      return deck;
  }
}

function setup() {
  let deck: Deck = { title: "Q1", slides: [{ id: "s1", elements: [{ id: "e1", type: "text" }] }] };
  const ops: Array<{ op: string }> = [];
  const host = new ToolRegistry();

  registerSlidesBridge(host, {
    adapter: {
      getDeck: () => deck as never,
      apply: (op) => {
        ops.push(op as { op: string });
        deck = reduce(deck, op as never);
      },
    },
  });

  const call = async (name: string, args: JsonObject = {}) => {
    const r = await host.callTool(name, args);
    return { isError: r.isError, text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "" };
  };

  return { host, call, deck: () => deck, ops };
}

describe("registerSlidesBridge", () => {
  beforeEach(() => resetAllUndoStacks());

  it("registers deck, slide and element tools", () => {
    const names = setup().host.listTools().map((t) => t.name);

    for (const t of ["deck_describe", "deck_get", "deck_set_title", "slide_list", "slide_add", "slide_remove", "slide_set_layout", "element_add", "element_move"]) {
      expect(names, `missing ${t}`).toContain(t);
    }
  });

  it("edits ONLY through typed ops, never by writing the deck", async () => {
    // The contract that makes agent and human edits interchangeable: the bridge
    // emits ops the host's own reducer applies. If it wrote state directly it
    // would bypass the host's undo stack and the two paths would diverge.
    const { call, ops } = setup();

    await call("deck_set_title", { title: "Q2" });

    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe("deck.setTitle");
  });

  it("reads the deck and its slides", async () => {
    const { call } = setup();

    expect((await call("deck_get")).text).toContain("Q1");
    expect((await call("slide_list")).text).toContain("s1");
  });

  it("adds and removes a slide without disturbing the rest", async () => {
    // The bridge MINTS the slide id, so a caller cannot collide with an
    // existing one. That means the test has to read the id back rather than
    // predict it.
    const { call, deck } = setup();

    await call("slide_add", {});
    expect(deck().slides).toHaveLength(2);
    expect(deck().slides[0]!.id, "the original slide survives").toBe("s1");

    const addedId = deck().slides[1]!.id;
    await call("slide_remove", { id: addedId });

    expect(deck().slides.map((s) => s.id)).toEqual(["s1"]);
  });

  it("sets layout and notes on one slide only", async () => {
    const { call, deck } = setup();

    await call("slide_add", {});
    await call("slide_set_layout", { id: "s1", layout: "two-column" });
    await call("slide_set_notes", { id: "s1", notes: "speak slowly" });

    expect(deck().slides[0]!.layout).toBe("two-column");
    expect(deck().slides[0]!.notes).toBe("speak slowly");
    // A minted slide starts on "blank"; the point is that it did not become
    // "two-column" along with its neighbour.
    expect(deck().slides[1]!.layout, "the other slide is untouched").toBe("blank");
  });

  it("moves an element in FRACTIONAL coordinates, clamped to the slide", async () => {
    // Slide geometry is 0..1 of the canvas, not pixels — so a slide renders the
    // same at any projector resolution. An agent passing pixels gets clamped to
    // the edge rather than placing an element off-slide where nobody can see it.
    const { call, deck } = setup();

    await call("element_move", { slideId: "s1", elementId: "e1", x: 0.25, y: 0.75 });
    expect(deck().slides[0]!.elements[0]).toMatchObject({ x: 0.25, y: 0.75 });

    await call("element_move", { slideId: "s1", elementId: "e1", x: 42, y: -3 });
    expect(deck().slides[0]!.elements[0]).toMatchObject({ x: 1, y: 0 });
  });

  it("emits a layout op for an unknown slide and reports success", async () => {
    // Current behaviour, pinned rather than endorsed. `slide_set_layout` does
    // not check the slide exists — it emits the op and returns success, and the
    // host's reducer quietly matches nothing. So an agent that mistypes an id
    // is told the layout changed.
    //
    // Not fixed here because it is a policy question across every op in this
    // bridge, not a one-line guard: `deck_get` is one call away, and a bridge
    // that validates ids duplicates the reducer's matching logic. This test is
    // where the decision surfaces if it is ever made.
    const { call, ops, deck } = setup();

    const r = await call("slide_set_layout", { id: "nope", layout: "two-column" });

    expect(r.isError).toBeFalsy();
    expect(ops.map((o) => o.op)).toContain("slide.setLayout");
    expect(deck().slides[0]!.layout, "and nothing actually changed").toBeUndefined();
  });
});
