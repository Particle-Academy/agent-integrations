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
  rankedActs,
  REASONS,
  refuse,
  resolveConfig,
  routeOf,
  type EngineHost,
  type MiddlewareEntry,
  type PipelineContext,
  type Result,
} from "./engine";
import { createInputBlocker, type InputBlocker } from "./input-block";
import { readFrame, type CoworkSyncState, type CoworkFrame, type PeerInfo, type PeerTransport, type PresenceEvent, type ReceivedFrame } from "./transport";
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
  /**
   * Connected now: on the presence channel (its member list), else what the server's
   * re-sync says. A joined participant who closed the browser is listed but offline
   * until the server expires them.
   */
  online: boolean;
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

/**
 * What a session does with a refusal when the host passed no `onRefused`: one console
 * warning per stage, kind and reason. A refusal at the sender is decided before the
 * network, so without this it leaves no trace anywhere (MOIC, 0.64.0: a run with no
 * field intents at all, and nothing to say why). Internal; the hook uses it too.
 */
export function createRefusalWarner(): (refusal: CoworkRefusal) => void {
  const warned = new Set<string>();
  return (refusal) => {
    const key = `${refusal.stage}|${refusal.kind ?? ""}|${refusal.reason}`;
    if (warned.has(key) || typeof console === "undefined") return;
    warned.add(key);
    console.warn(
      `[cowork] ${refusal.kind ?? "intent"} refused at the ${refusal.stage}: ${refusal.reason} (${refusal.status}, from ${refusal.from}). ` +
        "Pass onRefused to handle refusals; this warning is shown once per stage, kind and reason.",
    );
  };
}

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
  /**
   * Minimum gap between cursor frames. Default 50 ms (20 Hz) when presence is
   * whispered, 100 ms (10 Hz, the server's default `cursorsPerSecond`) when it goes
   * through the server.
   */
  cursorIntervalMs?: number;
  /**
   * After this browser applies a FOLLOWED peer's visit or scroll, a local
   * `reportVisit` of that same route, or any `reportScroll`, within this many ms
   * is allowed but not sent. A host's own navigation and scroll listeners report
   * what the session just applied; without this, mutual follow would send each
   * visit twice and bounce scrolls between two viewports. Default 1000.
   */
  followEchoMs?: number;
  /**
   * How cursors and the masked-field "activity" indicator travel. `direct`
   * whispers them on the presence channel; the receiver attributes a whisper only
   * by the sender the socket SERVER stamps on it (Reverb and Pusher do), and drops
   * one it cannot attribute. `server` posts them as `cursor` / `activity` intents to
   * the intent endpoint, where the server stamps the authenticated sender and relays
   * them. **Sockudo (Genie's WebSockets service) does not stamp senders on client
   * events: use `server`.** `auto` (default): `server` on a server transport,
   * `direct` otherwise.
   */
  presenceRouting?: "server" | "direct" | "auto";
  /**
   * Block this person's own keyboard and pointer presses while someone else has
   * control of their view (ranked: a higher rank acted within `idleMs`; baton: the
   * baton is elsewhere). Pointer movement stays free, and the controlling peer's
   * intents still land. Default ON. `false` leaves only the `blocked` snapshot state
   * for the host to render. The root element (or `<html>`) carries
   * `data-cowork-blocked="ranked|baton"` while it holds.
   */
  blockInput?: boolean | { target?: EventTarget; isUserEvent?: (event: Event) => boolean; onBlocked?: (event: Event) => void };
  /**
   * Shared document fields (handle globs, `*` any run): a peer's edit to one of
   * these, made on the SAME route as this browser, is applied here too, last
   * writer wins (the multi-page document editor). It goes through the same DOM
   * masking and `guard` as a drive, a masked value is never sent in the first
   * place, a field the person is typing in waits for their blur (and is dropped if
   * they edit it first), and an applied value is not echoed back. Default none.
   */
  sharedFields?: string[];
  /** Server routing: how often to tell the server this participant is still here. Default 30000. */
  heartbeatMs?: number;
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
const ALLOW_DECISION: Decision = { allow: true };
/** Comparable form of a field value; a value that cannot be encoded never matches. */
const stableJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return " unencodable";
  }
};
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
  const transport = options.transport;
  const presenceRouting: "server" | "direct" =
    options.presenceRouting === "server" || options.presenceRouting === "direct"
      ? options.presenceRouting
      : transport.routing === "server"
        ? "server"
        : "direct";
  const cursorIntervalMs = options.cursorIntervalMs ?? (presenceRouting === "server" ? 100 : 50);

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
  /** Live presence: who the presence channel says is connected, once it has said anything. */
  const presentRefs = new Set<Ref>();
  let presenceKnown = false;
  const syncOnline = new Map<Ref, boolean>();
  const listeners = new Set<() => void>();
  let snapshot: CoworkSnapshot | null = null;
  let snapshotKey = "";
  let destroyed = false;
  /** Shared fields: the value last applied from a peer, per handle (its echo is not re-sent). */
  const appliedShared = new Map<string, string>();
  /** Own fields: the value the server last ACCEPTED (or a peer's value applied here). */
  const acceptedField = new Map<string, string>();
  /** Shared fields: a peer's value waiting for the person to leave the field. */
  const waitingShared = new Map<string, { from: Ref; intent: Extract<Intent, { kind: "field" }> }>();

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
    for (const [other, last] of rankedActs(state, config, view)) {
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
        online: p.ref === self || (presenceKnown ? presentRefs.has(p.ref) : (syncOnline.get(p.ref) ?? true)),
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
    syncBlock();
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* One subscriber cannot break the others. */ }
    }
  };

  // -------------------------------------------------------------------------
  // Input blocking (ranked / baton control)
  // -------------------------------------------------------------------------

  /** Live, against the clock: the hand-back happens at `until` even between refreshes. */
  const isBlockedNow = (): boolean => {
    if (destroyed) return false;
    const blocked = session.getSnapshot().blocked;
    if (!blocked) return false;
    return blocked.until === undefined || now() < blocked.until;
  };
  const blockOption = options.blockInput ?? true;
  const blockTarget = (): EventTarget | undefined => {
    if (typeof blockOption === "object" && blockOption.target) return blockOption.target;
    const r = root();
    return r ? (r as unknown as EventTarget) : undefined;
  };
  const markElement = (): Element | null => {
    const r = root();
    if (r && typeof (r as Element).setAttribute === "function") return r as Element;
    return typeof document === "undefined" ? null : document.documentElement;
  };
  let handBackTimer: ReturnType<typeof setTimeout> | undefined;
  let blocker: InputBlocker | undefined;
  function syncBlock(): void {
    clearTimeout(handBackTimer);
    handBackTimer = undefined;
    const blocked = destroyed ? null : snapshot?.blocked ?? null;
    const live = blocked !== null && (blocked.until === undefined || now() < blocked.until);
    const mark = markElement();
    if (live && blockOption !== false) mark?.setAttribute("data-cowork-blocked", blocked.mode);
    else mark?.removeAttribute("data-cowork-blocked");
    // Re-read the state at the hand-back, so the banner and the attribute clear on time.
    if (blocked?.until !== undefined && !destroyed) {
      handBackTimer = setTimeout(changed, Math.max(0, blocked.until - now()));
    }
  }

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

  const warnRefusal = createRefusalWarner();
  const report = (refusal: CoworkRefusal) => {
    if (!options.onRefused) {
      warnRefusal(refusal);
      return;
    }
    try { options.onRefused(refusal); } catch { /* A host callback cannot break the session. */ }
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

  /** The last presence refusal reported, per kind: a lossy frame is never retried, and a
   *  run of identical refusals (10 Hz of 429s) is reported once, until one gets through. */
  const presenceRefused = new Map<string, string>();
  const refusePresence = (kind: string, decision: Decision): void => {
    if (decision.allow || presenceRefused.get(kind) === decision.reason) return;
    presenceRefused.set(kind, decision.reason);
    report({ reason: decision.reason, status: decision.status, from: self, kind, stage: "sender" });
  };
  /**
   * A presence intent through the server (`presenceRouting: "server"`): the same
   * pipeline at the sender, then the intent endpoint, which stamps the sender. Not
   * serialised itself; callers are already inside `serial`.
   */
  const sendPresence = async (intent: Extract<Intent, { kind: "cursor" | "activity" }>): Promise<void> => {
    if (destroyed) return;
    const envelope: Envelope = { id: newId() };
    const result = await evaluateIntent(host(), state, { from: self, envelope, intent, now: now() });
    if (!result.decision.allow) return refusePresence(intent.kind, result.decision);
    const sent = await send({ t: "intent", envelope, intent });
    if (!sent.allow) return refusePresence(intent.kind, sent);
    presenceRefused.delete(intent.kind);
    commit(result);
  };

  /** What a followed peer's visit or scroll just made this page do, so its echo is not re-sent. */
  const followEcho = { route: null as string | null, visitUntil: 0, scrollUntil: 0 };
  const followEchoMs = Math.max(0, options.followEchoMs ?? 1000);

  /** One send, run inside `serial`. Callers go through {@link sendIntent}. */
  const runSend = async (intent: Intent, sendOptions: SendOptions = {}, internal = false): Promise<Decision> => {
      const isView = VIEW_KINDS.has(intent.kind);
      const view = sendOptions.view ?? (isView || intent.kind === "control" ? self : undefined);
      // The host reporting what following just did to this page: allowed, not sent.
      if (!internal && view === self && now() < followEcho.visitUntil && intent.kind === "visit" && routeOf(intent.url) === followEcho.route) {
        return ALLOW_DECISION;
      }
      if (!internal && view === self && now() < followEcho.scrollUntil && intent.kind === "scroll") return ALLOW_DECISION;
      // Not a navigation: this page is already on that route (a query or hash change, or
      // the same URL reported again). Sending it would bump the revision, and a host that
      // reports from an effect keyed on the snapshot would then report again, forever:
      // a visit storm that starves every field report queued behind it (MOIC, 0.64.0).
      if (intent.kind === "visit" && view === self && sendOptions.to === undefined && routeOf(intent.url) === state.participants[self]?.route) {
        return ALLOW_DECISION;
      }
      const local = (reason: string, status = 403): Decision => {
        const decision = refuse(reason, status);
        report({ reason, status, from: self, kind: intent.kind, stage: "sender" });
        return decision;
      };

      // Shared fields: the person's own edit is the newest, so a value waiting for
      // blur is dropped; and the echo of a value this browser just APPLIED from a
      // peer (the host reports every input event, including that one) is not sent
      // back, or two editors would ping-pong it forever.
      if (intent.kind === "field" && view === self) {
        waitingShared.delete(intent.handle);
        const applied = appliedShared.get(intent.handle);
        appliedShared.delete(intent.handle);
        if (applied !== undefined && applied === stableJson(intent.value)) return ALLOW_DECISION;
        // Not an edit: the server already holds this value for the field. Sending it
        // again (a textarea's blur `change` repeats the last `input`) would only
        // restart a lower rank's hold on the other side.
        if (acceptedField.get(intent.handle) === stableJson(intent.value)) return ALLOW_DECISION;
      }

      // Masking happens HERE, before the pipeline and before the wire: a masked
      // value must never be in a frame, refused or not.
      if (intent.kind === "field" || intent.kind === "click" || intent.kind === "submit") {
        const config = resolvedConfig();
        const reason = (intent.kind === "field" ? configRefusal(intent.handle, config) : null) ?? domRefusal(intent);
        if (reason) {
          if (intent.kind === "field" && view === self) {
            activeFields.set(self, intent.handle);
            if (presenceRouting === "server") await sendPresence({ kind: "activity", handle: intent.handle, active: true });
            else await send({ t: "activity", view: self, handle: intent.handle, active: true });
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
      let sent = await send({ t: "intent", envelope, intent });
      let committed = result;
      // Stale on this page's OWN view: the server committed a revision of it this browser
      // missed (a lost answer, a relay it never heard). The report describes the page as
      // it is now, so only the counter is behind: re-sync, take the server's revision and
      // send it again, once. A drive into another view is never retried: that page moved.
      if (!sent.allow && sent.reason === REASONS.stale && view === self && isView && transport.sync) {
        await resyncNow();
        const rebased: Envelope = { ...envelope, id: newId(), revision: state.participants[self]?.revision ?? 0 };
        const again = await evaluateIntent(host(), state, { from: self, envelope: rebased, intent, now: now() });
        if (!again.decision.allow) {
          report({ reason: again.decision.reason, status: again.decision.status, from: self, kind: intent.kind, stage: "sender" });
          return again.decision;
        }
        sent = await send({ t: "intent", envelope: rebased, intent });
        committed = again;
      }
      if (!sent.allow) {
        report({ reason: sent.reason, status: sent.status, from: self, kind: intent.kind, stage: "sender" });
        return sent;
      }
      commit(committed);
      if (intent.kind === "field" && view === self) acceptedField.set(intent.handle, stableJson(intent.value));
      return committed.decision;
  };

  // Coalescing (approved lab test 87, run 762): on a slow server every keystroke was
  // its own serial POST, so a burst drained for many seconds and a final value waited
  // behind stale ones. While a report waits in the queue, a newer one for the same
  // slot REPLACES it and shares its promise, so the queued job sends the latest value.
  const coalesceKey = (intent: Intent, sendOptions: SendOptions): string | null => {
    if (sendOptions.to !== undefined) return null;
    const view = sendOptions.view ?? self;
    if (intent.kind === "field") return `field|${view}|${intent.handle}`;
    if (intent.kind === "scroll") return `scroll|${view}`;
    // Where the page is NOW is all a visit reports: a newer one replaces a queued one.
    if (intent.kind === "visit") return `visit|${view}`;
    return null;
  };
  const queuedSends = new Map<string, { intent: Intent; options: SendOptions; internal: boolean; done: Promise<Decision> }>();

  // Re-send after a hold: a field report refused because the person was held (409
  // with blockedUntil) or rate-limited (429) is sent again, as the LATEST value for
  // that field, once the hold or the window ends. A newer report replaces it.
  const heldFields = new Map<string, { intent: Intent; options: SendOptions; timer: ReturnType<typeof setTimeout> }>();
  const afterSend = (intent: Intent, sendOptions: SendOptions, decision: Decision): void => {
    if (intent.kind !== "field" || sendOptions.to !== undefined || (sendOptions.view ?? self) !== self) return;
    const key = intent.handle;
    const pending = heldFields.get(key);
    if (pending) clearTimeout(pending.timer);
    heldFields.delete(key);
    if (decision.allow || destroyed) return;
    const blockedUntil = (decision as { blockedUntil?: unknown }).blockedUntil;
    const wait = decision.reason === "cowork.denied.control" && typeof blockedUntil === "number"
      ? Math.max(0, blockedUntil - now()) + 50
      : decision.status === 429 || decision.reason === "cowork.denied.rate" ? 1_000 : null;
    if (wait === null) return;
    const entry = {
      intent,
      options: sendOptions,
      timer: setTimeout(() => {
        if (heldFields.get(key) !== entry || destroyed) return;
        heldFields.delete(key);
        void sendIntent(entry.intent, entry.options);
      }, wait),
    };
    heldFields.set(key, entry);
  };

  const sendIntent = (intent: Intent, sendOptions: SendOptions = {}, internal = false): Promise<Decision> => {
    const key = coalesceKey(intent, sendOptions);
    if (key === null) return serial(() => runSend(intent, sendOptions, internal));
    const waiting = queuedSends.get(key);
    if (waiting) {
      waiting.intent = intent;
      waiting.options = sendOptions;
      waiting.internal = internal;
      return waiting.done;
    }
    const entry = { intent, options: sendOptions, internal, done: Promise.resolve<Decision>(ALLOW_DECISION) };
    queuedSends.set(key, entry);
    entry.done = serial(async () => {
      if (queuedSends.get(key) === entry) queuedSends.delete(key);
      const decision = await runSend(entry.intent, entry.options, entry.internal);
      afterSend(entry.intent, entry.options, decision);
      return decision;
    });
    return entry.done;
  };

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

  /**
   * Perform an intent on THIS browser's page: a drive into the owner's own view, a
   * followed leader's navigation, or a shared field from a peer on the same route.
   */
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
    // Server routing: the server identified the sender and already ran the whole
    // pipeline; this browser's view of the session can be stale (a peer it has not
    // heard of yet, a route it missed), so re-running the policy here only drops
    // good intents. Commit it (route, revision, ranked `last`, so blocking and the
    // banner work) and keep only the page-side guards in applyToPage. Direct routing
    // has no server in between and keeps the full receiver pipeline.
    const evaluator = transport.routing === "server" ? trustedHost() : host();
    const result = await evaluateIntent(evaluator, state, { from, envelope, intent, now: now() });
    if (!result.decision.allow) {
      report({ reason: result.decision.reason, status: result.decision.status, from, kind: String((intent as { kind?: unknown }).kind), stage: "receiver" });
      return;
    }
    const me = state.participants[self];
    const followed = me?.follows === from;
    commit(result);
    const view = envelope.view;

    // Server-routed presence: the same effect as the whispered frame, but the
    // sender is the one the SERVER stamped, so no socket stamp is needed.
    if (intent.kind === "cursor") {
      cursors.set(from, {
        route: intent.route,
        cursor: intent.anchor !== undefined ? { anchor: intent.anchor, fx: intent.fx!, fy: intent.fy! } : { x: intent.x!, y: intent.y! },
      });
      changed();
      return;
    }
    if (intent.kind === "activity") {
      activeFields.set(from, intent.active ? intent.handle : null);
      changed();
      return;
    }

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
    if (view === from && from !== self && intent.kind === "field" && sharesField(intent.handle) && onSameRoute(from)) {
      // A peer on this same page edited a shared document field: last writer wins,
      // except over a field the person is typing in, which waits for their blur.
      // A person who is held cannot type, so there is nothing of theirs to protect.
      if (isFocused(intent.handle) && !isBlockedNow()) {
        waitingShared.set(intent.handle, { from, intent });
        return;
      }
      await applyShared(from, intent);
      return;
    }
    if (view === from && followed && (intent.kind === "visit" || intent.kind === "scroll")) {
      // Following: mirror the leader's navigation onto this page, then say where we are now.
      if (intent.kind === "visit") {
        if (routeOf(intent.url) === state.participants[self]?.route) return;
        followEcho.route = routeOf(intent.url);
        followEcho.visitUntil = now() + followEchoMs;
        await applyToPage(from, intent);
        // This page's own report of where it now is: the one that must go out.
        void sendIntentLater({ kind: "visit", url: intent.url }, true);
      } else {
        followEcho.scrollUntil = now() + followEchoMs;
        await applyToPage(from, intent);
      }
    }
  };

  // -------------------------------------------------------------------------
  // Shared document fields (opt-in per page)
  // -------------------------------------------------------------------------

  const sharesField = (handle: string): boolean => (options.sharedFields ?? []).some((glob) => globMatch(glob, handle));
  const onSameRoute = (ref: Ref): boolean => {
    const them = state.participants[ref];
    const me = state.participants[self];
    return !!them && !!me && them.route === me.route;
  };
  const isFocused = (handle: string): boolean => {
    const el = elementFor(handle);
    return !!el && el.ownerDocument?.activeElement === el;
  };
  /** Apply through the same DOM masking and guard as a drive; remember it so its echo is not re-sent. */
  async function applyShared(from: Ref, intent: Extract<Intent, { kind: "field" }>): Promise<void> {
    appliedShared.set(intent.handle, stableJson(intent.value));
    acceptedField.set(intent.handle, stableJson(intent.value));
    await applyToPage(from, intent);
  }
  const onFocusOut = (event: Event) => {
    const target = event.target as Element | null;
    for (const [handle, waiting] of [...waitingShared]) {
      if (elementFor(handle) !== target) continue;
      waitingShared.delete(handle);
      void serial(async () => {
        if (destroyed || !onSameRoute(waiting.from)) return;
        await applyShared(waiting.from, waiting.intent);
      });
    }
  };
  const focusScope = root() as unknown as EventTarget | null;
  focusScope?.addEventListener("focusout", onFocusOut);

  /** Queue a report behind the current work rather than inside it. */
  const sendIntentLater = (intent: Intent, internal = false) => Promise.resolve().then(() => sendIntent(intent, {}, internal));

  const helloFrame = (): CoworkFrame => {
    const me = state.participants[self];
    return { t: "hello", route: me?.route ?? "/", revision: me?.revision ?? 0, follows: me?.follows ?? null };
  };

  const receive = (message: ReceivedFrame) =>
    serial(async () => {
      if (destroyed) return;
      const from = message.from;
      const frame = readFrame(message.frame);
      if (!frame || from === self) return;
      if (!state.participants[from]) {
        // A server-relayed intent from a peer this browser has not heard of (a missed
        // presence event): the server vouched for it, so learn the peer and re-sync.
        if (transport.routing !== "server" || frame.t !== "intent" || !isValidRef(from)) return;
        const next = structuredClone(state);
        next.participants[from] = { ref: from, route: "/", revision: 0, follows: null, joinedAt: now() };
        state = next;
        await resyncNow();
        if (!state.participants[from]) return;
      }
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
            if (transport.routing !== "server") await send(helloFrame()); // Sockudo refuses client events (4301); the re-sync carries this
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
        presenceKnown = true;
        presentRefs.clear();
        for (const p of event.peers) presentRefs.add(p.ref);
      } else if (event.type === "joining") presentRefs.add(event.peer.ref);
      else presentRefs.delete(event.peer.ref);
      if (event.type === "here") {
        const present = new Set(event.peers.map((p) => p.ref));
        for (const peer of event.peers) add(peer);
        for (const ref of Object.keys(state.participants)) if (!present.has(ref)) await drop(ref);
        // Say where this browser is; everyone who has not heard from it answers in kind.
        if (transport.routing !== "server") await send(helloFrame()); // Sockudo refuses client events (4301); the re-sync carries this
      } else if (event.type === "joining") add(event.peer);
      else await drop(event.peer.ref);
      // The server knows routes, revisions and follows a presence event does not carry.
      if (event.type !== "leaving") await resyncNow();
      changed();
    });

  // -------------------------------------------------------------------------
  // Re-sync from the server (server routing)
  // -------------------------------------------------------------------------

  /** A host that accepts what the server already accepted: validation and the commit only. */
  function trustedHost(): EngineHost {
    return { identity: true, config: resolvedConfig() ?? resolveConfig({}), members: () => true, authorize: () => true, middleware: [] };
  }

  /** Merge the server's view: it lists who joined and where. Never call from outside `serial`. */
  async function mergeSync(sync: CoworkSyncState): Promise<void> {
    const listed = new Set(sync.participants.map((p) => p.ref));
    const next = structuredClone(state);
    for (const p of sync.participants) {
      if (!isValidRef(p.ref)) continue;
      if (p.label !== undefined) labels.set(p.ref, p.label);
      if (p.online !== undefined) syncOnline.set(p.ref, p.online);
      const local = next.participants[p.ref];
      if (!local) {
        next.participants[p.ref] = {
          ref: p.ref,
          ...(p.label !== undefined ? { label: p.label } : {}),
          ...(p.actingFor !== undefined ? { actingFor: p.actingFor } : {}),
          route: routeOf(p.route),
          revision: p.revision,
          follows: p.follows,
          joinedAt: now(),
        };
      } else if (p.revision >= local.revision) {
        // The server's route wins unless this browser has seen a newer revision; that
        // includes this browser's own route when the host never reported the first page.
        local.route = routeOf(p.route);
        local.revision = p.revision;
        local.follows = p.follows;
      }
    }
    for (const [view, control] of Object.entries(sync.control?.views ?? {})) {
      if (next.participants[view]) next.control[view] = { holder: control.holder, requests: [...control.requests] };
    }
    state = next;
    for (const ref of Object.keys(state.participants)) {
      if (ref === self || listed.has(ref)) continue;
      const result = await evaluateLeave(host(), state, { from: ref, now: now() });
      if (result.decision.allow) state = result.state;
      cursors.delete(ref);
      activeFields.delete(ref);
    }
  }

  /** Re-sync inside the current serial task. */
  async function resyncNow(): Promise<void> {
    if (!transport.sync || destroyed) return;
    const sync = await transport.sync();
    if (!sync || destroyed) return;
    await mergeSync(sync);
    changed();
  }

  const offFrame = transport.onFrame((message) => void receive(message));
  const offPresence = transport.onPresence((event) => void onPresence(event));
  // At start, not only on an acknowledgement: laravel-echo never repeats a `here` that
  // fired before this transport attached (the channel is usually joined first).
  void serial(resyncNow);
  const heartbeatTimer = transport.heartbeat
    ? setInterval(() => { if (!destroyed) void transport.heartbeat!(); }, Math.max(1000, options.heartbeatMs ?? 30_000))
    : undefined;

  // -------------------------------------------------------------------------
  // Cursors (lossy, throttled, never intents)
  // -------------------------------------------------------------------------

  let lastCursorAt = -Infinity;
  let pendingCursor: CoworkCursor | null = null;
  let cursorTimer: ReturnType<typeof setTimeout> | undefined;
  let queuedCursor: ({ route: string } & CoworkCursor) | null = null;
  const flushCursor = () => {
    cursorTimer = undefined;
    if (!pendingCursor || destroyed) return;
    const cursor = pendingCursor;
    pendingCursor = null;
    lastCursorAt = Date.now();
    const route = state.participants[self]?.route ?? "/";
    if (presenceRouting === "server") {
      // Coalesced: while a cursor send waits in the queue, a newer position replaces it.
      // A job that finds a newer position already sent does nothing, so a slow send
      // never queues stale positions behind it.
      queuedCursor = { route, ...cursor };
      void serial(async () => {
        const latest = queuedCursor;
        queuedCursor = null;
        if (latest) await sendPresence({ kind: "cursor", ...latest });
      });
    }
    else void send({ t: "cursor", route, ...cursor });
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
    // Never the internal flag: only the session itself re-reports a followed visit.
    sendIntent: (intent, sendOptions) => sendIntent(intent, sendOptions),
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
      for (const held of heldFields.values()) clearTimeout(held.timer);
      heldFields.clear();
      queuedSends.clear();
      clearInterval(heartbeatTimer);
      blocker?.destroy();
      syncBlock();
      focusScope?.removeEventListener("focusout", onFocusOut);
      waitingShared.clear();
      appliedShared.clear();
      offFrame();
      offPresence();
      transport.close();
      listeners.clear();
    },
  };
  if (blockOption !== false) {
    const extra = typeof blockOption === "object" ? blockOption : {};
    const target = blockTarget();
    if (target) {
      blocker = createInputBlocker({
        target,
        isBlocked: isBlockedNow,
        ...(extra.isUserEvent ? { isUserEvent: extra.isUserEvent } : {}),
        ...(extra.onBlocked ? { onBlocked: extra.onBlocked } : {}),
      });
    }
  }
  return session;
}
