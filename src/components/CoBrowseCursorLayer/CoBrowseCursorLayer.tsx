import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAgentActivity } from "../../presence/use-agent-activity";
import { AgentCursor } from "../AgentCursor/AgentCursor";
import { AgentActivityHighlight } from "../AgentActivityHighlight/AgentActivityHighlight";

type Rect = { x: number; y: number; width: number; height: number };

const CURSOR_EDGE_INSET = 24;
const FLUID_CURSOR_SPEED_PX_PER_SECOND = 1_050;
const MIN_GLIDE_MS = 240;
const MAX_GLIDE_MS = 1_200;

export function visibleCursorPoint(rect: Rect, viewport: { width: number; height: number }) {
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  return {
    x: Math.min(Math.max(x, CURSOR_EDGE_INSET), Math.max(CURSOR_EDGE_INSET, viewport.width - CURSOR_EDGE_INSET)),
    y: Math.min(Math.max(y, CURSOR_EDGE_INSET), Math.max(CURSOR_EDGE_INSET, viewport.height - CURSOR_EDGE_INSET)),
  };
}

export function fluidGlideDuration(from: { x: number; y: number } | null, to: { x: number; y: number }) {
  if (!from) return 0;
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  return Math.round(Math.min(MAX_GLIDE_MS, Math.max(MIN_GLIDE_MS, (distance / FLUID_CURSOR_SPEED_PX_PER_SECOND) * 1_000)));
}

export type CoBrowseCursorLayerProps = {
  /** Render the overlay only while a session is live. Default true. */
  active?: boolean;
  /** Stacking order of the overlay. Default just under the max. */
  zIndex?: number;
  /**
   * Retire the cursor after this long without a tool call. Default 15s;
   * `0` keeps it on screen indefinitely.
   *
   * A cursor that sits still is not neutral — it reads as "the agent is
   * broken", which is worse than showing nothing. Continuous presence belongs
   * in the activity log; the cursor is for *motion*.
   */
  idleAfterMs?: number;
};

/**
 * Session lifecycle chatter. Real events, but nothing the agent DID — so they
 * must never conjure a cursor. `agent_connected` used to, parking a motionless
 * pointer captioned "Agent connected" in the middle of the viewport for a
 * session in which the agent had not yet made a single tool call.
 */
const LIFECYCLE_ACTIONS = new Set(["agent_connected", "agent_disconnected"]);

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
export function CoBrowseCursorLayer({
  active = true,
  zIndex = 2147483000,
  idleAfterMs = 15_000,
}: CoBrowseCursorLayerProps) {
  const { latest } = useAgentActivity(undefined, { capacity: 12 });
  const [cursor, setCursor] = useState<{ x: number; y: number; name: string; color: string; status?: string; glideMs: number } | null>(
    null,
  );
  const [pulse, setPulse] = useState<{ rect: Rect; color: string; key: number } | null>(null);
  // Timestamp of the last real tool call — the only thing that keeps the cursor
  // alive. Deliberately NOT bumped by lifecycle events, so a relay client
  // reconnecting every call can't hold a stale pointer on screen forever.
  const [lastActionAt, setLastActionAt] = useState(0);

  useEffect(() => {
    if (!latest || (latest.source ?? "agent") === "user") return;
    if (LIFECYCLE_ACTIONS.has(latest.action)) {
      // Connecting is not acting. Relay clients may also be intentionally
      // short-lived (one process per MCP call), so a disconnect is not the end
      // of the session either — if a cursor is already on screen from real work,
      // leave it and just say so. What we must NOT do is create one: an agent
      // that has connected and done nothing has nowhere to point.
      setCursor((prev) => (prev ? { ...prev, status: "Standing by", glideMs: 0 } : null));
      setPulse(null);
      return;
    }
    setLastActionAt(latest.timestamp);
    const color = latest.agentColor ?? "#a855f7";
    const name = latest.agentName ?? "Agent";
    const status = latest.target?.label ?? latest.action;
    const rect = (latest.meta as { rect?: Rect } | undefined)?.rect;
    if (rect) {
      // Keep off-screen targets represented at the nearest viewport edge, then
      // glide at a distance-aware pace that a watching human can comfortably
      // follow. This is presence, not a teleport animation.
      const target = visibleCursorPoint(rect, { width: window.innerWidth, height: window.innerHeight });
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      setCursor((prev) => ({
        ...target,
        name,
        color,
        status,
        glideMs: reduceMotion ? 0 : fluidGlideDuration(prev, target),
      }));
      setPulse({ rect, color, key: latest.timestamp });
    } else {
      // nav / scroll — no element. Keep (or first-show, at viewport center) the
      // cursor so the agent stays visibly present; just refresh its caption.
      setCursor((prev) =>
        prev
          ? { ...prev, status, name, color }
          : { x: window.innerWidth / 2, y: window.innerHeight / 2, name, color, status, glideMs: 0 },
      );
    }
  }, [latest?.timestamp]);

  // Retire the cursor once the agent goes quiet. Presence that never changes
  // stops being information — the human reads a frozen pointer as a hung agent,
  // and the activity log is where "still connected" is supposed to live.
  useEffect(() => {
    if (!idleAfterMs || !lastActionAt) return;
    const timer = setTimeout(() => {
      setCursor(null);
      setPulse(null);
    }, idleAfterMs);
    return () => clearTimeout(timer);
  }, [lastActionAt, idleAfterMs]);

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
        style={{
          transition: cursor.glideMs
            ? `left ${cursor.glideMs}ms cubic-bezier(.22,.61,.36,1), top ${cursor.glideMs}ms cubic-bezier(.22,.61,.36,1)`
            : "none",
        }}
      />
    </div>,
    document.body,
  );
}

CoBrowseCursorLayer.displayName = "CoBrowseCursorLayer";
