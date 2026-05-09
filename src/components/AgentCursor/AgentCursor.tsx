import type { CSSProperties } from "react";

export type AgentCursorProps = {
  x: number;
  y: number;
  name?: string;
  color?: string;
  /** Optional caption shown under the name (e.g. current tool). */
  status?: string;
  className?: string;
  style?: CSSProperties;
};

/**
 * AgentCursor — on-canvas presence marker for the agent. Drop it inside
 * (or alongside) a fancy-whiteboard <Board> at screen coords matching
 * the agent's reported position.
 */
export function AgentCursor({ x, y, name, color = "#a855f7", status, className, style }: AgentCursorProps) {
  return (
    <div
      className={["fai-cursor", className ?? ""].filter(Boolean).join(" ")}
      style={{
        position: "absolute",
        left: x,
        top: y,
        pointerEvents: "none",
        transform: "translate(-2px, -2px)",
        ...style,
      }}
    >
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
        <path
          d="M2 2 L2 17 L7 13 L10 19 L12 18 L9 12 L15 12 Z"
          fill={color}
          stroke="white"
          strokeWidth="1.2"
        />
      </svg>
      {name && (
        <span
          className="fai-cursor__tag"
          style={{ background: color }}
        >
          {name}
          {status ? <em className="fai-cursor__status"> · {status}</em> : null}
        </span>
      )}
    </div>
  );
}
