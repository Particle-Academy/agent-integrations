import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";

export type AgentActivity = {
  id: string;
  /** Wall-clock timestamp; component formats it. */
  at: number;
  /** "tool" for MCP tool invocations, "message" for chat, "info" for status. */
  kind: "tool" | "message" | "info" | "error";
  /** Short label, e.g. "whiteboard_add_sticky" or "Agent". */
  source: string;
  /** Body text. */
  text: string;
  /** Optional structured payload, rendered as collapsed JSON. */
  detail?: unknown;

  // ── Tool-call fields. Present when `kind === "tool"`; ignored otherwise. ──
  /**
   * The call's arguments. Rendered inline next to the tool name so the feed
   * reads as `tool(args) → result` — the point being that the agent's
   * reasoning is legible AS IT HAPPENS, not reconstructable afterwards from a
   * details pane nobody opens.
   */
  args?: unknown;
  /** What the call returned. */
  result?: unknown;
  /** Round-trip time in ms. Rendered as `· 142ms`. */
  durationMs?: number;
  /**
   * Lifecycle. A row can appear as `pending` the moment a call starts and be
   * replaced by the settled row, which is what makes this a STREAM rather than
   * a log. Defaults to `ok`, or `error` when `kind === "error"`.
   */
  status?: "pending" | "ok" | "error";
};

export type AgentPanelProps = {
  /** The agent's identity (name + color appears in the header). */
  agent?: { name?: string; color?: string };
  /** Activity stream. Most recent at the end. */
  activity: AgentActivity[];
  /** Optional chat composer — pass an onSubmit to enable. */
  onSubmit?: (message: string) => void;
  /** Disabled while a request is in flight. */
  busy?: boolean;
  /** Right-rail header actions. */
  actions?: ReactNode;
  className?: string;
  style?: CSSProperties;
};

/**
 * AgentPanel — sidebar showing the agent's identity, a tool-and-chat log,
 * and an optional input composer. Pure presentational: hosts feed it the
 * activity stream from their own state (typically the MCP transport log).
 */
export function AgentPanel({ agent, activity, onSubmit, busy, actions, className, style }: AgentPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activity.length]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = inputRef.current?.value.trim();
    if (!value || !onSubmit) return;
    onSubmit(value);
    if (inputRef.current) inputRef.current.value = "";
  };

  const color = agent?.color ?? "#a855f7";
  const name = agent?.name ?? "Agent";

  return (
    <div className={["fai-panel", className ?? ""].filter(Boolean).join(" ")} style={style}>
      <header className="fai-panel__header">
        <div
          className="fai-panel__avatar"
          style={{ background: color }}
          aria-hidden
        >
          {name.slice(0, 1)}
        </div>
        <div className="fai-panel__title">
          <strong>{name}</strong>
          <span className="fai-panel__subtitle">
            {busy ? "Working…" : `${activity.length} event${activity.length === 1 ? "" : "s"}`}
          </span>
        </div>
        {actions && <div className="fai-panel__actions">{actions}</div>}
      </header>

      <div ref={scrollRef} className="fai-panel__stream">
        {activity.length === 0 ? (
          <p className="fai-panel__empty">No activity yet.</p>
        ) : (
          activity.map((a) => <ActivityRow key={a.id} item={a} />)
        )}
      </div>

      {onSubmit && (
        <form className="fai-panel__composer" onSubmit={handleSubmit}>
          <textarea
            ref={inputRef}
            className="fai-panel__input"
            placeholder={busy ? "Working…" : "Ask the agent…"}
            disabled={busy}
            rows={2}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e as unknown as React.FormEvent);
              }
            }}
          />
          <button type="submit" className="fai-panel__send" disabled={busy}>
            Send
          </button>
        </form>
      )}
    </div>
  );
}

function ActivityRow({ item }: { item: AgentActivity }) {
  const time = formatTime(item.at);
  const status = item.status ?? (item.kind === "error" ? "error" : "ok");
  const isCall = item.kind === "tool" && (item.args !== undefined || item.result !== undefined || item.durationMs !== undefined);

  return (
    <div
      className={`fai-row fai-row--${item.kind}${isCall ? ` fai-row--${status}` : ""}`}
      data-fai-row=""
      data-kind={item.kind}
      data-status={isCall ? status : undefined}
    >
      <div className="fai-row__meta">
        <span className="fai-row__source">{item.source}</span>
        {isCall && item.args !== undefined && (
          <span className="fai-row__args" data-fai-args="">
            ({inline(item.args)})
          </span>
        )}
        {isCall && item.durationMs !== undefined && (
          <span className="fai-row__latency" data-fai-latency="">
            · {item.durationMs}ms
          </span>
        )}
        <span className="fai-row__time">{time}</span>
      </div>
      {isCall && item.result !== undefined && (
        <div className="fai-row__result" data-fai-result="">
          → {inline(item.result)}
        </div>
      )}
      <div className="fai-row__text">{item.text}</div>
      {item.detail !== undefined && (
        <details className="fai-row__detail">
          <summary>details</summary>
          <pre>{safeJson(item.detail)}</pre>
        </details>
      )}
    </div>
  );
}

/**
 * One-line rendering of a call's args or result.
 *
 * Truncated hard, because a feed is scanned rather than read: an untruncated
 * result payload pushes every subsequent row off the screen, which costs more
 * than the detail is worth. The full value stays available via `detail`.
 */
function inline(v: unknown, max = 80): string {
  if (typeof v === "string") return v.length > max ? `${v.slice(0, max)}…` : v;
  const json = safeJson(v).replace(/\s+/g, " ");
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

function formatTime(at: number): string {
  const d = new Date(at);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
