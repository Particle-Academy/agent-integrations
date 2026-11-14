import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { createCoworkSession, type CoworkSession, type CoworkSessionOptions, type CoworkSnapshot } from "./session";
import type { PeerTransport } from "./transport";
import type { Decision } from "./types";

export type UseCoworkSessionOptions = Omit<CoworkSessionOptions, "transport"> & {
  /** Nothing happens until there is one; swap it (or `sessionId`) to start over. */
  transport: PeerTransport | null | undefined;
};

export type CoworkSessionHandle = CoworkSnapshot &
  Omit<CoworkSession, "getSnapshot" | "subscribe" | "destroy"> & {
    /** True once a session is running on a transport. */
    ready: boolean;
  };

const NOT_READY: Decision = { allow: false, reason: "cowork.session.not-ready", status: 0 };
const notReady = () => Promise.resolve(NOT_READY);
const noop = () => {};
const noSubscribe = () => noop;

/**
 * A co-work session in a React tree. One person's browser, many peers: their
 * views, cursors (on this route only) and control state, plus the actions
 * (`follow`, `requestControl`, `release`, `sendIntent`, ...).
 *
 * The session is created when a transport is present and destroyed on unmount
 * (which leaves the presence channel). Callbacks and `config` are read through a
 * ref, so passing new functions each render does not restart it; `authorize`
 * being bound or not is fixed at creation, like the transport.
 *
 * ```tsx
 * const session = useCoworkSession({ sessionId, self, transport, adapter, config, authorize, onAppMessage });
 * <CoworkPresence session={session} />
 * <CoBrowseCursorLayer peers={session} />
 * ```
 */
export function useCoworkSession(options: UseCoworkSessionOptions): CoworkSessionHandle {
  const latest = useRef(options);
  latest.current = options;
  const [session, setSession] = useState<CoworkSession | null>(null);
  const bound = options.authorize !== null && options.authorize !== undefined;

  useEffect(() => {
    const transport = options.transport;
    if (!transport) return;
    const current = latest.current;
    const created = createCoworkSession({
      ...current,
      transport,
      config: () => {
        const config = latest.current.config;
        return typeof config === "function" ? config() : config;
      },
      authorize: bound ? (ref, ability, intent) => latest.current.authorize?.(ref, ability, intent) ?? false : null,
      ...(current.members ? { members: (ref) => latest.current.members?.(ref) ?? false } : {}),
      ...(current.predicate ? { predicate: (name, ctx, intent) => latest.current.predicate?.(name, ctx, intent) } : {}),
      onAppMessage: (message) => latest.current.onAppMessage?.(message),
      onRefused: (refusal) => latest.current.onRefused?.(refusal),
    });
    setSession(created);
    return () => {
      created.destroy();
      setSession((s) => (s === created ? null : s));
    };
    // Recreate only for a new session, transport, person or policy binding.
  }, [options.sessionId, options.transport, options.self.ref, bound]);

  const empty = useMemo<CoworkSnapshot>(
    () => ({
      sessionId: options.sessionId,
      self: options.self.ref,
      routing: options.transport?.routing ?? "direct",
      consent: null,
      peers: [],
      control: {},
      blocked: null,
      configured: false,
    }),
    [options.sessionId, options.self.ref, options.transport],
  );

  const snapshot = useSyncExternalStore(
    session ? session.subscribe : noSubscribe,
    () => (session ? session.getSnapshot() : empty),
    () => empty,
  );

  // A ranked block counts down, and idleness is time: re-read the clock while it matters.
  const ticking = snapshot.blocked?.until !== undefined;
  useEffect(() => {
    if (!session || !ticking) return;
    const timer = setInterval(() => session.refresh(), 250);
    return () => clearInterval(timer);
  }, [session, ticking]);

  return useMemo<CoworkSessionHandle>(() => {
    if (!session) {
      return {
        ...snapshot,
        ready: false,
        refresh: noop,
        sendIntent: notReady,
        reportVisit: notReady,
        reportScroll: notReady,
        reportField: notReady,
        moveCursor: noop,
        follow: notReady,
        unfollow: notReady,
        requestControl: notReady,
        grant: notReady,
        release: notReady,
        revoke: notReady,
        leave: noop,
      };
    }
    return {
      ...snapshot,
      ready: true,
      refresh: session.refresh,
      sendIntent: session.sendIntent,
      reportVisit: session.reportVisit,
      reportScroll: session.reportScroll,
      reportField: session.reportField,
      moveCursor: session.moveCursor,
      follow: session.follow,
      unfollow: session.unfollow,
      requestControl: session.requestControl,
      grant: session.grant,
      release: session.release,
      revoke: session.revoke,
      leave: session.leave,
    };
  }, [session, snapshot]);
}
