import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Board,
  StickyNote,
  Connector,
  Shape,
  CursorLayer,
  type StickyNoteItem,
  type ShapeItem,
  type ConnectorItem,
  type Stroke,
  type RemoteCursor,
  type Viewport,
} from "@particle-academy/fancy-whiteboard";
import { MicroMcpServer, type Transport } from "../../mcp/server";
import { attachInProcess, type InProcessTransport } from "../../mcp/transports/in-process";
import { attachSseRelay, type RelayState, type SseRelayTransport } from "../../sharing/sse-relay";
import { createSessionDescriptor, type SessionDescriptor } from "../../sharing/token";
import { registerWhiteboardBridge } from "../../bridges/whiteboard";
import type { Bridge } from "../../bridges/types";
import { ShareControls } from "../ShareControls";
import { AgentPanel, type AgentActivity } from "../AgentPanel";
import { AgentCursor } from "../AgentCursor";
import { AgentActivityHighlight } from "../AgentActivityHighlight";

export type SharedWhiteboardProps = {
  /** Initial board contents. */
  initialNotes?: StickyNoteItem[];
  initialShapes?: ShapeItem[];
  initialConnectors?: ConnectorItem[];
  initialStrokes?: Stroke[];
  initialViewport?: Viewport;

  /** Agent identity displayed in the panel + cursor. */
  agent?: { id: string; name?: string; color?: string };

  /**
   * Where the relay HTTP endpoints live. The host app implements these (see
   * docs/relay-protocol.md). Pass `null` to disable sharing — the board
   * still works locally with the in-process MCP server.
   */
  shareBaseUrl?: string | null;

  /**
   * Optional callback to register a new session token with the host's
   * relay broker. Receives `{ session, token }` and should return after
   * registration. Defaults to POSTing JSON to `${shareBaseUrl}/register`.
   */
  onRegisterSession?: (descriptor: SessionDescriptor) => Promise<void>;

  /** Show the agent panel. Default true. */
  showAgentPanel?: boolean;

  /** Show share controls. Default true. */
  showShareControls?: boolean;

  /** Auto-broadcast local edits as `notifications/state_update`. Default true. */
  broadcastEdits?: boolean;

  /** Pixel height of the board area. Default 640. */
  height?: number;

  /** Header content rendered above the board. */
  header?: ReactNode;

  className?: string;
  style?: CSSProperties;
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };

/**
 * SharedWhiteboard — drop-in component that bundles every piece of the
 * "agent-collaborative whiteboard" UX: board with all primitives, in-page
 * MCP server, share controls, agent panel, presence cursor, activity
 * highlight, and outbound state broadcast.
 *
 * Most apps only need this one component. For deeper customization, swap
 * it for the lower-level primitives (Board, MicroMcpServer, ShareControls).
 */
