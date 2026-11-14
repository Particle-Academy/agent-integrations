/**
 * A co-work session in one browser: the framework-free core behind
 * `useCoworkSession`.
 *
 * Every peer keeps a MIRROR of the session (participants, their views, control
 * state, rate windows) and runs every intent through the same pipeline as the
 * servers, `./engine`: once at the sender, before anything is sent, and again at
 * every receiver, before anything is applied. In `direct` routing that second
 * run is the only enforcement there is, so it is never skipped.
 *
 * What it guarantees, beyond the pipeline:
 *
 * - **A masked value never leaves the browser.** A field that is masked by the
 *   host's config, sensitive in the DOM (password, `cc-*`, `one-time-code`,
 *   `data-private`) or view-only (`data-cowork="view-only"`) is reported as a
 *   `field-active` activity frame, never as a value. A drive INTO such a field
 *   is refused before it is sent, and again at the receiver.
 * - **Exactly one browser performs a side effect.** Only the owner of the target
 *   view applies an intent to its page; everyone else updates the mirror.
 *   Followers mirror only `visit` and `scroll` of the peer they follow.
 * - **Apply goes guard -> adapter.** The page's own `NavigationBridgeAdapter`
 *   performs the action, after its `guard` (the off-limits fence) agrees.
 *
 * Nothing here has a user, org or role model. Peers are opaque refs that the
 * transport attributes; who may do what is the host's `authorize`, and with no
 * `authorize` or no `config` everything is refused.
 */
import type { NavigationBridgeAdapter, NavigationGuardAction } from "../bridges/navigation";
import { attributeHandle, isSensitive } from "../dom-navigation/agent";
import {
  createSessionState,
  evaluateFollow,
  evaluateIntent,
  evaluateLeave,
  globMatch,
  holderOf,
  isValidRef,
  refuse,
  resolveConfig,
  routeOf,
  type EngineHost,
  type MiddlewareEntry,
  type PipelineContext,
  type Result,
} from "./engine";
import { readFrame, type CoworkFrame, type PeerInfo, type PeerTransport, type PresenceEvent, type ReceivedFrame } from "./transport";
import type { Decision, Envelope, HostAnswer, Intent, MaybePromise, Ref, SessionConfig, SessionConfigInput, SessionState } from "./types";

export type CoworkCursor = { anchor: string; fx: number; fy: number } | { x: number; y: number };

export type CoworkPeer = {
  ref: Ref;
  label?: string;
  self: boolean;
  view: { route: string; revision: number };
  follows: Ref | null;
  /** Holds, or recently acted in, a view that is not its own. */
  drives: boolean;
  /** Nothing heard from it for `idleAfterMs`. */
  idle: boolean;
  /** Its cursor, only while it is on the same route as this browser. */
  cursor: CoworkCursor | null;
  /** A field it is editing whose value is not shared (masked), or the last one it said it was. */
  activeField: string | null;
};

export type CoworkViewControl = {
  mode: SessionConfig["control"]["mode"];
  /** Baton holder. */
  holder?: Ref;
  requests: Ref[];
  /** Ranked: when THIS browser may act in the view again. */
  blockedUntil?: number;
};

/** Why the local person cannot act in their own view right now. */
export type CoworkBlock = { view: Ref; by: Ref; label?: string; until?: number; mode: "ranked" | "baton" };

export type CoworkSnapshot = {
  sessionId: string;
  self: Ref;
  routing: PeerTransport["routing"];
  consent: SessionConfig["consent"] | null;
  peers: CoworkPeer[];
  control: Record<Ref, CoworkViewControl>;
  blocked: CoworkBlock | null;
  /** False until the host binds both `config` and `authorize`. */
  configured: boolean;
};

export type CoworkRefusal = { reason: string; status: number; from: Ref; kind?: string; stage: "sender" | "receiver" | "apply" };
export type CoworkAppMessage = { from: Ref; topic: string; payload: unknown };

