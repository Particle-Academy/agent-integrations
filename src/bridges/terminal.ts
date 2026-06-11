import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";
import type { AgentTarget } from "../presence/types";

/**
 * A shell/profile an agent can switch the terminal to. Mirrors fancy-term's
 * `ShellProfile` (kept local so the bridge never imports fancy-term).
 */
export type TerminalShell = { id: string; label: string; icon?: string };

/**
 * Host-provided window into a terminal surface (e.g. a fancy-term `<Terminal>`'s
 * `TerminalHandle`). The bridge never touches the DOM — it reads + writes through
 * these functions, so it works with any terminal the host wires up.
 */
export type TerminalBridgeAdapter = {
  /** fancy-screens screen id (optional) so activity events know which screen the terminal lives in. */
  screenId?: string;
  /** Read the visible terminal buffer as text (wire to `TerminalHandle.getBuffer`). */
  getBuffer: () => string;
  /** Write raw data / keystrokes to the terminal (wire to `TerminalHandle.write`). */
  write: (data: string) => void;
  /** Run a command. Defaults to writing `${command}\r` (submit to a PTY); override to call a real command runner. */
  runCommand?: (command: string) => void | Promise<void>;
  /** Optional: clear the terminal viewport (wire to `TerminalHandle.clear`). */
  clear?: () => void;
  /** Optional: the shells the host offers (cmd, powershell, git-bash, …). Enables `terminal_list_shells`. */
  listShells?: () => TerminalShell[];
  /** Optional: switch the active shell by id (wire to `TerminalHandle.setShell` + a host backend reconnect). Enables `terminal_set_shell`. */
  setShell?: (id: string) => void | Promise<void>;
  /** Optional: the currently active shell id (wire to `TerminalHandle.getShell`). */
  getShell?: () => string | undefined;
};

type StagedKind = "write" | "run";
type Staged = { id: string; kind: StagedKind; data: string };