export function SharedWhiteboard({
  initialNotes = [],
  initialShapes = [],
  initialConnectors = [],
  initialStrokes = [],
  initialViewport = { x: 0, y: 0, zoom: 1 },
  agent = DEFAULT_AGENT,
  shareBaseUrl = "/whiteboard-share",
  onRegisterSession,
  showAgentPanel = true,
  showShareControls = true,
  broadcastEdits = true,
  height = 640,
  header,
  className,
  style,
}: SharedWhiteboardProps) {
  // Board state
  const [notes, setNotes] = useState<StickyNoteItem[]>(initialNotes);
  const [shapes, setShapes] = useState<ShapeItem[]>(initialShapes);
  const [connectors, setConnectors] = useState<ConnectorItem[]>(initialConnectors);
  const [strokes, setStrokes] = useState<Stroke[]>(initialStrokes);
  const [viewport, setViewport] = useState<Viewport>(initialViewport);
  const [agentCursor, setAgentCursor] = useState<RemoteCursor | null>(null);

  // Agent UX state
  const [activity, setActivity] = useState<AgentActivity[]>([]);
  const [highlight, setHighlight] = useState<{ pulseKey: number; bounds: { x: number; y: number; width: number; height: number } } | null>(null);

  const stateRefs = useRef({ notes, shapes, connectors, strokes, viewport });
  useEffect(() => { stateRefs.current = { notes, shapes, connectors, strokes, viewport }; }, [notes, shapes, connectors, strokes, viewport]);

  // MCP server + bridge
  const serverRef = useRef<MicroMcpServer | null>(null);
  const inProcRef = useRef<InProcessTransport | null>(null);
  const bridgeRef = useRef<Bridge | null>(null);

  useEffect(() => {
    const server = new MicroMcpServer({
      info: { name: "shared-whiteboard", version: "0.2.0" },
      instructions: "Collaborative whiteboard. Use whiteboard_* tools to read or modify the board.",
    });
    bridgeRef.current = registerWhiteboardBridge(server, {
      adapter: {
        getNotes: () => stateRefs.current.notes,
        setNotes: (next) => setNotes(typeof next === "function" ? next : () => next),
        getShapes: () => stateRefs.current.shapes,
        setShapes: (next) => setShapes(typeof next === "function" ? next : () => next),
        getConnectors: () => stateRefs.current.connectors,
        setConnectors: (next) => setConnectors(typeof next === "function" ? next : () => next),
        getStrokes: () => stateRefs.current.strokes,
        setStrokes: (next) => setStrokes(typeof next === "function" ? next : () => next),
        getViewport: () => stateRefs.current.viewport,
        setViewport,
        setAgentCursor,
      },
      agent,
    });
    inProcRef.current = attachInProcess(server);
    serverRef.current = server;

    // Pulse a highlight whenever a tool call returns a structured id.
    const off = inProcRef.current.onServerMessage((msg: any) => {
      if (msg?.id !== undefined && "result" in msg && msg.result?.structuredContent?.id) {
        const id = msg.result.structuredContent.id;
        requestAnimationFrame(() => pulseFor(id));
      }
    });
    return () => {
      off();
      bridgeRef.current?.dispose();
      bridgeRef.current = null;
      if (inProcRef.current) server.detach(inProcRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pulseFor = (id: string) => {
    const n = stateRefs.current.notes.find((x) => x.id === id);
    if (n) return setHighlight({ pulseKey: Date.now(), bounds: { x: n.x, y: n.y, width: n.width, height: n.height } });
    const s = stateRefs.current.shapes.find((x) => x.id === id);
    if (s) return setHighlight({ pulseKey: Date.now(), bounds: { x: s.x, y: s.y, width: s.width, height: s.height } });
  };

  const log = useCallback((entry: Omit<AgentActivity, "id" | "at">) => {
    setActivity((all) => [...all.slice(-200), { id: `a_${Date.now()}_${all.length}`, at: Date.now(), ...entry }]);
  }, []);

  // Sharing
  const [session, setSession] = useState<SessionDescriptor | null>(null);
  const [relayState, setRelayState] = useState<RelayState>("idle");
  const sseRef = useRef<SseRelayTransport | null>(null);
  const logEsRef = useRef<EventSource | null>(null);

  const startShare = async () => {
    if (session || !serverRef.current || !shareBaseUrl) return;
    const desc = createSessionDescriptor();

    try {
      if (onRegisterSession) {
        await onRegisterSession(desc);
      } else {
        const csrf = (document.querySelector('meta[name="csrf-token"]') as HTMLMetaElement | null)?.content ?? "";
        const reg = await fetch(`${shareBaseUrl}/register`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-csrf-token": csrf, accept: "application/json" },
          body: JSON.stringify({ session: desc.id, token: desc.token }),
        });
        if (!reg.ok) throw new Error(`registration failed (HTTP ${reg.status})`);
      }
    } catch (e) {
      log({ kind: "error", source: "share", text: e instanceof Error ? e.message : String(e) });
      return;
    }

    const relay = attachSseRelay(serverRef.current, {
      baseUrl: shareBaseUrl,
      sessionId: desc.id,
      token: desc.token,
    });
    sseRef.current = relay;
    relay.onStateChange(setRelayState);

    // Activity log mirror — does NOT call deliverFromRemote (relay does it).
    const es = new EventSource(`${shareBaseUrl}/${desc.id}/events?token=${desc.token}&direction=inbound`);
    es.addEventListener("mcp", (ev: MessageEvent) => {
      try {
        const frame = JSON.parse(ev.data);
        if (frame.method === "notifications/peer_joined") {
          // External agent just opened an outbound subscription. Surface it
          // so the human can see "an agent is connecting" before any tools
          // arrive. The agent itself should follow up with set_agent_cursor
          // immediately, but in case it doesn't, drop a placeholder cursor
          // at the canvas origin so presence is visible right away.
          setAgentCursor((c) => c ?? { userId: agent.id, name: agent.name, color: agent.color, x: 60, y: 60 });
          log({ kind: "info", source: "presence", text: `${agent.name ?? "Agent"} connected` });
          return;
        }
        if (frame.method === "notifications/peer_left") {
          setAgentCursor(null);
          log({ kind: "info", source: "presence", text: `${agent.name ?? "Agent"} disconnected` });
          return;
        }
        if (frame.method === "notifications/agent_message") {
          log({ kind: "message", source: agent.name ?? "Agent", text: String(frame.params?.text ?? "") });
        } else if (frame.method === "notifications/agent_status") {
          log({ kind: "info", source: agent.name ?? "Agent", text: String(frame.params?.text ?? "") });
        } else if (frame.method?.startsWith("notifications/")) {
          // ignore other notifications in the feed
        } else {
          log({ kind: "tool", source: "remote", text: `← ${frame.method ?? `id:${frame.id}`}`, detail: frame });
        }
      } catch {
        /* noop */
      }
    });
    logEsRef.current = es;

    setSession(desc);
    log({ kind: "info", source: "share", text: `Sharing started · session ${desc.id}` });
  };

  const stopShare = async () => {
    if (!session) return;
    const desc = session;
    setSession(null);
    logEsRef.current?.close();
    logEsRef.current = null;
    if (sseRef.current && serverRef.current) serverRef.current.detach(sseRef.current);
    sseRef.current = null;
    setRelayState("closed");
    if (shareBaseUrl) {
      const csrf = (document.querySelector('meta[name="csrf-token"]') as HTMLMetaElement | null)?.content ?? "";
      await fetch(`${shareBaseUrl}/${desc.id}/unregister?token=${encodeURIComponent(desc.token)}`, {
        method: "POST",
        headers: { "x-csrf-token": csrf, accept: "application/json" },
      }).catch(() => {});
    }
    log({ kind: "info", source: "share", text: "Sharing stopped." });
  };

  // Outbound state broadcast — every state change pushes a notification on
  // the relay (capped to ~12 Hz) so external agents see human edits live.
  const lastBroadcastRef = useRef(0);
  useEffect(() => {
    if (!broadcastEdits || !sseRef.current || !session) return;
    const now = Date.now();
    if (now - lastBroadcastRef.current < 80) return;
    lastBroadcastRef.current = now;
    sseRef.current.send({
      jsonrpc: "2.0",
      method: "notifications/state_update",
      params: { notes, shapes, connectors, viewport, ts: now },
    });
  }, [notes, shapes, connectors, viewport, session, broadcastEdits]);

  const handleSubmit = (text: string) => {
    if (!sseRef.current) {
      log({ kind: "error", source: "you", text: "Start a shared session first." });
      return;
    }
    sseRef.current.send({
      jsonrpc: "2.0",
      method: "notifications/user_message",
      params: { text, ts: Date.now() },
    });
    log({ kind: "message", source: "You", text });
  };

  // The agent cursor is rendered by <AgentCursor> below — keep it OUT of
  // the cursors array so we don't double-render it via CursorLayer.
  // (CursorLayer is reserved for human participants once relay sync lands.)
  const cursors: RemoteCursor[] = useMemo(() => [], []);
  const statusText = (() => {
    switch (relayState) {
      case "open": return "live";
      case "connecting": return "connecting…";
      case "error": return "error";
      case "closed": return "closed";
      default: return undefined;
    }
  })();

  return (
    <div className={["fai-shared-whiteboard", className ?? ""].filter(Boolean).join(" ")} style={style}>
      {header}
      {showShareControls && shareBaseUrl !== null && (
        <div className="fai-shared-whiteboard__controls">
          <ShareControls session={session} onStart={startShare} onStop={stopShare} status={statusText} />
        </div>
      )}
      <div
        className="fai-shared-whiteboard__layout"
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: showAgentPanel ? "1fr 360px" : "1fr",
        }}
      >
        <div
          className="fai-shared-whiteboard__board"
          style={{
            position: "relative",
            overflow: "hidden",
            borderRadius: 12,
            border: "1px solid #e4e4e7",
            background:
              "radial-gradient(circle at 1px 1px, rgba(0,0,0,0.07) 1px, transparent 0)",
            backgroundSize: "20px 20px",
            height,
          }}
        >
          <Board viewport={viewport} onViewportChange={setViewport} style={{ width: "100%", height: "100%" }}>
            {connectors.map((c) => {
              const a = resolveCenter(c.from, notes, shapes);
              const b = resolveCenter(c.to, notes, shapes);
              if (!a || !b) return null;
              return <Connector key={c.id} from={a} to={b} color={c.color ?? "#64748b"} />;
            })}
            {shapes.map((s) => (
              <Shape key={s.id} item={s} onChange={(next) => setShapes((all) => all.map((x) => (x.id === next.id ? next : x)))} />
            ))}
            {notes.map((n) => (
              <StickyNote key={n.id} item={n} onChange={(next) => setNotes((all) => all.map((x) => (x.id === next.id ? next : x)))} />
            ))}
            <CursorLayer cursors={cursors} />
            {agentCursor && (
              <AgentCursor x={agentCursor.x} y={agentCursor.y} name={agentCursor.name} color={agentCursor.color} />
            )}
            {highlight && (
              <AgentActivityHighlight
                x={highlight.bounds.x}
                y={highlight.bounds.y}
                width={highlight.bounds.width}
                height={highlight.bounds.height}
                color={agent.color ?? "#a855f7"}
                pulseKey={highlight.pulseKey}
              />
            )}
          </Board>
        </div>
        {showAgentPanel && (
          <div style={{ height }}>
            <AgentPanel
              agent={agent}
              activity={activity}
              onSubmit={handleSubmit}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function resolveCenter(
  ref: ConnectorItem["from"],
  notes: StickyNoteItem[],
  shapes: ShapeItem[],
): { x: number; y: number } | null {
  if (typeof ref === "string") {
    const n = notes.find((x) => x.id === ref);
    if (n) return { x: n.x + n.width / 2, y: n.y + n.height / 2 };
    const s = shapes.find((x) => x.id === ref);
    if (s) return { x: s.x + s.width / 2, y: s.y + s.height / 2 };
    return null;
  }
  return ref;
}

// Internal-import safety
type _UseTransport = Transport;
