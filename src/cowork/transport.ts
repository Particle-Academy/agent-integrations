/**
 * The `PeerTransport` seam for co-work sessions: how frames travel between
 * peers. Three ship here, and no other transport is planned (a Pusher-protocol
 * socket server, e.g. Genie's WebSockets service, is the only network transport;
 * WebRTC would need third-party approval):
 *
 * - {@link createMemoryTransport}: an in-process hub, for tests and demos.
 * - {@link createWhisperTransport}: `direct` routing over a presence channel's
 *   client events. The server never sees an intent, so every receiver runs the
 *   pipeline again.
 * - {@link createServerTransport}: `server` routing. Intents are POSTed to the
 *   host's co-work endpoint, which runs the pipeline and relays them on the
 *   presence channel; lossy frames (cursors, field activity) stay whispers.
 *
 * **A frame's sender is never read from the frame.** Each transport stamps it
 * from something the peer cannot choose: the hub's own endpoint, the userId the
 * socket server stamps on a presence whisper, or the `from` the co-work server
 * wrote after identifying the request.
 */
import type { Decision, Envelope, Intent, Ref, Routing } from "./types";
import { isValidRef } from "./engine";

/** Everything that crosses the wire. Intents are the only frames that change session state. */
export type CoworkFrame =
  | { t: "intent"; envelope: Envelope; intent: Intent }
  /** A cursor: an anchor handle + fractions inside its rect, or document coordinates as a fallback. */
  | { t: "cursor"; route: string; anchor?: string; fx?: number; fy?: number; x?: number; y?: number }
  /** A field is being edited. Sent INSTEAD of a masked field's value, which never leaves the browser. */
  | { t: "activity"; view: Ref; handle: string; active: boolean }
  /** A peer announcing its own view when someone arrives. */
  | { t: "hello"; route: string; revision: number; follows: Ref | null }
  | { t: "follow"; target: Ref | null };

export type ReceivedFrame = { from: Ref; frame: CoworkFrame };
export type PeerInfo = { ref: Ref; label?: string; attributes?: Record<string, unknown> };
export type PresenceEvent =
  | { type: "here"; peers: PeerInfo[] }
  | { type: "joining"; peer: PeerInfo }
  | { type: "leaving"; peer: PeerInfo };

export interface PeerTransport {
  readonly routing: Routing;
  /** Whom this transport treats as its own sender (a server transport's `self`). */
  readonly self?: Ref;
  /**
   * The channel object it listens on (a server transport's `channel`). useCoworkSession
   * restarts its session when this changes: a re-joined channel is a new object.
   */
  readonly channel?: unknown;
  /**
   * Hand a frame to the transport. Resolves to the SERVER's decision for an
   * intent in server routing; otherwise `{ allow: true }` once handed off, or
   * a refusal when the transport is closed or failed.
   */
  send(frame: CoworkFrame): Promise<Decision>;
  onFrame(listener: (message: ReceivedFrame) => void): () => void;
  onPresence(listener: (event: PresenceEvent) => void): () => void;
  close(): void;
  /**
   * Server routing only: the session as the server holds it (`GET /cowork/sessions/{id}`).
   * The session re-syncs from it when it starts, on every presence acknowledgement and
   * member join, and on a relayed intent from a peer it has not heard of.
   */
  sync?(): Promise<CoworkSyncState | null>;
  /** Server routing only: tell the server this participant is still here. */
  heartbeat?(): Promise<Decision>;
}

/** One participant as the server's re-sync describes it. */
export type CoworkSyncParticipant = {
  ref: Ref;
  label?: string;
  actingFor?: Ref;
  route: string;
  revision: number;
  follows: Ref | null;
  /** The server's live-presence view, when it reports one. */
  online?: boolean;
  /** Ranked control: this participant's effective rank, as the SERVER computes it. */
  rank?: number;
};

/** The server's view of a session, for re-sync. */
export type CoworkSyncState = {
  participants: CoworkSyncParticipant[];
  control?: {
    mode?: string;
    /** Ranked control, as the server applies it. */
    scope?: "view" | "session";
    idleMs?: number;
    views?: Record<Ref, { holder: Ref; requests: Ref[] }>;
  };
};

/**
 * The slice of a presence channel the whisper and server transports use. The
 * names are laravel-echo's, and `@particle-academy/fancy-query/socket`
 * implements them. A whisper listener must receive the server-stamped
 * `userId`: without it a frame cannot be attributed, and is dropped.
 */