type ConfigSource = SessionConfigInput | null | undefined | (() => SessionConfigInput | null | undefined);

export type CoworkSessionOptions = {
  sessionId: string;
  self: PeerInfo;
  transport: PeerTransport;
  /** The page this browser shows. Without one, intents into this view update the mirror and nothing else. */
  adapter?: NavigationBridgeAdapter & { focus?: (handle: string) => MaybePromise<{ ok: boolean; error?: string } | void> };
  /** The host's session config. Unbound (null) refuses everything with `cowork.unconfigured.config`. */
  config: ConfigSource;
  /** The host's policy, for ANY ref: receivers ask it about the sender. Unbound refuses everything. */
  authorize: ((ref: Ref, ability: string, intent?: Intent) => MaybePromise<HostAnswer>) | null;
  /** Membership. Default: the presence channel's members, which the server's channel auth admitted. */
  members?: (ref: Ref) => MaybePromise<boolean>;
  /** Named predicates for limits rules' `when`. An unknown name fails closed. */
  predicate?: (name: string, ctx: PipelineContext, intent: Intent) => MaybePromise<boolean | undefined>;
  /** The middleware stack; default the shipped one. */
  middleware?: MiddlewareEntry[];
  /** Who started the session, for consent's default subject. Default: self. */
  starter?: Ref;
  /** Where handles resolve to elements, for DOM masking. Default `document`. */
  root?: ParentNode;
  /** `submit`, and a click `isDestructive` flags, go through `adapter.confirm` when present. Default true. */
  pendingMode?: boolean;
  isDestructive?: (handle: string) => boolean;
  onAppMessage?: (message: CoworkAppMessage) => void;
  onRefused?: (refusal: CoworkRefusal) => void;
  now?: () => number;
  idleAfterMs?: number;
  /** Minimum gap between cursor frames. Default 50 ms (20 Hz). */
  cursorIntervalMs?: number;
};

export type SendOptions = { view?: Ref; to?: Ref[] };

export interface CoworkSession {
  getSnapshot(): CoworkSnapshot;
  subscribe(listener: () => void): () => void;
  /** Recompute time-based state (idle, blocked countdowns) and notify if it changed. */
  refresh(): void;
  /** Send an intent. `view` defaults to this browser's own for view intents. */
  sendIntent(intent: Intent, options?: SendOptions): Promise<Decision>;
  /** Report that this person navigated. Followers mirror it. */
  reportVisit(url: string): Promise<Decision>;
  reportScroll(y: number, anchor?: string): Promise<Decision>;
  /** Report a local field edit. A masked field sends only that it is active. */
  reportField(handle: string, value: unknown): Promise<Decision>;
  moveCursor(cursor: CoworkCursor): void;
  follow(ref: Ref): Promise<Decision>;
  unfollow(): Promise<Decision>;
  requestControl(view: Ref): Promise<Decision>;
  grant(ref: Ref, view?: Ref): Promise<Decision>;
  release(view: Ref): Promise<Decision>;
  revoke(view?: Ref): Promise<Decision>;
  leave(): void;
  destroy(): void;
}

const VIEW_KINDS = new Set(["visit", "scroll", "field", "focus", "click", "submit"]);
const GUARD_ACTION: Partial<Record<Intent["kind"], NavigationGuardAction>> = {
  field: "setField",
  focus: "focus",
  click: "click",
  submit: "submit",
  scroll: "scrollTo",
};

