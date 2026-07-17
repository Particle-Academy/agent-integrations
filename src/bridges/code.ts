import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";
import { pushUndoEntry } from "../undo/undo-stack";
import type { AgentTarget } from "../presence/types";

/** Streaming append is a UX nicety; large content must use code_set_value. */
const MAX_STREAM_CHARS = 10_000;

/**
 * Adapter the host wires to a fancy-code CodeEditor (typically via the
 * useCodeEditor hook's context value).
 */
export type CodeBridgeAdapter = {
  /** Stable id for this editor instance. */
  id: string;
  /** Display label. */
  title?: string;
  /** Optional fancy-screens screen id. */
  screenId?: string;
  /** Read the current document text. */
  getValue: () => string;
  /** Replace the document. */
  setValue: (value: string) => void;
  /** Read the current selection text (empty string if none). */
  getSelection?: () => string;
  /** Replace the current selection with text. */
  replaceSelection?: (text: string) => void;
  /** Programmatic focus. */
  focus?: () => void;
  /** Read / set the active language. */
  getLanguage?: () => string;
  /** Set the active language. */
  setLanguage?: (lang: string) => void;
};

export type CodeBridgeOptions = {
  adapter: CodeBridgeAdapter;
  agent?: { id: string; name?: string; color?: string };
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };

/**
 * registerCodeBridge — schema-aware MCP access to a single CodeEditor.
 * Tools cover read, full replace, append, selection replace, language
 * switch, and a streaming append helper for "type characters into the
 * editor over time" UX.
 */