export interface PresenceChannelLike {
  here(callback: (members: unknown[]) => void): unknown;
  joining(callback: (member: unknown) => void): unknown;
  leaving(callback: (member: unknown) => void): unknown;
  whisper(event: string, data: unknown): unknown;
  listenForWhisper(event: string, callback: (data: unknown, meta?: { userId?: string }) => void): unknown;
  stopListeningForWhisper?(event: string, callback?: (data: unknown, meta?: { userId?: string }) => void): unknown;
  listen?(event: string, callback: (payload: unknown) => void): unknown;
  stopListening?(event: string, callback?: (payload: unknown) => void): unknown;
}

const ALLOW: Decision = { allow: true };
const CLOSED: Decision = { allow: false, reason: "cowork.transport.closed", status: 0 };
const FAILED: Decision = { allow: false, reason: "cowork.transport.failed", status: 0 };
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
// The engine's ref rule, so a reserved name (__proto__, constructor, prototype) never
// reaches the session's state maps from a frame or a presence member.
const isRef = isValidRef;
const isHandle = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 256 && !CONTROL_CHARS.test(v);
const isFraction = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isCoord = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e7;
const isRoute = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 2048 && !CONTROL_CHARS.test(v);

/**
 * Structural check of a frame from the wire. Intents are only checked for
 * shape here; the engine validates their contents. Unknown keys are dropped,
 * so a frame's claimed `from` never travels further than this function.
 */
export function readFrame(value: unknown): CoworkFrame | null {
  if (!isRecord(value) || typeof value.t !== "string") return null;
  switch (value.t) {
    case "intent":
      if (!isRecord(value.envelope) || !isRecord(value.intent)) return null;
      return { t: "intent", envelope: stripFrom(value.envelope) as Envelope, intent: value.intent as Intent };
    case "cursor": {
      if (!isRoute(value.route)) return null;
      const anchored = value.anchor !== undefined;
      if (anchored && !(isHandle(value.anchor) && isFraction(value.fx) && isFraction(value.fy))) return null;
      if (!anchored && !(isCoord(value.x) && isCoord(value.y))) return null;
      return anchored
        ? { t: "cursor", route: value.route, anchor: value.anchor as string, fx: value.fx as number, fy: value.fy as number }
        : { t: "cursor", route: value.route, x: value.x as number, y: value.y as number };
    }
    case "activity":
      if (!isRef(value.view) || !isHandle(value.handle) || typeof value.active !== "boolean") return null;
      return { t: "activity", view: value.view, handle: value.handle, active: value.active };
    case "hello":
      if (!isRoute(value.route) || typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 0) return null;
      if (value.follows !== null && !isRef(value.follows)) return null;
      return { t: "hello", route: value.route, revision: value.revision, follows: value.follows as Ref | null };
    case "follow":
      if (value.target !== null && !isRef(value.target)) return null;
      return { t: "follow", target: value.target as Ref | null };
    default:
      return null;
  }
}

/**
 * Read a `GET /cowork/sessions/{id}` body (`{ session: {...} }` or the session itself).
 * Anything malformed is dropped, never trusted: the result only ever adds or updates
 * participants the server lists.
 */
