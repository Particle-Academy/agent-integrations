import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAgentActivity } from "../../presence/use-agent-activity";
import { AgentCursor } from "../AgentCursor/AgentCursor";
import { AgentActivityHighlight } from "../AgentActivityHighlight/AgentActivityHighlight";

type Rect = { x: number; y: number; width: number; height: number };

export type CoBrowseCursorLayerProps = {
  /** Render the overlay only while a session is live. Default true. */
  active?: boolean;
  /** Stacking order of the overlay. Default just under the max. */
  zIndex?: number;
};

/**
 * Page-wide agent presence for co-browsing — the missing "all actors present"
 * half of Human+ UX. A fixed, click-through overlay (portaled to <body>) that
 * shows the connected agent as a live cursor + pings/highlights the element it
 * just acted on, gliding between targets. Same visual language as the whiteboard
 * demo's agent cursor, but mapped from the navigation bridge's STABLE HANDLES
 * (the agent has no real mouse) — each tool reports the acted element's viewport
 * rect in `meta.rect` (see `NavigationBridgeAdapter.rectFor`).
 *
 * Mount it once near the app root (e.g. in your CoBrowseProvider), gated on an
 * active session. SSR-safe: renders null on the server / until the first action.
 */
export function CoBrowseCursorLayer({ active = true, zIndex = 2147483000 }: CoBrowseCursorLayerProps) {
  const { latest } = useAgentActivity(undefined, { capacity: 12 });
  const [cursor, setCursor] = useState<{ x: number; y: number; name: string; color: string; status?: string } | null>(
    null,
  );
  const [pulse, setPulse] = useState<{ rect: Rect; color: string; key: number } | null>(null);

  useEffect(() => {
    if (!latest || (latest.source ?? "agent") === "user") return;
    const color = latest.agentColor ?? "#a855f7";
    const name = latest.agentName ?? "Agent";
    const status = latest.target?.label ?? latest.action;
    const rect = (latest.meta as { rect?: Rect } | undefined)?.rect;
    if (rect) {
      // Acted on a concrete element — glide the cursor to it + pulse a highlight.
      setCursor({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, name, color, status });
      setPulse({ rect, color, key: latest.timestamp });
    } else {
      // nav / scroll — no element. Keep (or first-show, at viewport center) the
      // cursor so the agent stays visibly present; just refresh its caption.
      setCursor((prev) =>
        prev
          ? { ...prev, status, name, color }
          : { x: window.innerWidth / 2, y: window.innerHeight / 2, name, color, status },
      );
    }
  }, [latest?.timestamp]);

  if (!active || !cursor || typeof document === "undefined") return null;

  return createPortal(
    <div data-co-browse-cursor-layer="" style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex }}>
      {pulse && (
        <AgentActivityHighlight
          x={pulse.rect.x}
          y={pulse.rect.y}
          width={pulse.rect.width}
          height={pulse.rect.height}
          color={pulse.color}
          pulseKey={pulse.key}
        />
      )}
      <AgentCursor
        x={cursor.x}
        y={cursor.y}
        name={cursor.name}
        color={cursor.color}
        status={cursor.status}
        style={{ transition: "left .35s cubic-bezier(.22,.61,.36,1), top .35s cubic-bezier(.22,.61,.36,1)" }}
      />
    </div>,
    document.body,
  );
}

CoBrowseCursorLayer.displayName = "CoBrowseCursorLayer";
