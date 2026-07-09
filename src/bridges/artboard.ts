import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import type { AgentTarget } from "../presence/types";
import { pushUndoEntry } from "../undo/undo-stack";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";

/**
 * Transport-level JSON shapes. These intentionally mirror fancy-artboard's
 * public `ArtBoardValue` but are defined LOCALLY so this bridge builds
 * independently of the sibling package — they are plain JSON crossing the
 * MCP wire, not the live component types. Keep them in sync with
 * @particle-academy/fancy-artboard's public surface.
 */
type Viewport = { x: number; y: number; zoom: number };
type ArtPieceContent =
  | { kind: "image"; src: string; alt?: string }
  | { kind: "html"; html: string }
  | { kind: "node" };
type ArtPieceData = {
  id: string;
  label?: string;
  width?: number;
  height?: number;
  content: ArtPieceContent;
  pending?: boolean;
};
type ArtSectionData = {
  id: string;
  title: string;
  subtitle?: string;
  pieces: ArtPieceData[];
};
type ArtBoardValue = { sections: ArtSectionData[] };

/**
 * State accessors / mutators the bridge needs from the host. The host owns
 * artboard state (controlled props on fancy-artboard components); the bridge
 * calls into these to read or change it.
 */
export type ArtboardBridgeAdapter = {
  getValue: () => ArtBoardValue;
  setValue: (next: ArtBoardValue | ((prev: ArtBoardValue) => ArtBoardValue)) => void;
  getViewport: () => Viewport;
  setViewport: (next: Viewport) => void;
  getFocus: () => string | null;
  setFocus: (id: string | null) => void;
  /** Optional: agent presence cursor (for the visualizer). */
  setAgentCursor?: (cursor: { x: number; y: number } | null) => void;
};

export type ArtboardBridgeOptions = {
  adapter: ArtboardBridgeAdapter;
  /** Identity used when the agent stamps authorship / cursor. */
  agent?: { id: string; name?: string; color?: string };
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };

