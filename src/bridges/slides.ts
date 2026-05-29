// `Slide` is a React component in @particle-academy/fancy-slides; the slide
// *data* type is exported as `SlideData`. Same naming convention applies to
// other element data shapes.
import type { Deck, DeckOp, ElementAnimation, SlideData, SlideElement, Theme } from "@particle-academy/fancy-slides";
import { reduceDeck, slideId as newSlideId, elementId as newElementId } from "@particle-academy/fancy-slides";
import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import type { AgentTarget } from "../presence/types";

/**
 * Adapter — the bridge calls into these to read or change deck state. The
 * host owns the deck (it's a controlled prop on `DeckEditor` / `SlideViewer`).
 * Every mutation funnels through `apply(op)`, which the host typically
 * implements as `setDeck(deck => reduceDeck(deck, op))`.
 */
export type SlidesBridgeAdapter = {
    /** Read the current deck. */
    getDeck: () => Deck;
    /**
     * Apply a typed DeckOp. The same operations the editor + agent use,
     * so the host's reducer + undo stack handle both code paths identically.
     */
    apply: (op: DeckOp) => void;
    /** Optional screen id for cross-screen presence highlighting. */
    screenId?: string;
};

export type SlidesBridgeOptions = {
    adapter: SlidesBridgeAdapter;
    /** Identity stamped on activity / op metadata. */
    agent?: { id: string; name?: string; color?: string };
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };

/**
 * registerSlidesBridge — wires the full slide-editor MCP surface against
 * a fancy-slides Deck. Tools map 1:1 to `DeckOp` cases (plus read-only
 * helpers); humans and agents take identical paths through the reducer.
 *
 *   deck_describe              read-only deck summary
 *   deck_get                   full deck JSON
 *   deck_set_title             rename
 *   deck_apply_theme           swap theme
 *   slide_list                 ordered list of slide ids + titles
 *   slide_get                  full slide JSON
 *   slide_add                  insert a slide
 *   slide_remove               delete a slide
 *   slide_reorder              move a slide
 *   slide_set_layout           change layout preset
 *   slide_set_notes            update speaker notes
 *   slide_set_background       background color / image / gradient
 *   slide_set_transition       entrance transition (fade / slide / zoom)
 *   element_add                insert an element onto a slide
 *   element_remove             delete an element
 *   element_update             patch an element's fields
 *   element_move               set element x/y
 *   element_resize             set element w/h
 *   element_set_animation      set/clear an element's entrance build (fade/fly-in/zoom/wipe)
 */
