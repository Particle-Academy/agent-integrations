import { useCallback, useEffect, useRef, useState } from "react";
import { MicroMcpServer } from "../mcp/server";
import { attachInProcess } from "../mcp/transports";
import { attachSseRelay, type RelayState, type SseRelayTransport } from "./sse-relay";
import { createSessionDescriptor, type SessionDescriptor } from "./token";
import { emitActivity } from "../presence/registry";
import { registerNavigationBridge, type NavigationBridgeAdapter } from "../bridges/navigation";

/** A thing the human did, surfaced so the connected agent stays aware. */
export type CoBrowseUserEvent =
  | { kind: "navigation"; url: string; title?: string }
  | { kind: "scroll"; y: number }
  | { kind: "form"; handle: string; value?: unknown; masked?: boolean };

export type UseCoBrowseSessionOptions = {
  /**
   * The navigation adapter (Inertia + DOM in the sandbox). MUST be stable —
   * its methods should read live state via refs, since the bridge captures it
   * once on mount. Memoize it.
   */
  adapter: NavigationBridgeAdapter;
  /** Identity for the agent's presence (cursor/log color + name). */
  agent?: { id: string; name?: string; color?: string };
  /** Relay base path. Default "/whiteboard-share" (the generic frame broker). */
  relayBaseUrl?: string;
  /** MCP server info advertised to the agent. */
  info?: { name: string; version: string; instructions?: string };
  /** Register extra bridges (forms/screens/…) on the same server. */
  extraBridges?: (server: MicroMcpServer) => void;
  /** CSRF token for the relay register/unregister POSTs. */
  csrfToken?: () => string | null | undefined;
  /** Stage submit + destructive clicks for human confirm. Default true. */
  pendingMode?: boolean;
};

export type CoBrowseSession = {
  server: MicroMcpServer | null;
  session: SessionDescriptor | null;
  relayState: RelayState;
  startShare: () => Promise<void>;
  stopShare: () => void;
  /**
   * Report a human action so the connected agent is notified. Emits a
   * `source:"user"` activity event, which the SSE relay forwards to the agent
   * as a `notifications/agent_activity` frame.
   */
  observeUser: (event: CoBrowseUserEvent) => void;
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };
const USER = { id: "human", name: "You" };

/**
 * Site-wide co-browsing session: one persistent in-page `MicroMcpServer` running
 * the navigation bridge, joinable by an external agent over the relay. Mount it
 * once at the app root; render `<CoBrowsePresence>` to show the agent + a Stop
 * control. The host wires `observeUser(...)` to navigation/scroll/form listeners
 * so the agent sees what the human does.
 */
export function useCoBrowseSession(options: UseCoBrowseSessionOptions): CoBrowseSession {
  const { adapter, extraBridges } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const relayBaseUrl = options.relayBaseUrl ?? "/whiteboard-share";

  const serverRef = useRef<MicroMcpServer | null>(null);
  const relayRef = useRef<SseRelayTransport | null>(null);
  const detachInProc = useRef<(() => void) | null>(null);
  const disposeBridge = useRef<(() => void) | null>(null);

  const [session, setSession] = useState<SessionDescriptor | null>(null);
  const [relayState, setRelayState] = useState<RelayState>("idle");

  // Build the server + bridges once. The adapter is captured here, so it must
  // be stable (its methods read live state).
  useEffect(() => {
    const server = new MicroMcpServer({
      info: options.info ?? { name: "fancy-co-browse", version: "0.1.0" },
      instructions:
        options.info?.instructions ??
        "Co-browse with a watching human. Call page_describe first; navigate, scroll, and (with confirm) fill/click via stable handles. You receive notifications/agent_activity for the human's actions (source:\"user\").",
    });
    const bridge = registerNavigationBridge(server, { adapter, agent, pendingMode: options.pendingMode });
    extraBridges?.(server);
    const inProc = attachInProcess(server);
    detachInProc.current = () => inProc.close();
    disposeBridge.current = bridge.dispose;
    serverRef.current = server;

    return () => {
      relayRef.current?.close();
      relayRef.current = null;
      disposeBridge.current?.();
      detachInProc.current?.();
      serverRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startShare = useCallback(async () => {
    const server = serverRef.current;
    if (!server || relayRef.current) return;
    const descriptor = createSessionDescriptor();
    const csrf = options.csrfToken?.() ?? "";
    await fetch(`${relayBaseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ session: descriptor.id, token: descriptor.token }),
    });
    const relay = attachSseRelay(server, { baseUrl: relayBaseUrl, sessionId: descriptor.id, token: descriptor.token });
    relay.onStateChange(setRelayState);
    relayRef.current = relay;
    setSession(descriptor);
  }, [relayBaseUrl, options]);

  const stopShare = useCallback(() => {
    const current = session;
    relayRef.current?.close();
    relayRef.current = null;
    setRelayState("idle");
    setSession(null);
    if (current) {
      const csrf = options.csrfToken?.() ?? "";
      void fetch(`${relayBaseUrl}/${current.id}/unregister`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({ token: current.token }),
      }).catch(() => {});
    }
  }, [relayBaseUrl, options, session]);

  const observeUser = useCallback((event: CoBrowseUserEvent) => {
    const label =
      event.kind === "navigation"
        ? `You navigated to ${event.url}`
        : event.kind === "scroll"
          ? "You scrolled"
          : `You edited ${event.handle}${event.masked ? " (hidden)" : ""}`;
    emitActivity({
      agentId: USER.id,
      agentName: USER.name,
      source: "user",
      target: { kind: "navigation", label },
      action: `user_${event.kind}`,
      timestamp: Date.now(),
      meta: event as Record<string, unknown>,
    });
  }, []);

  return { server: serverRef.current, session, relayState, startShare, stopShare, observeUser };
}
