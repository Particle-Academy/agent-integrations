import { useCallback, useEffect, useRef, useState } from "react";
import { MicroMcpServer } from "../mcp/server";
import { attachInProcess } from "../mcp/transports";
import { attachSseRelay, type RelayState, type SseRelayTransport } from "./sse-relay";
import { createSessionDescriptor, type SessionDescriptor } from "./token";
import { emitActivity } from "../presence/registry";
import type { AgentActivityEvent } from "../presence/types";
import { registerNavigationBridge, type NavigationBridgeAdapter } from "../bridges/navigation";
import { BridgeContributions, type BridgeContribution } from "./bridge-contributions";

/** A thing the human did, surfaced so the connected agent stays aware. */
export type CoBrowseUserEvent =
  | { kind: "navigation"; url: string; title?: string; revision?: number }
  | { kind: "scroll"; y: number; revision?: number }
  | { kind: "form"; handle: string; value?: unknown; masked?: boolean; revision?: number }
  | { kind: "click"; handle: string; label?: string; revision?: number };

export type UseCoBrowseSessionOptions = {
  /**
   * The navigation adapter (Inertia + DOM in the sandbox). MUST be stable —
   * its methods should read live state via refs, since the bridge captures it
   * once on mount. Memoize it.
   */
  adapter: NavigationBridgeAdapter;
  /** Identity for the agent's presence (cursor/log color + name). */
  agent?: { id: string; name?: string; color?: string };
  /**
   * Which activity events this session forwards to its agent.
   *
   * Only needed when a page runs MORE THAN ONE session — site co-browse plus
   * the agent playground, say. The activity bus is global to the page, so
   * without a filter each relay forwards the other's traffic and every agent
   * sees every other agent's navigations.
   *
   * Omitted forwards everything, which is right for the single-session case.
   */
  activityFilter?: (event: AgentActivityEvent) => boolean;
  /** Relay base path. Default "/agent-relay" (the generic frame broker). */
  relayBaseUrl?: string;
  /** MCP server info advertised to the agent. */
  info?: { name: string; version: string; instructions?: string };
  /**
   * Register extra bridges (forms/screens/…) on the same server, once, at
   * construction.
   *
   * For a surface that comes and goes with navigation use
   * {@link CoBrowseSession.contributeBridges} instead: this callback fires
   * exactly once while the server is built, so a page mounted afterwards can
   * never contribute through it, and one that unmounts can never withdraw.
   */
  extraBridges?: (server: MicroMcpServer) => void;
  /** CSRF token for the relay register/unregister POSTs. */
  csrfToken?: () => string | null | undefined;
  /** Stage submit + destructive clicks for human confirm. Default true. */
  pendingMode?: boolean;
};

export type CoBrowseSession = {
  server: MicroMcpServer | null;
  /**
   * Contribute bridges for as long as the returned disposer is uncalled —
   * "site tools always; page tools while mounted".
   *
   * Call it from a page's mount effect and return its disposer:
   *
   * ```tsx
   * useEffect(() => contributeBridges((server) =>
   *   registerArtboardBridge(server, { adapter }).dispose), []);
   * ```
   *
   * Safe to call before sharing starts — the contribution is applied to the
   * server as soon as one exists, and re-applied if the session is restarted.
   */
  contributeBridges: (contribute: BridgeContribution) => () => void;
  session: SessionDescriptor | null;
  relayState: RelayState;
  /**
   * True once at least one remote agent is actually attached to the session.
   *
   * Distinct from `relayState === "open"`, which only says the BROWSER reached
   * the relay — true the moment sharing starts, before the link has been handed
   * to anyone. A UI that keys "Agent is driving" off the relay state therefore
   * announces a driver who does not exist, and stays silent when a real one
   * arrives.
   */
  agentConnected: boolean;
  /** How many remote agents are attached (0 when nobody has joined). */
  agentCount: number;
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
  const relayBaseUrl = options.relayBaseUrl ?? "/agent-relay";

  const serverRef = useRef<MicroMcpServer | null>(null);
  // Survives re-renders AND server rebuilds: a page's contribution outlives any
  // one session, which is the entire reason this is not a captured callback.
  const contributionsRef = useRef<BridgeContributions>(null as unknown as BridgeContributions);
  if (!contributionsRef.current) contributionsRef.current = new BridgeContributions();
  const relayRef = useRef<SseRelayTransport | null>(null);
  const detachInProc = useRef<(() => void) | null>(null);
  const disposeBridge = useRef<(() => void) | null>(null);

  const [session, setSession] = useState<SessionDescriptor | null>(null);
  const [relayState, setRelayState] = useState<RelayState>("idle");
  const [agentCount, setAgentCount] = useState(0);

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
    // Apply whatever pages are already mounted, and keep the registry attached
    // so later mounts/unmounts add and withdraw live.
    contributionsRef.current.bind(server);
    const inProc = attachInProcess(server);
    detachInProc.current = () => inProc.close();
    disposeBridge.current = bridge.dispose;
    serverRef.current = server;

    return () => {
      relayRef.current?.close();
      relayRef.current = null;
      contributionsRef.current.unbind();
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
    const response = await fetch(`${relayBaseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ session: descriptor.id, token: descriptor.token }),
    });
    if (!response.ok) {
      throw new Error(`Relay registration failed (${response.status})`);
    }
    // Pass the session's agent identity down so the relay stamps its own
    // connect/disconnect events with it, and so a host that runs a SECOND
    // session (the agent playground alongside site co-browse) has something to
    // scope on. Without an `agent` this behaves exactly as before.
    const relay = attachSseRelay(server, {
      baseUrl: relayBaseUrl,
      sessionId: descriptor.id,
      token: descriptor.token,
      agent: options.agent,
      activityFilter: options.activityFilter,
    });
    relay.onStateChange(setRelayState);
    relay.onPeersChange(setAgentCount);
    relayRef.current = relay;
    setSession(descriptor);
  }, [relayBaseUrl, options]);

  const stopShare = useCallback(() => {
    const current = session;
    relayRef.current?.close();
    relayRef.current = null;
    setRelayState("idle");
    setAgentCount(0);
    setSession(null);
    if (current) {
      const csrf = options.csrfToken?.() ?? "";
      void fetch(`${relayBaseUrl}/${current.id}/unregister?token=${encodeURIComponent(current.token)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
      }).catch(() => {});
    }
  }, [relayBaseUrl, options, session]);

  const observeUser = useCallback((event: CoBrowseUserEvent) => {
    const label =
      event.kind === "navigation"
        ? `You navigated to ${event.url}`
        : event.kind === "scroll"
          ? "You scrolled"
          : event.kind === "click"
            ? `You clicked ${event.label ?? event.handle}`
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

  // Stable identity: a page passes this straight into a mount effect, so a new
  // function each render would re-register its bridges on every render.
  const contributeBridges = useCallback(
    (contribute: BridgeContribution) => contributionsRef.current.add(contribute),
    [],
  );

  return {
    server: serverRef.current,
    contributeBridges,
    session,
    relayState,
    agentConnected: agentCount > 0,
    agentCount,
    startShare,
    stopShare,
    observeUser,
  };
}
