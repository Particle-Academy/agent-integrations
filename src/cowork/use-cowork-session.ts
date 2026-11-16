import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { createCoworkSession, createRefusalWarner, type CoworkSession, type CoworkSessionOptions, type CoworkSnapshot } from "./session";
import type { PeerTransport } from "./transport";
import type { Decision } from "./types";

export type UseCoworkSessionOptions = Omit<CoworkSessionOptions, "transport"> & {
  /**
   * Nothing happens until there is one. Create it ONCE (useMemo on the channel, the
   * session id and self.ref, or module scope). A new transport object on the SAME channel
   * does not restart the session; a transport on a NEW channel (the page re-joined, or a
   * second Echo) does, because the old channel no longer delivers anything.
   */
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
 * (which leaves the presence channel). ONE session per `sessionId`, `self.ref` and
 * whether `authorize` is bound. Everything else may be an inline value rebuilt on
 * every render (`self`, `config` with a rank function, `authorize`, `sharedFields`,
 * `adapter`, callbacks, even the transport object): it is read through a ref and
 * never restarts the session or changes its functions' identity.
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

  const hasTransport = Boolean(options.transport);
  // The CHANNEL a server transport listens on, as a stable key: a page that re-joins its
  // channel (or builds a second Echo) gets a new channel object, and a session left on the
  // old one hears nothing while its POSTs still work. A transport rebuilt inline on the
  // same channel keeps the same key, so it never restarts the session.
  const channelIds = useRef(new WeakMap<object, number>());
  const nextChannelId = useRef(0);
  const channel = (options.transport as { channel?: unknown } | null | undefined)?.channel;
  let channelKey = 0;
  if (channel !== null && typeof channel === "object") {
    let id = channelIds.current.get(channel);
    if (id === undefined) {
      id = ++nextChannelId.current;
      channelIds.current.set(channel, id);
    }
    channelKey = id;
  }
  useEffect(() => {
    const transport = latest.current.transport;
    if (!transport) return;
    const current = latest.current;
    const live = latest;
    const warnRefusal = createRefusalWarner();
    const created = createCoworkSession({
      ...current,
      // Read at use, so an inline value passed on a later render is the one used.
      get adapter() { return live.current.adapter; },
      get sharedFields() { return live.current.sharedFields; },
      get isDestructive() { return live.current.isDestructive; },
      get pendingMode() { return live.current.pendingMode; },
      transport,
      config: () => {
        const config = latest.current.config;
        return typeof config === "function" ? config() : config;
      },
      authorize: bound ? (ref, ability, intent) => latest.current.authorize?.(ref, ability, intent) ?? false : null,
      ...(current.members ? { members: (ref) => latest.current.members?.(ref) ?? false } : {}),
      ...(current.predicate ? { predicate: (name, ctx, intent) => latest.current.predicate?.(name, ctx, intent) } : {}),
      onAppMessage: (message) => latest.current.onAppMessage?.(message),
      // No handler from the host: warn once per kind of refusal rather than drop it.
      onRefused: (refusal) => (latest.current.onRefused ? latest.current.onRefused(refusal) : warnRefusal(refusal)),
    });
    setSession(created);
    return () => {
      created.destroy();
      setSession((s) => (s === created ? null : s));
    };
    // Recreate only for a new session, person or policy binding, the first transport, or a
    // transport on a NEW channel.
  }, [options.sessionId, hasTransport, options.self.ref, bound, channelKey]);

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
