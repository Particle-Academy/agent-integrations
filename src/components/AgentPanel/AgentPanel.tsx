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
  return (
    <div className={`fai-row fai-row--${item.kind}`}>
      <div className="fai-row__meta">
        <span className="fai-row__source">{item.source}</span>
        <span className="fai-row__time">{time}</span>
      </div>
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