export function readSync(json: unknown): CoworkSyncState | null {
  const body = isRecord(json) && isRecord(json.session) ? json.session : json;
  if (!isRecord(body) || !Array.isArray(body.participants)) return null;
  const participants: CoworkSyncParticipant[] = [];
  for (const p of body.participants) {
    if (!isRecord(p) || !isRef(p.ref) || !isRoute(p.route)) continue;
    const revision = typeof p.revision === "number" && Number.isInteger(p.revision) && p.revision >= 0 ? p.revision : 0;
    participants.push({
      ref: p.ref,
      ...(typeof p.label === "string" ? { label: p.label } : {}),
      ...(isRef(p.actingFor) ? { actingFor: p.actingFor } : {}),
      route: p.route,
      revision,
      follows: isRef(p.follows) ? p.follows : null,
      ...(typeof p.online === "boolean" ? { online: p.online } : {}),
      ...(typeof p.rank === "number" && Number.isFinite(p.rank) ? { rank: p.rank } : {}),
    });
  }
  const control = isRecord(body.control) ? body.control : null;
  const views: Record<Ref, { holder: Ref; requests: Ref[] }> = Object.create(null);
  if (control && isRecord(control.views)) {
    for (const [view, value] of Object.entries(control.views)) {
      if (isRef(view) && isRecord(value) && isRef(value.holder)) {
        views[view] = { holder: value.holder, requests: Array.isArray(value.requests) ? value.requests.filter(isRef) : [] };
      }
    }
  }
  const scope = control && (control.scope === "view" || control.scope === "session") ? control.scope : undefined;
  const idleMs = control && typeof control.idleMs === "number" && Number.isFinite(control.idleMs) && control.idleMs >= 0 ? control.idleMs : undefined;
  return {
    participants,
    control: {
      ...(control && typeof control.mode === "string" ? { mode: control.mode } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(idleMs !== undefined ? { idleMs } : {}),
      views,
    },
  };
}

function stripFrom(envelope: Record<string, unknown>): Record<string, unknown> {
  const { from: _ignored, ...rest } = envelope;
  return rest;
}

/** A presence member's info as a peer. The server's channel auth wrote it; only `ref`/`id`, `label` and `attributes` are kept. */
export function peerFromMember(member: unknown): PeerInfo | null {
  if (!isRecord(member)) return null;
  const ref = isRef(member.ref) ? member.ref : isRef(member.id) ? member.id : typeof member.id === "number" ? String(member.id) : null;
  if (ref === null) return null;
  return {
    ref,
    ...(typeof member.label === "string" ? { label: member.label } : {}),
    ...(isRecord(member.attributes) ? { attributes: member.attributes } : {}),
  };
}

class Listeners<T> {
  private set = new Set<(value: T) => void>();
  add(listener: (value: T) => void): () => void {
    this.set.add(listener);
    return () => this.set.delete(listener);
  }
  emit(value: T): void {
    for (const listener of [...this.set]) {
      try { listener(value); } catch { /* A listener cannot break delivery to the others. */ }
    }
  }
  clear(): void { this.set.clear(); }
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export type MemoryHub = {
  /** A new endpoint, as `peer`. The hub stamps every frame it sends with `peer.ref`. */
  connect(peer: PeerInfo, options?: { routing?: Routing }): PeerTransport;
  /** Every frame that crossed the hub, in order: the wire, for assertions. */
  wire: ReceivedFrame[];
  peers(): PeerInfo[];
};

/** An in-process hub. Delivery is synchronous and in order; frames sent while delivering are queued. */
export function createMemoryTransport(): MemoryHub {
  type Endpoint = { peer: PeerInfo; frames: Listeners<ReceivedFrame>; presence: Listeners<PresenceEvent>; open: boolean };
  const endpoints: Endpoint[] = [];
  const wire: ReceivedFrame[] = [];
  const queue: Array<() => void> = [];
  let flushing = false;
  const run = (job: () => void) => {
    queue.push(job);
    if (flushing) return;
    flushing = true;
    try { while (queue.length) queue.shift()!(); } finally { flushing = false; }
  };
  const peerList = () => endpoints.map((e) => ({ ...e.peer }));

  return {
    wire,
    peers: peerList,
    connect(peer, options = {}) {
      const endpoint: Endpoint = { peer: { ...peer }, frames: new Listeners(), presence: new Listeners(), open: true };
      endpoints.push(endpoint);
      const others = () => endpoints.filter((e) => e !== endpoint && e.open);
      run(() => { for (const e of others()) e.presence.emit({ type: "joining", peer: { ...endpoint.peer } }); });
      return {
        routing: options.routing ?? "direct",
        async send(frame) {
          if (!endpoint.open) return CLOSED;
          const message: ReceivedFrame = { from: endpoint.peer.ref, frame: structuredClone(frame) };
          wire.push(message);
          run(() => { for (const e of others()) e.frames.emit(structuredClone(message)); });
          return ALLOW;
        },
        onFrame: (listener) => endpoint.frames.add(listener),
        onPresence(listener) {
          const off = endpoint.presence.add(listener);
          // Like a presence channel's `here`: the current members, at once.
          run(() => { if (endpoint.open) listener({ type: "here", peers: peerList() }); });
          return off;
        },
        close() {
          if (!endpoint.open) return;
          endpoint.open = false;
          endpoints.splice(endpoints.indexOf(endpoint), 1);
          endpoint.frames.clear();
          endpoint.presence.clear();
          run(() => { for (const e of others()) e.presence.emit({ type: "leaving", peer: { ...endpoint.peer } }); });
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Presence-channel plumbing shared by the whisper and server transports
// ---------------------------------------------------------------------------

const WHISPER_VERSION = 1;

type ChannelPlumbing = {
  frames: Listeners<ReceivedFrame>;
  onPresence(listener: (event: PresenceEvent) => void): () => void;
  whisper(frame: CoworkFrame): Decision;
  close(): void;
  isOpen(): boolean;
};

function plumb(channel: PresenceChannelLike, self: Ref, event: string, accept: (frame: CoworkFrame) => boolean): ChannelPlumbing {
  const frames = new Listeners<ReceivedFrame>();
  const presence = new Listeners<PresenceEvent>();
  const members = new Map<Ref, PeerInfo>();
  let open = true;
  let latest: PeerInfo[] | null = null;

  channel.here((list) => {
    if (!open) return;
    members.clear();
    for (const peer of (Array.isArray(list) ? list : []).map(peerFromMember)) if (peer) members.set(peer.ref, peer);
    latest = [...members.values()];
    presence.emit({ type: "here", peers: latest });
  });
  channel.joining((member) => {
    const peer = peerFromMember(member);
    if (!open || !peer) return;
    members.set(peer.ref, peer);
    latest = [...members.values()];
    presence.emit({ type: "joining", peer });
  });
  channel.leaving((member) => {
    const peer = peerFromMember(member);
    if (!open || !peer) return;
    members.delete(peer.ref);
    latest = [...members.values()];
    presence.emit({ type: "leaving", peer });
  });

  const onWhisper = (data: unknown, meta?: { userId?: string }) => {
    if (!open || !isRecord(data) || data.v !== WHISPER_VERSION) return;
    // The SERVER stamps userId on a presence whisper. No stamp, or a sender who
    // is not a current member, and the frame cannot be attributed: drop it.
    const from = meta?.userId;
    if (!isRef(from) || from === self || !members.has(from)) return;
    const frame = readFrame(data.frame);
    if (!frame || !accept(frame)) return;
    frames.emit({ from, frame });
  };
  channel.listenForWhisper(event, onWhisper);

  return {
    frames,
    onPresence(listener) {
      const off = presence.add(listener);
      // A late subscriber still learns who is here, as a presence channel's `here` does.
      if (latest) listener({ type: "here", peers: latest });
      return off;
    },
    whisper(frame) {
      if (!open) return CLOSED;
      try {
        channel.whisper(event, { v: WHISPER_VERSION, frame });
        return ALLOW;
      } catch {
        return FAILED;
      }
    },
    close() {
      if (!open) return;
      open = false;
      channel.stopListeningForWhisper?.(event, onWhisper);
      frames.clear();
      presence.clear();
    },
    isOpen: () => open,
  };
}

// ---------------------------------------------------------------------------
// Whisper (direct routing)
// ---------------------------------------------------------------------------

export type WhisperTransportOptions = {
  /** The joined presence channel, e.g. `echo.join("cowork.session.<id>")`. Client events must be enabled on the server. */
  channel: PresenceChannelLike;
  /** This browser's own ref, as the channel auth reported it. */
  self: Ref;
  /** The whisper event name. Default `cowork`. */
  event?: string;
};

export function createWhisperTransport(options: WhisperTransportOptions): PeerTransport {
  const pipe = plumb(options.channel, options.self, options.event ?? "cowork", () => true);
  return {
    routing: "direct",
    send: async (frame) => pipe.whisper(frame),
    onFrame: (listener) => pipe.frames.add(listener),
    onPresence: (listener) => pipe.onPresence(listener),
    close: () => pipe.close(),
  };
}

// ---------------------------------------------------------------------------
// Server routing
// ---------------------------------------------------------------------------

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ServerTransportOptions = {
  sessionId: string;
  /** Prefix in front of `/cowork/sessions/...`. Default "" (same origin). */
  endpoint?: string;
  /**
   * The host's fetch. It owns authentication, CSRF and cookies; the package
   * adds only the JSON body. Required: nothing is sent with an ambient fetch.
   */
  fetch: FetchLike;
  /** The joined presence channel the server relays intents on. */
  channel: PresenceChannelLike;
  self: Ref;
  /** The socket id, so the server can relay to everyone but this connection. */
  socketId?: () => string | undefined;
  event?: string;
};

export function createServerTransport(options: ServerTransportOptions): PeerTransport {
  // Over the presence channel only lossy frames are accepted from peers. An
  // intent counts only when the SERVER relays it, under its own identification.
  const pipe = plumb(options.channel, options.self, options.event ?? "cowork", (frame) => frame.t !== "intent");
  const base = `${options.endpoint ?? ""}/cowork/sessions/${encodeURIComponent(options.sessionId)}`;

  // Every relayed intent this drops is warned once per reason: a drop here happens
  // before the session sees anything, so without it a page that applies nothing logs
  // nothing either (MOIC, 0.65.0).
  const warned = new Set<string>();
  const drop = (key: string, message: string) => {
    if (warned.has(key) || typeof console === "undefined") return;
    warned.add(key);
    console.warn(`[cowork] ${message} This warning is shown once.`);
  };
  const onRelayed = (payload: unknown) => {
    if (!pipe.isOpen()) {
      drop("closed", "A relayed intent was dropped: its server connection is closed (the session was destroyed). A new session needs a new transport.");
      return;
    }
    if (!isRecord(payload)) {
      drop("payload", `A relayed intent was dropped: its payload is not an object (got ${typeof payload}). Check the broadcaster sends the event data once-encoded.`);
      return;
    }
    const { from, intent, ...envelope } = payload;
    if (!isRef(from)) {
      drop("from", "A relayed intent was dropped: it names no sender (`from`).");
      return;
    }
    if (from === options.self) {
      // Usually this page's own intent coming back (no socket exclusion): expected.
      drop("own", `Relayed intents from ${from} are ignored as this page's own. If this page is not ${from}, the \`self\` its server connection was built with is wrong.`);
      return;
    }
    const frame = readFrame({ t: "intent", envelope, intent });
    if (!frame) {
      drop("intent", `A relayed intent from ${from} was dropped: it carries no intent object.`);
      return;
    }
    pipe.frames.emit({ from, frame });
  };

  // A laravel-echo channel that was left, re-joined (a new pusher channel object under the
  // same name) or whose client was disconnected (a second Echo replaced it) keeps nothing
  // bound here: relayed intents stop arriving while every POST still works. Measured with
  // laravel-echo 2.6.3 + pusher-js 8.6.0; a plain reconnect keeps the binding. Duck-typed:
  // a channel without those internals (fancy-query's own client) is never judged.
  const staleReason = (): string | null => {
    const c = options.channel as unknown as { name?: unknown; subscription?: unknown; pusher?: { channel?: (n: string) => unknown; connection?: { state?: unknown } } };
    if (!c || typeof c.name !== "string" || c.subscription === undefined || !c.pusher || typeof c.pusher.channel !== "function") return null;
    if (c.pusher.connection?.state === "disconnected") return "its client is disconnected";
    try {
      if (c.pusher.channel(c.name) !== c.subscription) return "it was left or re-joined";
    } catch {
      return null;
    }
    return null;
  };
  const checkLive = () => {
    const why = staleReason();
    if (why === null) return;
    const name = (options.channel as unknown as { name: string }).name;
    drop("stale-channel", `The presence channel ${name} this transport listens on is no longer the live subscription (${why}): relayed intents no longer arrive here. Create a new transport on the channel the page now uses; useCoworkSession restarts on it.`);
  };
  options.channel.listen?.(".cowork.intent", onRelayed);

  const post = async (path: string, body: Record<string, unknown>): Promise<Decision> => {
    let response: Response;
    try {
      response = await options.fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      return FAILED;
    }
    if (response.ok) return ALLOW;
    let reason = "cowork.transport.refused";
    let blockedUntil: number | undefined;
    try {
      const json = (await response.json()) as unknown;
      if (isRecord(json) && typeof json.reason === "string") reason = json.reason;
      if (isRecord(json) && typeof json.blockedUntil === "number") blockedUntil = json.blockedUntil;
    } catch { /* A body that is not JSON keeps the generic reason. */ }
    return { allow: false, reason, status: response.status, ...(blockedUntil !== undefined ? { blockedUntil } : {}) };
  };

  return {
    routing: "server",
    self: options.self,
    channel: options.channel,
    async send(frame) {
      if (!pipe.isOpen()) return CLOSED;
      checkLive();
      if (frame.t === "intent") {
        const socketId = options.socketId?.();
        return post("/intents", {
          intent: frame.intent,
          ...(frame.envelope.view !== undefined ? { view: frame.envelope.view } : {}),
          ...(frame.envelope.revision !== undefined ? { revision: frame.envelope.revision } : {}),
          ...(frame.envelope.to !== undefined ? { to: frame.envelope.to } : {}),
          ...(frame.envelope.id !== undefined ? { id: frame.envelope.id } : {}),
          ...(socketId !== undefined ? { socketId } : {}),
        });
      }
      if (frame.t === "follow") {
        const decision = await post("/follow", { target: frame.target });
        if (!decision.allow) return decision;
      }
      return pipe.whisper(frame);
    },
    onFrame: (listener) => pipe.frames.add(listener),
    onPresence: (listener) => pipe.onPresence(listener),
    async sync() {
      if (!pipe.isOpen()) return null;
      try {
        const response = await options.fetch(base, { method: "GET", headers: { Accept: "application/json" } });
        if (!response.ok) return null;
        return readSync(await response.json());
      } catch {
        return null;
      }
    },
    heartbeat: () => {
      if (!pipe.isOpen()) return Promise.resolve(CLOSED);
      checkLive();
      return post("/heartbeat", {});
    },
    close() {
      options.channel.stopListening?.(".cowork.intent", onRelayed);
      pipe.close();
    },
  };
}
