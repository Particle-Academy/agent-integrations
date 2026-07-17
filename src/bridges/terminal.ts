import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { CallToolResult, JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";
import type { AgentTarget } from "../presence/types";

/**
 * A shell/profile an agent can switch a terminal to. Mirrors fancy-term's
 * `ShellProfile` (kept local so the bridge never imports fancy-term).
 */
export type TerminalShell = { id: string; label: string; icon?: string };

/**
 * One terminal the bridge can drive. A Human+ app often hosts **several**
 * terminals on a screen (a build pane, a server pane, an agent scratch shell);
 * each is a `TerminalRef` with a stable `id` so an agent can read/write any of
 * them — not just "its own". Wire the function fields to that terminal's
 * fancy-term `TerminalHandle`.
 */
export type TerminalRef = {
  /** Stable id used to address this terminal (`terminal_list` enumerates them). */
  id: string;
  /** Human label, e.g. "Build", "Server". Defaults to the id. */
  label?: string;
  /** True for the focused terminal — the default target when no id is passed. */
  active?: boolean;
  /** Read the visible buffer as text (wire to `TerminalHandle.getBuffer`). */
  getBuffer: () => string;
  /** Write raw data / keystrokes (wire to `TerminalHandle.write`). */
  write: (data: string) => void;
  /** Run a command. Defaults to writing `${command}\r`; override for a real runner. */
  runCommand?: (command: string) => void | Promise<void>;
  /** Clear the viewport (wire to `TerminalHandle.clear`). */
  clear?: () => void;
  /** Current text selection (wire to `TerminalHandle.getSelection`). */
  getSelection?: () => string;
  /** Shells this terminal offers (cmd, PowerShell, …). */
  listShells?: () => TerminalShell[];
  /** Switch this terminal's active shell by id. */
  setShell?: (id: string) => void | Promise<void>;
  /** This terminal's active shell id. */
  getShell?: () => string | undefined;
};

/**
 * Single-terminal adapter (back-compat). A `TerminalRef` without the
 * `id`/`label`/`active` bookkeeping — pass it as `{ adapter }` and the bridge
 * treats it as the one (active) terminal. Use `{ terminals }` for multiple.
 */
export type TerminalBridgeAdapter = Omit<TerminalRef, "id" | "label" | "active"> & {
  /** fancy-screens screen id (optional) so activity events know which screen the terminal lives in. */
  screenId?: string;
};

type StagedKind = "write" | "run";
type Staged = { id: string; kind: StagedKind; data: string; terminalId: string };

export type TerminalBridgeOptions = {
  /** A single terminal (back-compat). Mutually exclusive with `terminals`. */
  adapter?: TerminalBridgeAdapter;
  /**
   * The live list of terminals on the screen. Use this when the app hosts more
   * than one terminal so an agent can `terminal_list` then target any of them by
   * id — i.e. reach into another terminal in the same screen.
   */
  terminals?: () => TerminalRef[];
  /** fancy-screens screen id for activity events (defaults to `adapter.screenId`). */
  screenId?: string;
  agent?: { id: string; name?: string; color?: string };
  /**
   * Trust-but-verify (Human+ contract for inhabited surfaces). When on,
   * `terminal_write` + `terminal_run` don't execute — they **stage** the command
   * (returning a pending id) and fire `onPending`. A human confirms via the
   * returned bridge's `confirm(id)` (wire it to a human-only control).
   *
   * **Default: ON.** The terminal is the most dangerous surface (arbitrary shell),
   * and possession of the relay session token = permission to call every tool, so
   * it must fail SAFE. Pass `false` only for a fully-trusted, non-shared terminal
   * where auto-execution is acceptable. A host that leaves this on MUST wire a
   * human confirm path (`onPending` + `bridge.confirm`), or staged commands never run.
   */
  pendingMode?: boolean;
  /** Notified when a command is staged (pendingMode) — show it + offer confirm / reject. */
  onPending?: (pending: Staged) => void;
  /**
   * Expose `terminal_confirm` / `terminal_reject` as agent-callable tools.
   * **Default: false** — otherwise the *same* agent that staged a command could
   * confirm it, defeating the human-in-the-loop. Leave off and confirm via the
   * returned `bridge.confirm(id)` wired to a human control.
   */
  allowAgentConfirm?: boolean;
  /**
   * Per-terminal authorization. Return false to hide a terminal id from this
   * agent entirely (it won't appear in `terminal_list` and can't be targeted).
   * Use it to scope an agent to its own pane(s); without it, `{ terminals }`
   * grants the agent full read/write over EVERY terminal in the list.
   */
  canAccess?: (terminalId: string) => boolean;
};

export type TerminalBridge = Bridge & {
  /** Execute a staged command by id — wire a host confirm button to this. No-op if not pending. */
  confirm: (id: string) => void;
  /** Drop a staged command by id without executing. */
  reject: (id: string) => void;
  /** Commands currently awaiting confirmation. */
  pending: () => Staged[];
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };

const truncate = (s: string, n = 60): string => (s.length > n ? s.slice(0, n) + "…" : s);

/**
 * registerTerminalBridge — MCP access to one **or many** terminal surfaces on a
 * screen. An agent reads the visible buffer (`terminal_read`), writes input
 * (`terminal_write`), and runs commands (`terminal_run`) through the host; every
 * mutation broadcasts an `AgentActivity` event. With `pendingMode`, destructive
 * actions are staged for human confirmation (`terminal_confirm` / `terminal_reject`
 * / `terminal_pending`).
 *
 * **Multi-terminal:** pass `{ terminals }` (vs a single `{ adapter }`) and every
 * tool takes an optional `terminal` id; `terminal_list` enumerates them. This is
 * how an agent **reaches into another terminal in the same screen** rather than
 * being stuck in one. When a terminal offers shells, the agent can also list
 * (`terminal_list_shells`) and switch (`terminal_set_shell`) its shell. Tool
 * prefix `terminal_*`.
 */
export function registerTerminalBridge(host: ToolHost, options: TerminalBridgeOptions): TerminalBridge {
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  // Safe-by-default: the terminal stages for human confirmation unless a host
  // explicitly opts a trusted, non-shared terminal into auto-exec (see the
  // pendingMode docs). Every other write bridge already defaults to staged.
  const pendingMode = options.pendingMode ?? true;
  const screenId = options.screenId ?? options.adapter?.screenId;
  const disposers: Array<() => void> = [];
  const staged = new Map<string, Staged>();
  let seq = 0;

  // Enables agent_history (a log of what agents did across every bridge).
  ensureUndoToolsRegistered(host);

  // The live terminal list — from `terminals()` (multi) or the single `adapter`
  // normalized to one active ref with the id "terminal".
  const listTerminals = (): TerminalRef[] => {
    const all = options.terminals
      ? options.terminals()
      : options.adapter
        ? [{ id: "terminal", label: "Terminal", active: true, ...options.adapter }]
        : [];
    // Per-terminal ACL: an agent can only see/target terminals it's allowed to.
    return options.canAccess ? all.filter((t) => options.canAccess!(t.id)) : all;
  };

  /** Resolve a terminal by id; with no id, the active one, else the first. */
  const resolve = (id?: unknown): TerminalRef | undefined => {
    const list = listTerminals();
    if (typeof id === "string" && id !== "") return list.find((t) => t.id === id);
    return list.find((t) => t.active) ?? list[0];
  };

  // Whether any host config can offer these capabilities (gates tool registration;
  // per-call we still check the *resolved* terminal supports it).
  const anyMulti = !!options.terminals;
  const canClear = anyMulti || !!options.adapter?.clear;
  const canShells = anyMulti || !!options.adapter?.listShells;
  const canSetShell = anyMulti || !!options.adapter?.setShell;

  const target = (label?: string, terminalId?: string): AgentTarget => ({
    kind: "terminal",
    screenId,
    elementId: terminalId ?? screenId ?? "terminal",
    label: label ?? "terminal",
  });

  // Broadcast meta for terminal mutations: shape only, never the raw command /
  // keystroke bytes (those may hold secrets, and the relay fans meta to every
  // peer). Full data stays local to the tool result + onPending / bridge.confirm.
  const redactMeta = (result: CallToolResult): Record<string, unknown> | undefined => {
    const sc = result.structuredContent as Record<string, unknown> | undefined;
    if (!sc || typeof sc !== "object") return undefined;
    return {
      terminal: sc.terminal,
      kind: sc.kind,
      length: typeof sc.data === "string" ? (sc.data as string).length : undefined,
      executed: sc.executed,
      pending: sc.pending,
    };
  };

  const TERMINAL_ARG = {
    terminal: {
      type: "string",
      description: "Terminal id to target (call terminal_list for ids). Omit for the active / only terminal.",
    },
  };

  const reg = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: JsonObject) => Promise<any> | any,
    isMutation: boolean,
    resolveTarget?: (args: JsonObject, result: any) => AgentTarget | null,
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
          kind: "terminal",
          screenId,
          // A per-call resolver may return null to SKIP the broadcast (e.g. a
          // merely-staged command); only fall back to the default target when no
          // resolver was supplied.
          resolveTarget: ({ args, result }) => (resolveTarget ? resolveTarget(args, result) : target()),
          // Never fan raw command/keystroke bytes to peers — broadcast shape only.
          buildMeta: redactMeta,
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

  /** Resolve the targeted terminal or throw a clear error for the agent. */
  const need = (args: JsonObject): TerminalRef => {
    const t = resolve(args.terminal);
    if (!t) {
      const ids = listTerminals().map((x) => x.id).join(", ") || "(none)";
      throw new Error(
        typeof args.terminal === "string" && args.terminal
          ? `Unknown terminal '${args.terminal}'. Available: ${ids}. Use terminal_list.`
          : "No terminal available.",
      );
    }
    return t;
  };

  async function exec(t: TerminalRef, kind: StagedKind, data: string): Promise<void> {
    if (kind === "run") {
      if (t.runCommand) await t.runCommand(data);
      else t.write(data + "\r");
    } else {
      t.write(data);
    }
  }

  async function stageOrExec(t: TerminalRef, kind: StagedKind, data: string) {
    // The human-facing summary truncates for readability, but the full payload
    // + its length ride in structuredContent / onPending so a confirm UI never
    // silently under-shows a long escape/injection payload.
    if (!pendingMode) {
      await exec(t, kind, data);
      return textResult(`${kind === "run" ? "ran" : "wrote"} on ${t.id}: ${truncate(data)}`, {
        kind,
        data,
        length: data.length,
        terminal: t.id,
        executed: true,
      });
    }
    const id = `t${++seq}`;
    const entry: Staged = { id, kind, data, terminalId: t.id };
    staged.set(id, entry);
    options.onPending?.(entry);
    return textResult(
      `Staged ${kind} on ${t.id} (id ${id}) — awaiting human confirmation: ${truncate(data)}`,
      { ...entry, length: data.length, pending: true },
    );
  }

  // ── List ──────────────────────────────────────────────────────────────────
  reg(
    "terminal_list",
    "List the terminals on this screen (id, label, which is active) — so you can reach into another terminal, not just the active one. Pass the chosen id as `terminal` to the other tools.",
    {},
    [],
    () => {
      const list = listTerminals().map((t) => ({ id: t.id, label: t.label ?? t.id, active: !!t.active }));
      const text = list.length
        ? list.map((t) => `${t.active ? "* " : "  "}${t.id} — ${t.label}`).join("\n")
        : "(no terminals)";
      return textResult(text, { terminals: list });
    },
    false,
  );

  // ── Read ──────────────────────────────────────────────────────────────────
  reg(
    "terminal_read",
    "Read a terminal's visible buffer as text — what the user sees. Pass `tail` for only the last N lines, `terminal` to read a specific one.",
    { ...TERMINAL_ARG, tail: { type: "number", description: "Return only the last N lines." } },
    [],
    (args) => {
      const t = need(args);
      let buf = t.getBuffer();
      const tail = typeof args.tail === "number" ? args.tail : undefined;
      if (tail && tail > 0) buf = buf.split("\n").slice(-tail).join("\n");
      return textResult(buf, { buffer: buf, terminal: t.id });
    },
    false,
  );

  reg(
    "terminal_pending",
    "List commands staged for human confirmation (pendingMode).",
    {},
    [],
    () => {
      const list = [...staged.values()];
      return textResult(
        list.length ? list.map((s) => `${s.id}: ${s.kind} on ${s.terminalId} ${truncate(s.data)}`).join("\n") : "(none)",
        { pending: list },
      );
    },
    false,
  );

  // ── Mutations ───────────────────────────────────────────────────────────────
  reg(
    "terminal_write",
    "Write raw data / keystrokes to a terminal (input, control chars, ANSI). Pass `terminal` to target a specific one. In pendingMode this stages instead of executing. NOTE: bytes are written verbatim — an embedded CR runs a command, and ANSI/OSC sequences reach the terminal; treat this exactly like terminal_run for gating.",
    { ...TERMINAL_ARG, data: { type: "string", description: "Raw bytes to write." } },
    ["data"],
    (args) => stageOrExec(need(args), "write", String(args.data)),
    true,
    // Skip the peer broadcast while only staged; emit once it actually executes.
    (args, result) =>
      result?.structuredContent?.pending ? null : target(`write:${String(args.terminal ?? "")}`, resolve(args.terminal)?.id),
  );

  reg(
    "terminal_run",
    "Run a shell command in a terminal — writes the command + Enter (or the host's runner). Pass `terminal` to target a specific one. In pendingMode this stages it for confirmation.",
    { ...TERMINAL_ARG, command: { type: "string", description: "The command line to run." } },
    ["command"],
    (args) => stageOrExec(need(args), "run", String(args.command)),
    true,
    (args, result) =>
      result?.structuredContent?.pending ? null : target(truncate(String(args.command ?? "")), resolve(args.terminal)?.id),
  );

  // Confirmation is HUMAN-driven by default: the acting agent must not be able to
  // confirm its own staged command (that would defeat pendingMode). Hosts confirm
  // via the returned `bridge.confirm(id)` wired to a human control. Only expose
  // the agent-callable tools when a host explicitly opts in.
  if (options.allowAgentConfirm) {
    reg(
      "terminal_confirm",
      "Confirm + execute a staged command by id (pendingMode).",
      { id: { type: "string" } },
      ["id"],
      async (args) => {
        const id = String(args.id);
        const entry = staged.get(id);
        if (!entry) return errorResult(`No staged command ${id}`);
        const t = resolve(entry.terminalId);
        if (!t) return errorResult(`Terminal '${entry.terminalId}' is gone — cannot run ${id}`);
        staged.delete(id);
        await exec(t, entry.kind, entry.data);
        return textResult(`Confirmed ${id}: ${entry.kind} on ${t.id} ${truncate(entry.data)}`, {
          ...entry,
          length: entry.data.length,
          executed: true,
        });
      },
      true,
      (args) => {
        const e = staged.get(String(args.id));
        return target(`confirm:${String(args.id ?? "")}`, e?.terminalId);
      },
    );

    reg(
      "terminal_reject",
      "Drop a staged command by id without executing it.",
      { id: { type: "string" } },
      ["id"],
      (args) => {
        const id = String(args.id);
        if (!staged.delete(id)) return errorResult(`No staged command ${id}`);
        return textResult(`Rejected ${id}`, { id, rejected: true });
      },
      false,
    );
  }

  if (canClear) {
    reg(
      "terminal_clear",
      "Clear a terminal's viewport. Pass `terminal` to target a specific one.",
      { ...TERMINAL_ARG },
      [],
      (args) => {
        const t = need(args);
        if (!t.clear) return errorResult(`Terminal '${t.id}' can't be cleared.`);
        t.clear();
        return textResult(`cleared ${t.id}`, { terminal: t.id });
      },
      true,
      (args) => target(`clear:${String(args.terminal ?? "")}`, resolve(args.terminal)?.id),
    );
  }

  // ── Shells ──────────────────────────────────────────────────────────────────
  if (canShells) {
    reg(
      "terminal_list_shells",
      "List the shells a terminal can switch to (cmd, PowerShell, Git Bash, …) — id + label, active one marked. Pass `terminal` to target a specific one.",
      { ...TERMINAL_ARG },
      [],
      (args) => {
        const t = need(args);
        if (!t.listShells) return errorResult(`Terminal '${t.id}' has no switchable shells.`);
        const shells = t.listShells();
        const active = t.getShell?.();
        const text = shells.length
          ? shells.map((s) => `${s.id === active ? "* " : "  "}${s.id} — ${s.label}`).join("\n")
          : "(none)";
        return textResult(text, { shells, active, terminal: t.id });
      },
      false,
    );
  }

  if (canSetShell) {
    reg(
      "terminal_set_shell",
      "Switch a terminal's active shell by id (e.g. 'powershell', 'git-bash'). Call terminal_list_shells first for valid ids. Pass `terminal` to target a specific one.",
      { ...TERMINAL_ARG, id: { type: "string", description: "Shell id to switch to." } },
      ["id"],
      async (args) => {
        const t = need(args);
        if (!t.setShell) return errorResult(`Terminal '${t.id}' can't switch shells.`);
        const id = String(args.id);
        // Fail closed: only allow a shell that is explicitly listed. A terminal
        // exposing setShell without listShells (or with an empty list) rejects
        // every id, so an unvalidated agent string can never reach setShell
        // (which a host may map to an executable = arbitrary-binary launch).
        const shells = t.listShells?.();
        if (!shells || !shells.some((s) => s.id === id)) {
          return errorResult(
            `Unknown or unlisted shell '${id}' for ${t.id}. Call terminal_list_shells for valid ids.`,
          );
        }
        await t.setShell(id);
        return textResult(`Switched ${t.id} shell to ${id}`, { shell: id, terminal: t.id });
      },
      true,
      (args) => target(`shell:${String(args.id ?? "")}`, resolve(args.terminal)?.id),
    );
  }

  return {
    id: "terminal",
    title: "Terminal",
    dispose: () => {
      disposers.forEach((d) => d());
      disposers.length = 0;
      staged.clear();
    },
    confirm: (id: string) => {
      const e = staged.get(id);
      if (e) {
        const t = resolve(e.terminalId);
        staged.delete(id);
        if (t) void exec(t, e.kind, e.data);
      }
    },
    reject: (id: string) => {
      staged.delete(id);
    },
    pending: () => [...staged.values()],
  };
}