export function createCoworkSession(options: CoworkSessionOptions): CoworkSession {
  const self = options.self.ref;
  const now = options.now ?? (() => Date.now());
  const idleAfterMs = options.idleAfterMs ?? 30_000;
  const cursorIntervalMs = options.cursorIntervalMs ?? 50;
  const transport = options.transport;

  let state: SessionState = createSessionState({
    id: options.sessionId,
    state: "live",
    starter: options.starter ?? self,
    participants: [{ ref: self, ...(options.self.label !== undefined ? { label: options.self.label } : {}) }],
    now: now(),
  });
  const labels = new Map<Ref, string | undefined>([[self, options.self.label]]);
  const cursors = new Map<Ref, { route: string; cursor: CoworkCursor }>();
  const activeFields = new Map<Ref, string | null>();
  const lastSeen = new Map<Ref, number>();
  const heardHello = new Set<Ref>();
  const listeners = new Set<() => void>();
  let snapshot: CoworkSnapshot | null = null;
  let snapshotKey = "";
  let destroyed = false;

  // One queue for every state change, local or remote. The engine is async
  // (host callbacks may be), so without it two frames could each be judged
  // against the same stale state.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  const resolvedConfig = (): SessionConfig | null => {
    const source = typeof options.config === "function" ? options.config() : options.config;
    return source == null ? null : resolveConfig(source);
  };

  const host = (): EngineHost => ({
    identity: true,
    config: resolvedConfig(),
    members: options.members ?? ((ref) => ref in state.participants),
    authorize: options.authorize,
    ...(options.predicate ? { predicate: options.predicate } : {}),
    ...(options.middleware ? { middleware: options.middleware } : {}),
  });

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  const rankOf = (config: SessionConfig, ref: Ref): number => {
    if (config.control.mode !== "ranked") return 0;
    const rank = config.control.rank;
    const value = typeof rank === "function" ? rank(ref) : rank?.[ref];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };

  /** Ranked: when `ref` may next act in `view`, and who is in the way. */
  const rankedBlock = (config: SessionConfig, view: Ref, ref: Ref, at: number): { until: number; by: Ref } | null => {
    if (config.control.mode !== "ranked") return null;
    const idleMs = config.control.idleMs ?? 3000;
    const mine = rankOf(config, ref);
    let best: { until: number; by: Ref } | null = null;
    for (const [other, last] of Object.entries(state.last[view] ?? {})) {
      if (other === ref || rankOf(config, other) <= mine || at - last >= idleMs) continue;
      if (!best || last + idleMs > best.until) best = { until: last + idleMs, by: other };
    }
    return best;
  };

  const compute = (): CoworkSnapshot => {
    const config = resolvedConfig();
    const at = now();
    const mode = config?.control.mode ?? "baton";
    const route = state.participants[self]?.route ?? "/";
    const control: Record<Ref, CoworkViewControl> = {};
    for (const view of Object.keys(state.participants)) {
      const entry: CoworkViewControl = { mode, requests: [] };
      if (mode === "baton") {
        const baton = holderOf(state, view);
        entry.holder = baton.holder;
        entry.requests = [...baton.requests];
      }
      if (config && mode === "ranked") {
        const block = rankedBlock(config, view, self, at);
        if (block) entry.blockedUntil = block.until;
      }
      control[view] = entry;
    }
    const drives = (ref: Ref): boolean => {
      for (const view of Object.keys(state.participants)) {
        if (view === ref) continue;
        if (mode === "baton" && holderOf(state, view).holder === ref) return true;
        const last = state.last[view]?.[ref];
        if (mode !== "baton" && last !== undefined && at - last < 3000) return true;
      }
      return false;
    };
    const peers: CoworkPeer[] = Object.values(state.participants).map((p) => {
      const seen = p.ref === self ? at : (lastSeen.get(p.ref) ?? p.joinedAt);
      const c = cursors.get(p.ref);
      const label = labels.get(p.ref) ?? p.label;
      return {
        ref: p.ref,
        ...(label !== undefined ? { label } : {}),
        self: p.ref === self,
        view: { route: p.route, revision: p.revision },
        follows: p.follows,
        drives: drives(p.ref),
        idle: p.ref !== self && at - seen >= idleAfterMs,
        cursor: p.ref !== self && c && c.route === route ? c.cursor : null,
        activeField: activeFields.get(p.ref) ?? null,
      };
    });
    let blocked: CoworkBlock | null = null;
    if (config && mode === "ranked") {
      const block = rankedBlock(config, self, self, at);
      if (block) {
        const label = labels.get(block.by);
        blocked = { view: self, by: block.by, ...(label !== undefined ? { label } : {}), until: block.until, mode: "ranked" };
      }
    } else if (mode === "baton" && state.participants[self]) {
      const holder = holderOf(state, self).holder;
      if (holder !== self) {
        const label = labels.get(holder);
        blocked = { view: self, by: holder, ...(label !== undefined ? { label } : {}), mode: "baton" };
      }
    }
    return {
      sessionId: options.sessionId,
      self,
      routing: transport.routing,
      consent: config?.consent ?? null,
      peers,
      control,
      blocked,
      configured: config !== null && options.authorize !== null,
    };
  };

  const changed = () => {
    const next = compute();
    const key = JSON.stringify(next);
    if (snapshot && key === snapshotKey) return;
    snapshot = next;
    snapshotKey = key;
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* One subscriber cannot break the others. */ }
    }
  };

  // -------------------------------------------------------------------------
  // DOM masking
  // -------------------------------------------------------------------------

  const root = (): ParentNode | null => options.root ?? (typeof document === "undefined" ? null : document);

  const elementFor = (handle: string): Element | null => {
    const scope = root();
    if (!scope) return null;
    for (const el of Array.from(scope.querySelectorAll("[data-co-handle], [name], [id]"))) {
      if (attributeHandle(el) === handle) return el;
    }
    return null;
  };

  const withinSensitive = (el: Element): boolean => {
    for (let node: Element | null = el; node; node = node.parentElement) if (isSensitive(node)) return true;
    return false;
  };

  /** Why this browser's page will not share or accept a value for `handle`, if it will not. */
  const domRefusal = (intent: Intent): string | null => {
    if (intent.kind !== "field" && intent.kind !== "click" && intent.kind !== "submit" && intent.kind !== "focus") return null;
    const el = elementFor(intent.handle);
    if (!el) return null;
    if (el.closest("[data-agent-off-limits]")) return "cowork.denied.off-limits";
    if (intent.kind === "focus") return null;
    if (intent.kind === "field" && withinSensitive(el)) return "cowork.denied.masked";
    if (el.closest('[data-cowork="view-only"]')) return "cowork.denied.view-only";
    return null;
  };

  const configRefusal = (handle: string, config: SessionConfig | null): string | null => {
    if (!config) return null;
    if (config.limits.mask.some((glob) => globMatch(glob, handle))) return "cowork.denied.masked";
    if (config.limits.viewOnly.some((glob) => globMatch(glob, handle))) return "cowork.denied.view-only";
    return null;
  };

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  const report = (refusal: CoworkRefusal) => {
    try { options.onRefused?.(refusal); } catch { /* A host callback cannot break the session. */ }
  };

  const newId = () => `${self.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16) || "p"}-${Math.random().toString(36).slice(2, 12)}`;

  const send = (frame: CoworkFrame): Promise<Decision> => {
    if (destroyed) return Promise.resolve(refuse("cowork.transport.closed", 0));
    return transport.send(frame).catch(() => refuse("cowork.transport.failed", 0));
  };

  const commit = (result: Result) => {
    state = result.state;
    changed();
  };

  const sendIntent = (intent: Intent, sendOptions: SendOptions = {}): Promise<Decision> =>
    serial(async () => {
      const isView = VIEW_KINDS.has(intent.kind);
      const view = sendOptions.view ?? (isView || intent.kind === "control" ? self : undefined);
      const local = (reason: string, status = 403): Decision => {
        const decision = refuse(reason, status);
        report({ reason, status, from: self, kind: intent.kind, stage: "sender" });
        return decision;
      };

      // Masking happens HERE, before the pipeline and before the wire: a masked
      // value must never be in a frame, refused or not.
      if (intent.kind === "field" || intent.kind === "click" || intent.kind === "submit") {
        const config = resolvedConfig();
        const reason = (intent.kind === "field" ? configRefusal(intent.handle, config) : null) ?? domRefusal(intent);
        if (reason) {
          if (intent.kind === "field" && view === self) {
            activeFields.set(self, intent.handle);
            await send({ t: "activity", view: self, handle: intent.handle, active: true });
            changed();
          }
          return local(reason);
        }
      }

      const envelope: Envelope = {
        id: newId(),
        ...(sendOptions.to !== undefined ? { to: [...sendOptions.to] } : {}),
        ...(view !== undefined ? { view } : {}),
        ...(isView && view !== undefined ? { revision: state.participants[view]?.revision ?? 0 } : {}),
      };
      const result = await evaluateIntent(host(), state, { from: self, envelope, intent, now: now() });
      if (!result.decision.allow) {
        const { reason, status } = result.decision;
        report({ reason, status, from: self, kind: intent.kind, stage: "sender" });
        return result.decision;
      }
      const sent = await send({ t: "intent", envelope, intent });
      if (!sent.allow) {
        report({ reason: sent.reason, status: sent.status, from: self, kind: intent.kind, stage: "sender" });
        return sent;
      }
      commit(result);
      return result.decision;
    });

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------

  const guardThenApply = async (intent: Intent, act: () => MaybePromise<unknown>): Promise<string | null> => {
    const adapter = options.adapter;
    if (!adapter) return null;
    const action = GUARD_ACTION[intent.kind];
    const handle = "handle" in intent ? intent.handle : intent.kind === "scroll" ? intent.anchor : undefined;
    if (action && handle !== undefined && adapter.guard) {
      let verdict: unknown;
      try { verdict = await adapter.guard(action, handle); } catch { verdict = null; }
      // A fence that cannot answer is closed.
      if (!verdict || typeof verdict !== "object" || (verdict as { ok?: unknown }).ok !== true) return "cowork.denied.guard";
    }
    try {
      const result = (await act()) as { ok?: unknown } | undefined;
      if (result && typeof result === "object" && "ok" in result && result.ok === false) return "cowork.apply.failed";
    } catch {
      return "cowork.apply.failed";
    }
    return null;
  };

  /** Perform an intent on THIS browser's page. Only ever called for the owner's own view. */
  const applyToPage = async (from: Ref, intent: Intent): Promise<void> => {
    const adapter = options.adapter;
    if (!adapter) return;
    const dom = domRefusal(intent);
    if (dom) {
      report({ reason: dom, status: 403, from, kind: intent.kind, stage: "apply" });
      return;
    }
    const pending = options.pendingMode ?? true;
    const confirm = async (action: "submit" | "click", handle: string) =>
      !pending || !adapter.confirm ? true : adapter.confirm({ action, handle, label: handle }).catch(() => false);
    let failure: string | null = null;
    switch (intent.kind) {
      case "visit":
        failure = await guardThenApply(intent, () => adapter.visit(intent.url));
        break;
      case "scroll":
        failure = await guardThenApply(intent, () => adapter.scrollTo({ y: intent.y, ...(intent.anchor !== undefined ? { handle: intent.anchor } : {}) }));
        break;
      case "field":
        failure = await guardThenApply(intent, () => adapter.setField(intent.handle, intent.value));
        break;
      case "focus":
        failure = await guardThenApply(intent, () => (adapter.focus ? adapter.focus(intent.handle) : adapter.scrollTo({ handle: intent.handle })));
        break;
      case "click":
        failure = await guardThenApply(intent, async () =>
          options.isDestructive?.(intent.handle) && !(await confirm("click", intent.handle)) ? { ok: false } : adapter.click(intent.handle),
        );
        break;
      case "submit":
        failure = await guardThenApply(intent, async () => ((await confirm("submit", intent.handle)) ? adapter.submit(intent.handle) : { ok: false }));
        break;
      default:
        return;
    }
    if (failure) report({ reason: failure, status: 403, from, kind: intent.kind, stage: "apply" });
  };

  const receiveIntent = async (from: Ref, frame: Extract<CoworkFrame, { t: "intent" }>) => {
    const envelope: Envelope = { ...frame.envelope, from };
    const intent = frame.intent;
    const result = await evaluateIntent(host(), state, { from, envelope, intent, now: now() });
    if (!result.decision.allow) {
      report({ reason: result.decision.reason, status: result.decision.status, from, kind: String((intent as { kind?: unknown }).kind), stage: "receiver" });
      return;
    }
    const me = state.participants[self];
    const followed = me?.follows === from;
    commit(result);
    const view = envelope.view;

    if (intent.kind === "app") {
      if (!envelope.to || envelope.to.includes(self)) {
        try { options.onAppMessage?.({ from, topic: intent.topic, payload: intent.payload }); } catch { /* host callback */ }
      }
      return;
    }
    if (view === self && from !== self) {
      // A drive into this browser's own view: the one place it is performed.
      await applyToPage(from, intent);
      return;
    }
    if (view === from && followed && (intent.kind === "visit" || intent.kind === "scroll")) {
      // Following: mirror the leader's navigation onto this page, then say where we are now.
      if (intent.kind === "visit") {
        if (routeOf(intent.url) === state.participants[self]?.route) return;
        await applyToPage(from, intent);
        void sendIntentLater({ kind: "visit", url: intent.url });
      } else {
        await applyToPage(from, intent);
      }
    }
  };

  /** Queue a report behind the current work rather than inside it. */
  const sendIntentLater = (intent: Intent) => Promise.resolve().then(() => sendIntent(intent));

  const helloFrame = (): CoworkFrame => {
    const me = state.participants[self];
    return { t: "hello", route: me?.route ?? "/", revision: me?.revision ?? 0, follows: me?.follows ?? null };
  };

  const receive = (message: ReceivedFrame) =>
    serial(async () => {
      if (destroyed) return;
      const from = message.from;
      const frame = readFrame(message.frame);
      if (!frame || from === self || !state.participants[from]) return;
      lastSeen.set(from, now());
      switch (frame.t) {
        case "intent":
          await receiveIntent(from, frame);
          return;
        case "cursor":
          cursors.set(from, {
            route: frame.route,
            cursor: frame.anchor !== undefined ? { anchor: frame.anchor, fx: frame.fx!, fy: frame.fy! } : { x: frame.x!, y: frame.y! },
          });
          changed();
          return;
        case "activity":
          if (frame.view !== from) return;
          activeFields.set(from, frame.active ? frame.handle : null);
          changed();
          return;
        case "hello": {
          // A peer describes its OWN view. Revision only moves forward, so a
          // hello cannot make a stale intent current again.
          const p = state.participants[from];
          if (p && frame.revision >= p.revision) {
            const next = structuredClone(state);
            next.participants[from]!.route = routeOf(frame.route);
            next.participants[from]!.revision = frame.revision;
            state = next;
          }
          if (!heardHello.has(from)) {
            heardHello.add(from);
            await send(helloFrame());
          }
          changed();
          return;
        }
        case "follow": {
          const result = await evaluateFollow(host(), state, { from, target: frame.target, now: now() });
          if (!result.decision.allow) {
            report({ reason: result.decision.reason, status: result.decision.status, from, kind: "follow", stage: "receiver" });
            return;
          }
          commit(result);
          return;
        }
      }
    });

  const onPresence = (event: PresenceEvent) =>
    serial(async () => {
      if (destroyed) return;
      const add = (peer: PeerInfo) => {
        if (peer.label !== undefined) labels.set(peer.ref, peer.label);
        if (!isValidRef(peer.ref) || Object.prototype.hasOwnProperty.call(state.participants, peer.ref)) return;
        const next = structuredClone(state);
        next.participants[peer.ref] = {
          ref: peer.ref,
          ...(peer.label !== undefined ? { label: peer.label } : {}),
          route: "/",
          revision: 0,
          follows: null,
          joinedAt: now(),
        };
        state = next;
      };
      const drop = async (ref: Ref) => {
        if (ref === self || !state.participants[ref]) return;
        const result = await evaluateLeave(host(), state, { from: ref, now: now() });
        if (result.decision.allow) state = result.state;
        cursors.delete(ref);
        activeFields.delete(ref);
        heardHello.delete(ref);
      };
      if (event.type === "here") {
        const present = new Set(event.peers.map((p) => p.ref));
        for (const peer of event.peers) add(peer);
        for (const ref of Object.keys(state.participants)) if (!present.has(ref)) await drop(ref);
        // Say where this browser is; everyone who has not heard from it answers in kind.
        await send(helloFrame());
      } else if (event.type === "joining") add(event.peer);
      else await drop(event.peer.ref);
      changed();
    });

  const offFrame = transport.onFrame((message) => void receive(message));
  const offPresence = transport.onPresence((event) => void onPresence(event));

  // -------------------------------------------------------------------------
  // Cursors (lossy, throttled, never intents)
  // -------------------------------------------------------------------------

  let lastCursorAt = -Infinity;
  let pendingCursor: CoworkCursor | null = null;
  let cursorTimer: ReturnType<typeof setTimeout> | undefined;
  const flushCursor = () => {
    cursorTimer = undefined;
    if (!pendingCursor || destroyed) return;
    const cursor = pendingCursor;
    pendingCursor = null;
    lastCursorAt = Date.now();
    void send({ t: "cursor", route: state.participants[self]?.route ?? "/", ...cursor });
  };

  // -------------------------------------------------------------------------
  // The public surface
  // -------------------------------------------------------------------------

  const follow = (target: Ref | null): Promise<Decision> =>
    serial(async () => {
      const result = await evaluateFollow(host(), state, { from: self, target, now: now() });
      if (!result.decision.allow) {
        report({ reason: result.decision.reason, status: result.decision.status, from: self, kind: "follow", stage: "sender" });
        return result.decision;
      }
      const sent = await send({ t: "follow", target });
      if (!sent.allow) return sent;
      commit(result);
      return result.decision;
    });

  const session: CoworkSession = {
    getSnapshot() {
      if (!snapshot) {
        snapshot = compute();
        snapshotKey = JSON.stringify(snapshot);
      }
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: changed,
    sendIntent,
    reportVisit: (url) => sendIntent({ kind: "visit", url }),
    reportScroll: (y, anchor) => sendIntent({ kind: "scroll", y, ...(anchor !== undefined ? { anchor } : {}) }),
    reportField: (handle, value) => sendIntent({ kind: "field", handle, value }),
    moveCursor(cursor) {
      if (destroyed) return;
      pendingCursor = "anchor" in cursor ? { anchor: cursor.anchor, fx: cursor.fx, fy: cursor.fy } : { x: cursor.x, y: cursor.y };
      if (cursorTimer !== undefined) return;
      const wait = lastCursorAt + cursorIntervalMs - Date.now();
      if (wait <= 0) flushCursor();
      else cursorTimer = setTimeout(flushCursor, wait);
    },
    follow: (ref) => follow(ref),
    unfollow: () => follow(null),
    requestControl: (view) => sendIntent({ kind: "control", op: "request" }, { view }),
    grant: (ref, view = self) => sendIntent({ kind: "control", op: "grant", target: ref }, { view }),
    release: (view) => sendIntent({ kind: "control", op: "release" }, { view }),
    revoke: (view = self) => sendIntent({ kind: "control", op: "revoke" }, { view }),
    leave() {
      session.destroy();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(cursorTimer);
      offFrame();
      offPresence();
      transport.close();
      listeners.clear();
    },
  };
  return session;
}