const num = (v: unknown, fallback?: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback ?? 0;
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/** Deep-clone helper for snapshotting pieces/sections for undo closures. */
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Coerce arbitrary JSON into a valid ArtPieceContent, defaulting to a node. */
const coerceContent = (v: unknown): ArtPieceContent => {
  if (v && typeof v === "object") {
    const c = v as Record<string, unknown>;
    if (c.kind === "image") return { kind: "image", src: str(c.src), ...(c.alt !== undefined ? { alt: str(c.alt) } : {}) };
    if (c.kind === "html") return { kind: "html", html: str(c.html) };
    if (c.kind === "node") return { kind: "node" };
  }
  return { kind: "node" };
};

/**
 * registerArtboardBridge — wires a full MCP tool set against a fancy-artboard
 * session controlled by the host. Returns a Bridge handle the host can dispose
 * to tear everything down.
 */
export function registerArtboardBridge(
  host: ToolHost,
  options: ArtboardBridgeOptions,
): Bridge {
  const { adapter } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const disposers: Array<() => void> = [];

  // Register agent_undo / agent_redo / agent_history once per server. Idempotent.
  ensureUndoToolsRegistered(host, { defaultAgentId: agent.id });

  // Activity-target resolver shared by every mutation tool. Pulls the touched
  // piece/section id from the result (structuredContent) when present, falling
  // back to the args id for rename/remove/focus tools.
  const abTarget = (args: any, result: any): AgentTarget => ({
    kind: "artboard",
    elementId:
      (result?.structuredContent?.id as string | undefined) ??
      (args?.pieceId as string | undefined) ??
      (args?.sectionId as string | undefined),
  } as AgentTarget);

  const reg = (
    name: string,
    description: string,
    inputProperties: Record<string, unknown>,
    required: string[],
    handler: (args: JsonObject) => Promise<any> | any,
    /** Optional: resolve the activity target so the presence layer can render
     *  a focus indicator on the touched element. Read tools omit this. */
    resolveTarget?: (args: JsonObject, result: any) => AgentTarget | null,
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
          kind: "artboard",
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
            properties: inputProperties as any,
            required,
            additionalProperties: false,
          },
        },
        final as any,
      ),
    );
  };

  // ───────────── Read tools ─────────────

  reg("artboard_get_state", "Get the full board state: viewport, focus, all sections and pieces.", {}, [], () => {
    const state = {
      viewport: adapter.getViewport(),
      focus: adapter.getFocus(),
      sections: adapter.getValue().sections,
    };
    return textResult(JSON.stringify(state, null, 2), state);
  });

  reg("artboard_list_pieces", "List sections and their pieces with id, label, and content kind.", {}, [], () => {
    const lines: string[] = [];
    const summary: Array<{ sectionId: string; title: string; pieces: Array<{ id: string; label?: string; kind: string; pending?: boolean }> }> = [];
    for (const s of adapter.getValue().sections) {
      lines.push(`section ${s.id}: "${s.title}"`);
      const pieces = s.pieces.map((p) => ({
        id: p.id,
        ...(p.label !== undefined ? { label: p.label } : {}),
        kind: p.content.kind,
        ...(p.pending ? { pending: true } : {}),
      }));
      for (const p of s.pieces) {
        lines.push(`  piece ${p.id}: ${p.label ? `"${p.label}" ` : ""}[${p.content.kind}]${p.pending ? " (pending)" : ""}`);
      }
      summary.push({ sectionId: s.id, title: s.title, pieces });
    }
    return textResult(lines.join("\n") || "(empty board)", summary);
  });

  // ───────────── Piece tools ─────────────

  reg(
    "artboard_add_piece",
    "Add a piece to a section. New agent-added pieces default to pending:true (trust-but-verify — a human confirms before it is final).",
    {
      sectionId: { type: "string" },
      piece: {
        type: "object",
        description: "Piece spec: { label?, width?, height?, content }. content is { kind: 'image', src, alt? } | { kind: 'html', html } | { kind: 'node' }.",
      },
      index: { type: "number", description: "Insertion index within the section. Defaults to the end." },
    },
    ["sectionId", "piece"],
    (args) => {
      const sectionId = str(args.sectionId);
      const section = adapter.getValue().sections.find((s) => s.id === sectionId);
      if (!section) return errorResult(`No section with id ${sectionId}`);
      const spec = (args.piece ?? {}) as Record<string, unknown>;
      const piece: ArtPieceData = {
        id: newId("p"),
        ...(spec.label !== undefined ? { label: str(spec.label) } : {}),
        ...(spec.width !== undefined ? { width: num(spec.width) } : {}),
        ...(spec.height !== undefined ? { height: num(spec.height) } : {}),
        content: coerceContent(spec.content),
        pending: true,
      };
      const insertAt =
        args.index !== undefined ? Math.max(0, Math.min(num(args.index), section.pieces.length)) : section.pieces.length;
      adapter.setValue((prev) => ({
        sections: prev.sections.map((s) =>
          s.id !== sectionId ? s : { ...s, pieces: [...s.pieces.slice(0, insertAt), piece, ...s.pieces.slice(insertAt)] },
        ),
      }));
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: "artboard",
        action: "artboard_add_piece",
        label: `Added piece ${piece.id} to ${sectionId}`,
        undo: () =>
          adapter.setValue((prev) => ({
            sections: prev.sections.map((s) =>
              s.id !== sectionId ? s : { ...s, pieces: s.pieces.filter((p) => p.id !== piece.id) },
            ),
          })),
        redo: () =>
          adapter.setValue((prev) => ({
            sections: prev.sections.map((s) =>
              s.id !== sectionId ? s : { ...s, pieces: [...s.pieces.slice(0, insertAt), piece, ...s.pieces.slice(insertAt)] },
            ),
          })),
      });
      return textResult(`Added piece ${piece.id} to section ${sectionId} (pending)`, piece);
    },
    abTarget,
  );

  reg(
    "artboard_remove_piece",
    "Remove a piece by id.",
    { pieceId: { type: "string" } },
    ["pieceId"],
    (args) => {
      const pieceId = str(args.pieceId);
      let removed: ArtPieceData | null = null;
      let fromSection: string | null = null;
      let oldIndex = -1;
      for (const s of adapter.getValue().sections) {
        const idx = s.pieces.findIndex((p) => p.id === pieceId);
        if (idx !== -1) {
          removed = clone(s.pieces[idx]);
          fromSection = s.id;
          oldIndex = idx;
          break;
        }
      }
      if (!removed || fromSection === null) return errorResult(`No piece with id ${pieceId}`);
      const sectionId = fromSection;
      const snapshot = removed;
      const at = oldIndex;
      adapter.setValue((prev) => ({
        sections: prev.sections.map((s) =>
          s.id !== sectionId ? s : { ...s, pieces: s.pieces.filter((p) => p.id !== pieceId) },
        ),
      }));
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: "artboard",
        action: "artboard_remove_piece",
        label: `Removed piece ${pieceId}`,
        undo: () =>
          adapter.setValue((prev) => ({
            sections: prev.sections.map((s) =>
              s.id !== sectionId ? s : { ...s, pieces: [...s.pieces.slice(0, at), clone(snapshot), ...s.pieces.slice(at)] },
            ),
          })),
        redo: () =>
          adapter.setValue((prev) => ({
            sections: prev.sections.map((s) =>
              s.id !== sectionId ? s : { ...s, pieces: s.pieces.filter((p) => p.id !== pieceId) },
            ),
          })),
      });
      return textResult(`Removed piece ${pieceId}`, { id: pieceId });
    },
    abTarget,
  );

  reg(
    "artboard_reorder_piece",
    "Move a piece to a new index, optionally into a different section.",
    {
      pieceId: { type: "string" },
      sectionId: { type: "string", description: "Target section id. Defaults to the piece's current section." },
      toIndex: { type: "number" },
    },
    ["pieceId", "toIndex"],
    (args) => {
      const pieceId = str(args.pieceId);
      const before = adapter.getValue();
      // Locate the piece.
      let piece: ArtPieceData | null = null;
      let srcSection: string | null = null;
      for (const s of before.sections) {
        const found = s.pieces.find((p) => p.id === pieceId);
        if (found) {
          piece = found;
          srcSection = s.id;
          break;
        }
      }
      if (!piece || srcSection === null) return errorResult(`No piece with id ${pieceId}`);
      const dstSection = args.sectionId !== undefined ? str(args.sectionId) : srcSection;
      if (!before.sections.some((s) => s.id === dstSection)) return errorResult(`No section with id ${dstSection}`);
      const toIndex = Math.max(0, num(args.toIndex));
      const moving = piece;
      const snapshot = clone(before);
      adapter.setValue((prev) => {
        // Remove from wherever it currently is.
        const stripped = prev.sections.map((s) => ({ ...s, pieces: s.pieces.filter((p) => p.id !== pieceId) }));
        return {
          sections: stripped.map((s) => {
            if (s.id !== dstSection) return s;
            const clamped = Math.min(toIndex, s.pieces.length);
            return { ...s, pieces: [...s.pieces.slice(0, clamped), moving, ...s.pieces.slice(clamped)] };
          }),
        };
      });
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: "artboard",
        action: "artboard_reorder_piece",
        label: `Reordered piece ${pieceId}`,
        undo: () => adapter.setValue(() => clone(snapshot)),
        redo: () =>
          adapter.setValue((prev) => {
            const stripped = prev.sections.map((s) => ({ ...s, pieces: s.pieces.filter((p) => p.id !== pieceId) }));
            return {
              sections: stripped.map((s) => {
                if (s.id !== dstSection) return s;
                const clamped = Math.min(toIndex, s.pieces.length);
                return { ...s, pieces: [...s.pieces.slice(0, clamped), moving, ...s.pieces.slice(clamped)] };
              }),
            };
          }),
      });
      return textResult(`Reordered piece ${pieceId} → ${dstSection}[${toIndex}]`, { id: pieceId, sectionId: dstSection, toIndex });
    },
    abTarget,
  );

  reg(
    "artboard_rename_piece",
    "Set a piece's label.",
    { pieceId: { type: "string" }, label: { type: "string" } },
    ["pieceId", "label"],
    (args) => {
      const pieceId = str(args.pieceId);
      const label = str(args.label);
      const existing = adapter.getValue().sections.flatMap((s) => s.pieces).find((p) => p.id === pieceId);
      if (!existing) return errorResult(`No piece with id ${pieceId}`);
      const prevLabel = existing.label;
      const apply = (l: string | undefined) =>
        adapter.setValue((prev) => ({
          sections: prev.sections.map((s) => ({
            ...s,
            pieces: s.pieces.map((p) => (p.id !== pieceId ? p : { ...p, ...(l !== undefined ? { label: l } : {}) })),
          })),
        }));
      apply(label);
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: "artboard",
        action: "artboard_rename_piece",
        label: `Renamed piece ${pieceId}`,
        undo: () => apply(prevLabel),
        redo: () => apply(label),
      });
      return textResult(`Renamed piece ${pieceId} → "${label}"`, { id: pieceId, label });
    },
    abTarget,
  );

  reg(
    "artboard_set_piece_content",
    "Replace a piece's content. content is { kind: 'image', src, alt? } | { kind: 'html', html } | { kind: 'node' }.",
    { pieceId: { type: "string" }, content: { type: "object" } },
    ["pieceId", "content"],
    (args) => {
      const pieceId = str(args.pieceId);
      const existing = adapter.getValue().sections.flatMap((s) => s.pieces).find((p) => p.id === pieceId);
      if (!existing) return errorResult(`No piece with id ${pieceId}`);
      const prevContent = clone(existing.content);
      const nextContent = coerceContent(args.content);
      const apply = (c: ArtPieceContent) =>
        adapter.setValue((prev) => ({
          sections: prev.sections.map((s) => ({
            ...s,
            pieces: s.pieces.map((p) => (p.id !== pieceId ? p : { ...p, content: clone(c) })),
          })),
        }));
      apply(nextContent);
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: "artboard",
        action: "artboard_set_piece_content",
        label: `Set content of piece ${pieceId}`,
        undo: () => apply(prevContent),
        redo: () => apply(nextContent),
      });
      return textResult(`Set content of piece ${pieceId} → ${nextContent.kind}`, { id: pieceId, content: nextContent });
    },
    abTarget,
  );

  reg(
    "artboard_focus_piece",
    "Focus a piece by id (or pass null to clear focus).",
    { pieceId: { type: ["string", "null"] } },
    [],
    (args) => {
      const raw = args.pieceId;
      const pieceId = typeof raw === "string" ? raw : null;
      if (pieceId !== null && !adapter.getValue().sections.some((s) => s.pieces.some((p) => p.id === pieceId))) {
        return errorResult(`No piece with id ${pieceId}`);
      }
      adapter.setFocus(pieceId);
      return textResult(pieceId ? `Focused piece ${pieceId}` : "Cleared focus", { id: pieceId });
    },
    abTarget,
  );

  // ───────────── Section tools ─────────────

  reg(
    "artboard_add_section",
    "Add a section. Provide an explicit id or one is generated.",
    {
      section: { type: "object", description: "Section spec: { id?, title, subtitle? }." },
      index: { type: "number", description: "Insertion index. Defaults to the end." },
    },
    ["section"],
    (args) => {
      const spec = (args.section ?? {}) as Record<string, unknown>;
      const section: ArtSectionData = {
        id: spec.id !== undefined ? str(spec.id) : newId("sec"),
        title: str(spec.title),
        ...(spec.subtitle !== undefined ? { subtitle: str(spec.subtitle) } : {}),
        pieces: [],
      };
      if (adapter.getValue().sections.some((s) => s.id === section.id)) {
        return errorResult(`Section id ${section.id} already exists`);
      }
      const insertAt =
        args.index !== undefined
          ? Math.max(0, Math.min(num(args.index), adapter.getValue().sections.length))
          : adapter.getValue().sections.length;
      adapter.setValue((prev) => ({
        sections: [...prev.sections.slice(0, insertAt), section, ...prev.sections.slice(insertAt)],
      }));
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: "artboard",
        action: "artboard_add_section",
        label: `Added section ${section.id}`,
        undo: () => adapter.setValue((prev) => ({ sections: prev.sections.filter((s) => s.id !== section.id) })),
        redo: () =>
          adapter.setValue((prev) => ({
            sections: [...prev.sections.slice(0, insertAt), section, ...prev.sections.slice(insertAt)],
          })),
      });
      return textResult(`Added section ${section.id}`, section);
    },
    abTarget,
  );

  reg(
    "artboard_rename_section",
    "Set a section's title and optionally its subtitle.",
    { sectionId: { type: "string" }, title: { type: "string" }, subtitle: { type: "string" } },
    ["sectionId", "title"],
    (args) => {
      const sectionId = str(args.sectionId);
      const existing = adapter.getValue().sections.find((s) => s.id === sectionId);
      if (!existing) return errorResult(`No section with id ${sectionId}`);
      const prevTitle = existing.title;
      const prevSubtitle = existing.subtitle;
      const title = str(args.title);
      const hasSubtitle = args.subtitle !== undefined;
      const subtitle = hasSubtitle ? str(args.subtitle) : prevSubtitle;
      const apply = (t: string, sub: string | undefined) =>
        adapter.setValue((prev) => ({
          sections: prev.sections.map((s) =>
            s.id !== sectionId
              ? s
              : { ...s, title: t, ...(sub !== undefined ? { subtitle: sub } : {}) },
          ),
        }));
      apply(title, subtitle);
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: "artboard",
        action: "artboard_rename_section",
        label: `Renamed section ${sectionId}`,
        undo: () => apply(prevTitle, prevSubtitle),
        redo: () => apply(title, subtitle),
      });
      return textResult(`Renamed section ${sectionId} → "${title}"`, { id: sectionId, title, subtitle });
    },
    abTarget,
  );

  // ───────────── Viewport ─────────────

  reg(
    "artboard_set_viewport",
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
    abTarget,
  );

  return {
    id: "artboard",
    title: "Artboard",
    dispose: () => {
      for (const d of disposers) d();
      adapter.setAgentCursor?.(null);
    },
  };
}
