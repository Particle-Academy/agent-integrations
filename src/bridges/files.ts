// Loose types so this bridge builds standalone without a hard dep on
// @particle-academy/react-fancy. Hosts using FileBrowser pass its own
// FileEntry / FileSnapshotNode values straight through — the shapes match.
type FileKind = "file" | "dir";
type FileEntry = {
  path: string;
  name: string;
  kind: FileKind;
  size?: number;
  mtime?: string;
  hasChildren?: boolean;
  disabled?: boolean;
};
type FileSnapshotNode = FileEntry & { children?: FileSnapshotNode[] };

import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import type { AgentTarget as FilesAgentTarget } from "../presence/types";
import { pushUndoEntry } from "../undo/undo-stack";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";

/**
 * Adapter the host provides — getters/setters over the SAME controlled props it
 * passes to react-fancy's `<FileBrowser>` (`value`/`path`/`expandedPaths`), plus
 * `listChildren` (wire to your `provider.loadChildren` or the loaded cache) and,
 * for snapshot mode, an optional `requestSnapshot`.
 */
export type FilesBridgeAdapter = {
  /** Current directory (the `path` prop). */
  getPath: () => string;
  setPath: (path: string) => void;
  /** Selected path(s) — normalize FileBrowser's `value` (string | string[] | null) to an array. */
  getSelection: () => string[];
  setSelection: (paths: string[]) => void;
  /** Expanded folder paths (the `expandedPaths` prop). */
  getExpanded: () => string[];
  setExpanded: (next: string[] | ((prev: string[]) => string[])) => void;
  /** Direct children of a path — wire to `provider.loadChildren` (async) or the loaded/snapshot cache. */
  listChildren: (path: string) => Promise<FileEntry[]> | FileEntry[];
  /** Optional (snapshot mode): fetch/refresh a snapshot subtree so an agent can pull remote state on demand. */
  requestSnapshot?: (path: string, depth?: number) => Promise<FileSnapshotNode[]> | FileSnapshotNode[];
};

export type FilesBridgeOptions = {
  adapter: FilesBridgeAdapter;
  /** Identity tagged onto agent-driven actions. */
  agent?: { id: string; name?: string; color?: string };
  /**
   * Optional containment root. When set, every agent-supplied path is checked
   * with {@link assertPathWithinRoot} before it reaches the adapter: a `..`
   * segment or an absolute path outside `root` is rejected. This is a
   * fail-closed, string-level guard (no filesystem access — the bridge runs in
   * the browser). It is NOT sufficient on its own: a host over a real
   * filesystem MUST additionally resolve symlinks/junctions (realpath) and
   * enforce the root, because a link under `root` can still point outside it.
   * When `root` is unset the bridge does no containment and the adapter is
   * SOLELY responsible for sandboxing what `listChildren`/`requestSnapshot` expose.
   */
  root?: string;
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };

/** Host default cap on snapshot recursion, so an agent can't request an
 *  unbounded deep walk. */
const MAX_SNAPSHOT_DEPTH = 8;

/**
 * Fail-closed, filesystem-free path containment. Throws when `path` contains a
 * `..` segment, or is absolute and not within `root`. Relative paths without
 * `..` pass (resolved within root by the host). String-level only — see the
 * `root` docs: hosts over a real fs must ALSO realpath to defeat symlinks.
 */
export function assertPathWithinRoot(root: string, path: string): void {
  const segments = path.replace(/[\\/]+/g, "/").split("/");
  if (segments.includes("..")) {
    throw new Error(`Path may not contain '..': ${path}`);
  }
  const isAbsolute = /^([A-Za-z]:)?[\\/]/.test(path) || /^[A-Za-z]:/.test(path);
  if (isAbsolute) {
    const norm = (p: string): string => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
    const r = norm(root);
    const p = norm(path);
    if (p !== r && !p.startsWith(r + "/")) {
      throw new Error(`Path escapes the configured root: ${path}`);
    }
  }
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback?: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback ?? 0;
const asPaths = (v: unknown): string[] => {
  if (typeof v === "string") {
    return [v];
  }
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string");
  }
  return [];
};

/**
 * registerFilesBridge — an MCP tool set over a react-fancy `<FileBrowser>`'s
 * controlled state, so a human and an agent share one file browser. The agent
 * lists a folder's children, navigates, expands/collapses folders, selects
 * entries, and (in snapshot mode) requests a fresh subtree — driving the same
 * `value`/`path`/`expandedPaths` props, no DOM scraping. Every mutation
 * broadcasts AgentActivity (presence) and pushes an undo entry. Mirrors the
 * map / whiteboard / flow bridges in shape.
 *
 * Read-only browse in v1: no content preview (pair with fancy-code's
 * FileViewer) and no write ops (rename/delete/upload) — those arrive later
 * behind a pendingMode-gated iteration.
 */