export function registerSlidesBridge(host: ToolHost, options: SlidesBridgeOptions): Bridge {
    const { adapter } = options;
    const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
    const disposers: Array<() => void> = [];

    const deckTarget = (): AgentTarget => ({
        kind: "deck",
        screenId: adapter.screenId,
        elementId: adapter.getDeck().id,
        label: adapter.getDeck().title,
    });

    const slideTarget = (slideId: string): AgentTarget => ({
        kind: "slide",
        screenId: adapter.screenId,
        elementId: slideId,
        label: `slide:${slideId}`,
    });

    const elementTarget = (slideId: string, elementId: string): AgentTarget => ({
        kind: "slide-element",
        screenId: adapter.screenId,
        elementId,
        label: `${slideId}/${elementId}`,
    });

    const reg = (
        name: string,
        description: string,
        properties: Record<string, unknown>,
        required: string[],
        handler: (args: JsonObject) => Promise<unknown> | unknown,
        isMutation: boolean,
        resolveTarget?: (args: JsonObject) => AgentTarget,
    ) => {
        const wrapped = (async (args: JsonObject) => {
            try {
                return await handler(args);
            } catch (e) {
                return errorResult(e instanceof Error ? e.message : String(e));
            }
        }) as never;
        const final = isMutation && resolveTarget
            ? wrapToolWithActivity(wrapped, {
                  toolName: name,
                  agent,
                  kind: "deck",
                  screenId: adapter.screenId,
                  resolveTarget: (ctx) => resolveTarget(ctx.args as JsonObject),
              })
            : wrapped;
        disposers.push(
            host.registerTool(
                {
                    name,
                    description,
                    inputSchema: {
                        type: "object",
                        properties: properties as Record<string, never>,
                        required,
                        additionalProperties: false,
                    },
                },
                final as never,
            ),
        );
    };

    // ─── Read-only ─────────────────────────────────────────────────────────

    reg(
        "deck_describe",
        "Summary of the active deck — title, slide count, theme name, element-type counts.",
        {},
        [],
        () => {
            const deck = adapter.getDeck();
            const elementCounts: Record<string, number> = {};
            for (const s of deck.slides) {
                for (const e of s.elements) {
                    elementCounts[e.type] = (elementCounts[e.type] ?? 0) + 1;
                }
            }
            const summary = {
                id: deck.id,
                title: deck.title,
                slides: deck.slides.length,
                theme: deck.theme?.name,
                elementCounts,
            };
            return textResult(JSON.stringify(summary, null, 2), summary);
        },
        false,
    );

    reg(
        "deck_get",
        "Read the full deck JSON.",
        {},
        [],
        () => {
            const deck = adapter.getDeck();
            return textResult(JSON.stringify(deck, null, 2), deck);
        },
        false,
    );

    reg(
        "slide_list",
        "List slides in order — `{ id, layout, elementCount, title? }`.",
        {},
        [],
        () => {
            const deck = adapter.getDeck();
            const list = deck.slides.map((s) => ({
                id: s.id,
                layout: s.layout,
                elementCount: s.elements.length,
                title: (s.metadata?.title as string | undefined) ?? firstTextContent(s),
            }));
            return textResult(JSON.stringify(list, null, 2), list);
        },
        false,
    );

    reg(
        "slide_get",
        "Read a single slide's JSON by id.",
        { id: { type: "string" } },
        ["id"],
        (args) => {
            const id = str(args.id);
            const slide = adapter.getDeck().slides.find((s) => s.id === id);
            if (!slide) return errorResult(`Slide not found: ${id}`);
            return textResult(JSON.stringify(slide, null, 2), slide);
        },
        false,
    );

    // ─── Deck-level mutations ──────────────────────────────────────────────

    reg(
        "deck_set_title",
        "Rename the deck.",
        { title: { type: "string" } },
        ["title"],
        (args) => {
            const title = str(args.title);
            adapter.apply({ kind: "deck_set_title", title });
            return textResult(`Title set to "${title}"`, { title });
        },
        true,
        deckTarget,
    );

    reg(
        "deck_apply_theme",
        "Apply a Theme to the deck. Pass either a built-in name (default / dark / vivid) or a full Theme object.",
        { theme: { description: "Theme name string or Theme object." } },
        ["theme"],
        (args) => {
            const t = args.theme;
            let theme: Theme;
            if (typeof t === "string") {
                theme = { name: t };
            } else if (t && typeof t === "object" && "name" in (t as Record<string, unknown>)) {
                theme = t as unknown as Theme;
            } else {
                return errorResult("theme must be a string name or an object with a `name` field.");
            }
            adapter.apply({ kind: "deck_apply_theme", theme });
            return textResult(`Applied theme: ${theme.name}`, { theme });
        },
        true,
        deckTarget,
    );

    // ─── Slide-level mutations ─────────────────────────────────────────────

    reg(
        "slide_add",
        "Insert a slide at `index` (defaults to end). Returns the new slide's id. Accepts a partial slide payload.",
        {
            index: { type: "number" },
            slide: { description: "Partial slide payload — id is auto-generated when absent." },
        },
        [],
        (args) => {
            const deck = adapter.getDeck();
            const incoming = (args.slide && typeof args.slide === "object" ? args.slide : {}) as Partial<SlideData>;
            const slide: SlideData = {
                id: incoming.id ?? newSlideId(),
                layout: incoming.layout ?? "blank",
                elements: incoming.elements ?? [],
                background: incoming.background,
                transition: incoming.transition,
                notes: incoming.notes,
                metadata: incoming.metadata,
            };
            const index = clamp(num(args.index, deck.slides.length), 0, deck.slides.length);
            adapter.apply({ kind: "slide_add", index, slide });
            return textResult(`Added slide ${slide.id} at index ${index}`, { id: slide.id, index });
        },
        true,
        () => deckTarget(),
    );

    reg(
        "slide_remove",
        "Delete a slide by id.",
        { id: { type: "string" } },
        ["id"],
        (args) => {
            const id = str(args.id);
            adapter.apply({ kind: "slide_remove", id });
            return textResult(`Removed slide ${id}`, { id });
        },
        true,
        (args) => slideTarget(str(args?.id)),
    );

    reg(
        "slide_reorder",
        "Move a slide to a new index.",
        { id: { type: "string" }, toIndex: { type: "number" } },
        ["id", "toIndex"],
        (args) => {
            const id = str(args.id);
            const toIndex = num(args.toIndex, 0);
            adapter.apply({ kind: "slide_reorder", id, toIndex });
            return textResult(`Moved slide ${id} → ${toIndex}`, { id, toIndex });
        },
        true,
        (args) => slideTarget(str(args?.id)),
    );

    reg(
        "slide_set_layout",
        "Change a slide's layout preset.",
        { id: { type: "string" }, layout: { type: "string" } },
        ["id", "layout"],
        (args) => {
            const id = str(args.id);
            const layout = str(args.layout) as SlideData["layout"];
            adapter.apply({ kind: "slide_set_layout", id, layout: layout ?? "blank" });
            return textResult(`Slide ${id} layout → ${layout}`, { id, layout });
        },
        true,
        (args) => slideTarget(str(args?.id)),
    );

    reg(
        "slide_set_notes",
        "Set a slide's speaker notes.",
        { id: { type: "string" }, notes: { type: "string" } },
        ["id", "notes"],
        (args) => {
            const id = str(args.id);
            const notes = str(args.notes);
            adapter.apply({ kind: "slide_set_notes", id, notes });
            return textResult(`Notes updated on slide ${id}`, { id });
        },
        true,
        (args) => slideTarget(str(args?.id)),
    );

    reg(
        "slide_set_background",
        "Set or clear a slide's background.",
        {
            id: { type: "string" },
            background: { description: "Background object `{ color?, image?, gradient? }` — pass null to clear." },
        },
        ["id"],
        (args) => {
            const id = str(args.id);
            const bg = (args.background && typeof args.background === "object" ? args.background : undefined) as SlideData["background"];
            adapter.apply({ kind: "slide_set_background", id, background: bg });
            return textResult(`Background set on slide ${id}`, { id });
        },
        true,
        (args) => slideTarget(str(args?.id)),
    );

    reg(
        "slide_set_transition",
        "Set or clear a slide's entrance transition.",
        {
            id: { type: "string" },
            transition: {
                description:
                    "Transition object `{ kind: 'none'|'fade'|'slide'|'zoom', duration?: number(ms), direction?: 'left'|'right'|'up'|'down' }` — pass null to clear.",
            },
        },
        ["id"],
        (args) => {
            const id = str(args.id);
            const transition = (args.transition && typeof args.transition === "object" ? args.transition : undefined) as SlideData["transition"];
            adapter.apply({ kind: "slide_set_transition", id, transition });
            return textResult(`Transition set on slide ${id}`, { id });
        },
        true,
        (args) => slideTarget(str(args?.id)),
    );

    // ─── Element-level mutations ───────────────────────────────────────────

    reg(
        "element_add",
        "Insert an element on a slide. Returns the new element id.",
        {
            slideId: { type: "string" },
            element: { description: "Partial element — type/x/y/w/h required, id auto-generated when absent." },
        },
        ["slideId", "element"],
        (args) => {
            const slideId = str(args.slideId);
            const incoming = (args.element && typeof args.element === "object" ? args.element : {}) as Partial<SlideElement>;
            if (!incoming.type) return errorResult("element.type is required.");
            const element = {
                id: incoming.id ?? newElementId(),
                ...incoming,
            } as SlideElement;
            adapter.apply({ kind: "element_add", slideId, element });
            return textResult(`Added ${element.type} element ${element.id} on ${slideId}`, { id: element.id, slideId });
        },
        true,
        (args) => slideTarget(str(args?.slideId)),
    );

    reg(
        "element_remove",
        "Delete an element by id.",
        { slideId: { type: "string" }, elementId: { type: "string" } },
        ["slideId", "elementId"],
        (args) => {
            const slideId = str(args.slideId);
            const elementId = str(args.elementId);
            adapter.apply({ kind: "element_remove", slideId, elementId });
            return textResult(`Removed element ${elementId} from ${slideId}`, { slideId, elementId });
        },
        true,
        (args) => elementTarget(str(args?.slideId), str(args?.elementId)),
    );

    reg(
        "element_update",
        "Patch arbitrary fields on an element. Only the keys in `patch` change.",
        {
            slideId: { type: "string" },
            elementId: { type: "string" },
            patch: { type: "object" },
        },
        ["slideId", "elementId", "patch"],
        (args) => {
            const slideId = str(args.slideId);
            const elementId = str(args.elementId);
            const patch = (args.patch && typeof args.patch === "object" ? args.patch : {}) as Partial<SlideElement>;
            adapter.apply({ kind: "element_update", slideId, elementId, patch });
            return textResult(`Patched element ${elementId}`, { keys: Object.keys(patch) });
        },
        true,
        (args) => elementTarget(str(args?.slideId), str(args?.elementId)),
    );

    reg(
        "element_move",
        "Set element x/y (slide-relative, 0..1).",
        {
            slideId: { type: "string" },
            elementId: { type: "string" },
            x: { type: "number" },
            y: { type: "number" },
        },
        ["slideId", "elementId", "x", "y"],
        (args) => {
            const slideId = str(args.slideId);
            const elementId = str(args.elementId);
            const x = clamp(num(args.x, 0), 0, 1);
            const y = clamp(num(args.y, 0), 0, 1);
            adapter.apply({ kind: "element_move", slideId, elementId, x, y });
            return textResult(`Moved element ${elementId} → (${x}, ${y})`, { x, y });
        },
        true,
        (args) => elementTarget(str(args?.slideId), str(args?.elementId)),
    );

    reg(
        "element_resize",
        "Set element width/height (slide-relative, 0..1).",
        {
            slideId: { type: "string" },
            elementId: { type: "string" },
            w: { type: "number" },
            h: { type: "number" },
        },
        ["slideId", "elementId", "w", "h"],
        (args) => {
            const slideId = str(args.slideId);
            const elementId = str(args.elementId);
            const w = clamp(num(args.w, 0), 0, 1);
            const h = clamp(num(args.h, 0), 0, 1);
            adapter.apply({ kind: "element_resize", slideId, elementId, w, h });
            return textResult(`Resized element ${elementId} → (${w}, ${h})`, { w, h });
        },
        true,
        (args) => elementTarget(str(args?.slideId), str(args?.elementId)),
    );

    reg(
        "element_set_animation",
        "Set or clear an element's entrance animation (build step).",
        {
            slideId: { type: "string" },
            elementId: { type: "string" },
            animation: {
                description:
                    "Animation `{ effect: 'fade'|'fly-in'|'zoom'|'wipe', trigger?: 'on-click'|'with-prev'|'after-prev', direction?: 'left'|'right'|'up'|'down', duration?: ms, delay?: ms, order?: number }` — pass null to clear.",
            },
        },
        ["slideId", "elementId"],
        (args) => {
            const slideId = str(args.slideId);
            const elementId = str(args.elementId);
            const animation = (args.animation && typeof args.animation === "object" ? args.animation : undefined) as ElementAnimation | undefined;
            adapter.apply({ kind: "element_set_animation", slideId, elementId, animation });
            return textResult(`Animation ${animation ? "set on" : "cleared from"} element ${elementId}`, { elementId });
        },
        true,
        (args) => elementTarget(str(args?.slideId), str(args?.elementId)),
    );

    return {
        id: "slides",
        title: "Slides",
        dispose: () => {
            for (const d of disposers.splice(0)) d();
        },
    };
}

// ─── helpers ───────────────────────────────────────────────────────────────

function num(v: unknown, fallback = 0): number {
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback = ""): string {
    return typeof v === "string" ? v : fallback;
}

function clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
}

function firstTextContent(slide: SlideData): string | undefined {
    for (const e of slide.elements) {
        if (e.type === "text") {
            const t = (e as { content?: string }).content;
            if (typeof t === "string") return t.split("\n")[0]?.slice(0, 60);
        }
    }
    return undefined;
}

// Re-export the reducer so consumers writing their own adapter can apply
// the same op-shape locally (e.g. for optimistic updates).
export { reduceDeck };