export type TerminalBridgeOptions = {
  adapter: TerminalBridgeAdapter;
  agent?: { id: string; name?: string; color?: string };
  /**
   * Trust-but-verify (Human+ contract for inhabited surfaces). When on,
   * `terminal_write` + `terminal_run` don't execute — they **stage** the command
   * (returning a pending id) and fire `onPending`. A human confirms via the
   * `terminal_confirm` tool or the returned bridge's `confirm(id)`. Default off.
   */
  pendingMode?: boolean;
  /** Notified when a command is staged (pendingMode) — show it + offer confirm / reject. */
  onPending?: (pending: Staged) => void;
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
 * registerTerminalBridge — MCP access to a terminal surface. An agent reads the
 * visible buffer (`terminal_read`), writes input (`terminal_write`), and runs
 * commands (`terminal_run`) through the host adapter; every mutation broadcasts
 * an `AgentActivity` event. With `pendingMode`, destructive actions are staged
 * for human confirmation (`terminal_confirm` / `terminal_reject` /
 * `terminal_pending`). When the adapter offers shells, the agent can also list
 * (`terminal_list_shells`) and switch (`terminal_set_shell`) the active shell —
 * cmd, PowerShell, Git Bash, etc. Tool prefix `terminal_*`.
 */
export function registerTerminalBridge(host: ToolHost, options: TerminalBridgeOptions): TerminalBridge {
  const { adapter } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const pendingMode = options.pendingMode ?? false;
  const disposers: Array<() => void> = [];
  const staged = new Map<string, Staged>();
  let seq = 0;

  // Enables agent_history (a log of what agents did across every bridge).
  ensureUndoToolsRegistered(host);

  const target = (label?: string): AgentTarget => ({
    kind: "terminal",
    screenId: adapter.screenId,
    elementId: adapter.screenId ?? "terminal",
    label: label ?? "terminal",
  });

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
          screenId: adapter.screenId,
          resolveTarget: ({ args, result }) => resolveTarget?.(args, result) ?? target(),
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

  async function exec(kind: StagedKind, data: string): Promise<void> {
    if (kind === "run") {
      if (adapter.runCommand) await adapter.runCommand(data);
      else adapter.write(data + "\r");
    } else {
      adapter.write(data);
    }
  }

  async function stageOrExec(kind: StagedKind, data: string) {
    if (!pendingMode) {
      await exec(kind, data);
      return textResult(`${kind === "run" ? "ran" : "wrote"}: ${truncate(data)}`, { kind, data, executed: true });
    }
    const id = `t${++seq}`;
    const entry: Staged = { id, kind, data };
    staged.set(id, entry);
    options.onPending?.(entry);
    return textResult(
      `Staged ${kind} (id ${id}) — awaiting human confirmation: ${truncate(data)}`,
      { ...entry, pending: true },
    );
  }

  // ── Read ──────────────────────────────────────────────────────────────────
  reg(
    "terminal_read",
    "Read the visible terminal buffer as text — what the user sees. Pass `tail` for only the last N lines.",
    { tail: { type: "number", description: "Return only the last N lines." } },
    [],
    (args) => {
      let buf = adapter.getBuffer();
      const tail = typeof args.tail === "number" ? args.tail : undefined;
      if (tail && tail > 0) buf = buf.split("\n").slice(-tail).join("\n");
      return textResult(buf, { buffer: buf });
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
        list.length ? list.map((s) => `${s.id}: ${s.kind} ${truncate(s.data)}`).join("\n") : "(none)",
        { pending: list },
      );
    },
    false,
  );

  // ── Mutations ───────────────────────────────────────────────────────────────
  reg(
    "terminal_write",
    "Write raw data / keystrokes to the terminal (input, control chars, ANSI). In pendingMode this stages instead of executing.",
    { data: { type: "string", description: "Raw bytes to write." } },
    ["data"],
    (args) => stageOrExec("write", String(args.data)),
    true,
  );

  reg(
    "terminal_run",
    "Run a shell command — writes the command followed by Enter (or the host's command runner). In pendingMode this stages it for confirmation.",
    { command: { type: "string", description: "The command line to run." } },
    ["command"],
    (args) => stageOrExec("run", String(args.command)),
    true,
    (args) => target(truncate(String(args.command ?? ""))),
  );

  reg(
    "terminal_confirm",
    "Confirm + execute a staged command by id (pendingMode).",
    { id: { type: "string" } },
    ["id"],
    async (args) => {
      const id = String(args.id);
      const entry = staged.get(id);
      if (!entry) return errorResult(`No staged command ${id}`);
      staged.delete(id);
      await exec(entry.kind, entry.data);
      return textResult(`Confirmed ${id}: ${entry.kind} ${truncate(entry.data)}`, { ...entry, executed: true });
    },
    true,
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

  if (adapter.clear) {
    reg(
      "terminal_clear",
      "Clear the terminal viewport.",
      {},
      [],
      () => {
        adapter.clear!();
        return textResult("cleared");
      },
      true,
    );
  }

  // ── Shells ──────────────────────────────────────────────────────────────────
  if (adapter.listShells) {
    reg(
      "terminal_list_shells",
      "List the shells the host can switch to (cmd, PowerShell, Git Bash, …) — id + label, with the active one marked.",
      {},
      [],
      () => {
        const shells = adapter.listShells!();
        const active = adapter.getShell?.();
        const text = shells.length
          ? shells.map((s) => `${s.id === active ? "* " : "  "}${s.id} — ${s.label}`).join("\n")
          : "(none)";
        return textResult(text, { shells, active });
      },
      false,
    );
  }

  if (adapter.setShell) {
    reg(
      "terminal_set_shell",
      "Switch the active shell by id (e.g. 'powershell', 'git-bash'). Call terminal_list_shells first for valid ids. The host reconnects its backend to the chosen shell.",
      { id: { type: "string", description: "Shell id to switch to." } },
      ["id"],
      async (args) => {
        const id = String(args.id);
        const shells = adapter.listShells?.();
        if (shells && shells.length && !shells.some((s) => s.id === id)) {
          return errorResult(`Unknown shell '${id}'. Use terminal_list_shells for valid ids.`);
        }
        await adapter.setShell!(id);
        return textResult(`Switched shell to ${id}`, { shell: id });
      },
      true,
      (args) => target(`shell:${String(args.id ?? "")}`),
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
        staged.delete(id);
        void exec(e.kind, e.data);
      }
    },
    reject: (id: string) => {
      staged.delete(id);
    },
    pending: () => [...staged.values()],
  };
}