export function registerFilesBridge(host: ToolHost, options: FilesBridgeOptions): Bridge {
  const { adapter } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const disposers: Array<() => void> = [];

  // Reject traversal / out-of-root paths before they reach the adapter (no-op
  // when no root is configured — the adapter is then responsible for sandboxing).
  const guard = (path: string): string => {
    if (options.root !== undefined) assertPathWithinRoot(options.root, path);
    return path;
  };

  // Register agent_undo / agent_redo / agent_history once per host. Idempotent.
  ensureUndoToolsRegistered(host, { defaultAgentId: agent.id });

  const fTarget = (args: any, _result: any): FilesAgentTarget => ({
    kind: "files",
    elementId: (args?.path as string | undefined) ?? undefined,
  });

  const reg = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: JsonObject) => Promise<any> | any,
    resolveTarget?: (args: JsonObject, result: any) => FilesAgentTarget | null,
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
          kind: "files",
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

  reg(
    "files_get_state",
    "Get the file browser's current directory, selected path(s), and expanded folders.",
    {},
    [],
    () => {
      const state = {
        path: adapter.getPath(),
        selected: adapter.getSelection(),
        expanded: adapter.getExpanded(),
      };
      return textResult(JSON.stringify(state, null, 2), state);
    },
  );

  reg(
    "files_list",
    "List the direct children of a folder (files + subfolders). Omit `path` for the current directory. Loads lazily from the host's provider/snapshot — never an eager tree walk.",
    { path: { type: "string", description: "Folder path to list; defaults to the current directory." } },
    [],
    async (args) => {
      const path = guard(args.path !== undefined ? str(args.path) : adapter.getPath());
      const entries = await adapter.listChildren(path);
      const summary = entries.map((e) => ({
        path: e.path,
        name: e.name,
        kind: e.kind,
        ...(e.size !== undefined ? { size: e.size } : {}),
        ...(e.mtime !== undefined ? { mtime: e.mtime } : {}),
      }));
      const text =
        summary.map((e) => `${e.kind === "dir" ? "📁" : "📄"} ${e.path}`).join("\n") ||
        `(empty: ${path})`;
      return textResult(text, { path, entries: summary });
    },
  );

  // ───────────── Navigation ─────────────

  reg(
    "files_navigate",
    "Set the current directory (as if the user clicked a breadcrumb or opened a folder).",
    { path: { type: "string" } },
    ["path"],
    (args) => {
      const path = guard(str(args.path));
      const prev = adapter.getPath();
      adapter.setPath(path);
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: "files",
        action: "files_navigate",
        label: `Navigated to ${path}`,
        undo: () => adapter.setPath(prev),
        redo: () => adapter.setPath(path),
      });
      return textResult(`Current directory → ${path}`, { path });
    },
    fTarget,
  );

  // ───────────── Expansion ─────────────

  reg(
    "files_expand",
    "Expand a folder in the tree (loads its children if needed).",
    { path: { type: "string" } },
    ["path"],
    (args) => {
      const path = guard(str(args.path));
      if (adapter.getExpanded().includes(path)) {
        return textResult(`${path} already expanded`, { path, expanded: true });
      }
      adapter.setExpanded((prev) => [...prev, path]);
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: "files",
        action: "files_expand",
        label: `Expanded ${path}`,
        undo: () => adapter.setExpanded((prev) => prev.filter((p) => p !== path)),
        redo: () => adapter.setExpanded((prev) => (prev.includes(path) ? prev : [...prev, path])),
      });
      return textResult(`Expanded ${path}`, { path, expanded: true });
    },
    fTarget,
  );

  reg(
    "files_collapse",
    "Collapse a folder in the tree.",
    { path: { type: "string" } },
    ["path"],
    (args) => {
      const path = guard(str(args.path));
      if (!adapter.getExpanded().includes(path)) {
        return textResult(`${path} already collapsed`, { path, expanded: false });
      }
      adapter.setExpanded((prev) => prev.filter((p) => p !== path));
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: "files",
        action: "files_collapse",
        label: `Collapsed ${path}`,
        undo: () => adapter.setExpanded((prev) => (prev.includes(path) ? prev : [...prev, path])),
        redo: () => adapter.setExpanded((prev) => prev.filter((p) => p !== path)),
      });
      return textResult(`Collapsed ${path}`, { path, expanded: false });
    },
    fTarget,
  );

  // ───────────── Selection ─────────────

  reg(
    "files_select",
    "Set the selection to the given path(s). Pass a single `path`, or `paths` for a multi-select browser; either empty clears the selection.",
    {
      path: { type: "string", description: "A single path to select." },
      paths: { type: "array", items: { type: "string" }, description: "Multiple paths (multi-select browsers)." },
    },
    [],
    (args) => {
      const next = (args.paths !== undefined ? asPaths(args.paths) : asPaths(args.path)).map(guard);
      const prev = adapter.getSelection();
      adapter.setSelection(next);
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: "files",
        action: "files_select",
        label: next.length ? `Selected ${next.join(", ")}` : "Cleared selection",
        undo: () => adapter.setSelection(prev),
        redo: () => adapter.setSelection(next),
      });
      return textResult(next.length ? `Selected ${next.join(", ")}` : "Cleared selection", {
        selected: next,
      });
    },
    fTarget,
  );

  // ───────────── Snapshot (streamed remote trees) ─────────────

  reg(
    "files_request_snapshot",
    "Request a fresh snapshot subtree rooted at `path` (snapshot mode) — e.g. to pull a remote machine's current tree. Requires the host to wire requestSnapshot.",
    {
      path: { type: "string", description: "Root of the subtree; defaults to the current directory." },
      depth: { type: "number", description: "How many levels deep to materialize (host-defined default)." },
    },
    [],
    async (args) => {
      if (!adapter.requestSnapshot) {
        return errorResult("Host did not wire requestSnapshot (snapshot mode not enabled).");
      }
      const path = guard(args.path !== undefined ? str(args.path) : adapter.getPath());
      // Clamp depth so an agent can't demand an unbounded recursive walk.
      const depth =
        args.depth !== undefined ? Math.max(0, Math.min(MAX_SNAPSHOT_DEPTH, num(args.depth))) : undefined;
      const tree = await adapter.requestSnapshot(path, depth);
      const count = Array.isArray(tree) ? tree.length : 0;
      return textResult(`Snapshot of ${path}: ${count} top-level entr${count === 1 ? "y" : "ies"}.`, {
        path,
        snapshot: tree,
      });
    },
    fTarget,
  );

  return {
    id: "files",
    title: "Files",
    dispose: () => {
      for (const d of disposers) d();
    },
  };
}