export function registerCodeBridge(
  host: ToolHost,
  options: CodeBridgeOptions,
): Bridge {
  const { adapter } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const disposers: Array<() => void> = [];

  // agent_undo / agent_redo / agent_history are registered whenever any bridge
  // mounts, so undo availability doesn't hinge on which bridges are co-present.
  ensureUndoToolsRegistered(host, { defaultAgentId: agent.id });

  const target: AgentTarget = {
    kind: "code",
    screenId: adapter.screenId,
    elementId: adapter.id,
    label: adapter.title ?? adapter.id,
  };

  // Record a reversible document edit so agent_undo/redo actually work for code
  // (they were registered but the code bridge pushed nothing — false
  // recoverability). Captures the whole-document before/after; restore is a
  // full setValue either way.
  const recordUndo = (action: string, label: string, prevValue: string, nextValue: string): void => {
    pushUndoEntry(agent.id, {
      timestamp: Date.now(),
      bridgeId: "code",
      action,
      label,
      undo: () => adapter.setValue(prevValue),
      redo: () => adapter.setValue(nextValue),
    });
  };

  const reg = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: JsonObject) => Promise<any> | any,
    isMutation: boolean,
  ) => {
    const wrapped = async (args: JsonObject) => {
      try {
        return await handler(args);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    };
    const final = isMutation
      ? wrapToolWithActivity(wrapped, {
          toolName: name,
          agent,
          kind: "code",
          screenId: adapter.screenId,
          resolveTarget: () => target,
        })
      : wrapped;
    disposers.push(
      host.registerTool(
        {
          name,
          description,
          inputSchema: { type: "object", properties: properties as any, required, additionalProperties: false },
        },
        final as any,
      ),
    );
  };

  reg(
    "code_describe",
    `Describe the editor "${adapter.id}" — language + length + has-selection.`,
    {},
    [],
    () => {
      const value = adapter.getValue();
      const language = adapter.getLanguage?.() ?? "unknown";
      const summary = { id: adapter.id, language, length: value.length, lines: value.split("\n").length };
      return textResult(JSON.stringify(summary), summary);
    },
    false,
  );

  reg(
    "code_get_value",
    "Read the full document text.",
    {},
    [],
    () => {
      const value = adapter.getValue();
      return textResult(value, { value });
    },
    false,
  );

  reg(
    "code_get_selection",
    "Read the currently-selected text (empty string if no selection).",
    {},
    [],
    () => {
      if (!adapter.getSelection) return errorResult("Host did not provide getSelection.");
      const value = adapter.getSelection();
      return textResult(value, { value });
    },
    false,
  );

  reg(
    "code_set_value",
    "Replace the entire document.",
    { value: { type: "string" } },
    ["value"],
    (args) => {
      const value = String(args.value ?? "");
      const prev = adapter.getValue();
      adapter.setValue(value);
      recordUndo("code_set_value", "Replace document", prev, value);
      return textResult(`Replaced document (${value.length} chars)`, { length: value.length });
    },
    true,
  );

  reg(
    "code_append",
    "Append text to the end of the document.",
    { text: { type: "string" } },
    ["text"],
    (args) => {
      const text = String(args.text ?? "");
      const prev = adapter.getValue();
      const next = prev + text;
      adapter.setValue(next);
      recordUndo("code_append", `Append ${text.length} chars`, prev, next);
      return textResult(`Appended ${text.length} chars`, { length: next.length });
    },
    true,
  );

  reg(
    "code_stream_append",
    "Type characters into the document one at a time so the human can read it forming. Returns when streaming finishes.",
    {
      text: { type: "string" },
      cps: { type: "number", description: "Characters per second. Default 25." },
    },
    ["text"],
    async (args) => {
      const text = String(args.text ?? "");
      if (text.length > MAX_STREAM_CHARS) {
        return errorResult(
          `Text too long to stream (${text.length} > ${MAX_STREAM_CHARS}). Use code_set_value / code_append for large content.`,
        );
      }
      const cps = Math.max(1, Number(args.cps ?? 25));
      const interval = Math.max(8, Math.round(1000 / cps));
      const start = adapter.getValue();
      for (let i = 1; i <= text.length; i++) {
        adapter.setValue(start + text.slice(0, i));
        if (i < text.length) await new Promise((r) => setTimeout(r, interval));
      }
      recordUndo("code_stream_append", `Append ${text.length} chars`, start, start + text);
      return textResult(`Streamed ${text.length} chars`, { length: text.length });
    },
    true,
  );

  reg(
    "code_replace_selection",
    "Replace the currently-selected text with the supplied text.",
    { text: { type: "string" } },
    ["text"],
    (args) => {
      if (!adapter.replaceSelection) return errorResult("Host did not provide replaceSelection.");
      // No selection-range API, so restore is whole-document before/after.
      const prev = adapter.getValue();
      adapter.replaceSelection(String(args.text ?? ""));
      recordUndo("code_replace_selection", "Replace selection", prev, adapter.getValue());
      return textResult("Selection replaced", { });
    },
    true,
  );

  reg(
    "code_set_language",
    "Switch the active syntax highlighting / formatter.",
    { language: { type: "string", description: "e.g. 'javascript', 'php', 'sql'." } },
    ["language"],
    (args) => {
      if (!adapter.setLanguage) return errorResult("Host did not provide setLanguage.");
      const lang = String(args.language ?? "");
      const prevLang = adapter.getLanguage?.();
      adapter.setLanguage(lang);
      if (prevLang !== undefined) {
        pushUndoEntry(agent.id, {
          timestamp: Date.now(),
          bridgeId: "code",
          action: "code_set_language",
          label: `Language → ${lang}`,
          undo: () => adapter.setLanguage?.(prevLang),
          redo: () => adapter.setLanguage?.(lang),
        });
      }
      return textResult(`Language → ${lang}`, { language: lang });
    },
    true,
  );

  reg(
    "code_focus",
    "Move browser focus to the editor.",
    {},
    [],
    () => {
      if (!adapter.focus) return errorResult("Host did not provide focus.");
      adapter.focus();
      return textResult("Focused", { });
    },
    // Focus is not a document mutation — don't broadcast it as one or log undo.
    false,
  );

  return {
    id: `code:${adapter.id}`,
    title: adapter.title ?? adapter.id,
    dispose: () => {
      for (const d of disposers) d();
    },
  };
}
