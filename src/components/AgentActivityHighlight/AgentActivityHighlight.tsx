import { type CSSProperties, useEffect, useState } from "react";

export type AgentActivityHighlightProps = {
  /** Bounds of the highlighted item in the parent's coord system. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Trigger token — change it (e.g. set to Date.now()) to re-fire the pulse. */
  pulseKey?: string | number;
  /** Highlight tint. */
  color?: string;
  /** Pulse duration in ms. Defaults 1200. */
  duration?: number;
  className?: string;
  style?: CSSProperties;
};

/**
 * AgentActivityHighlight — short pulsing outline that flashes around an
 * item the agent just touched. Position the parent so this can be placed
 * absolutely matching the item's bounds.
 */
export function AgentActivityHighlight({
  x,
  y,
  width,
  height,
  pulseKey,
  color = "#a855f7",
  duration = 1200,
  className,
  style,
}: AgentActivityHighlightProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (pulseKey === undefined) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), duration);
    return () => clearTimeout(t);
  }, [pulseKey, duration]);

  if (!visible) return null;

  return (
    <div
      className={["fai-highlight", className ?? ""].filter(Boolean).join(" ")}
      style={{
        position: "absolute",
        left: x - 4,
        top: y - 4,
        width: width + 8,
        height: height + 8,
        borderRadius: 8,
        boxShadow: `0 0 0 2px ${color}, 0 0 16px ${color}66`,
        pointerEvents: "none",
        animation: `fai-pulse ${duration}ms ease-out forwards`,
        ...style,
      }}
    />
  );
}
