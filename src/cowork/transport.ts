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
  /**
   * Hand a frame to the transport. Resolves to the SERVER's decision for an
   * intent in server routing; otherwise `{ allow: true }` once handed off, or
   * a refusal when the transport is closed or failed.
   */
  send(frame: CoworkFrame): Promise<Decision>;
  onFrame(listener: (message: ReceivedFrame) => void): () => void;
  onPresence(listener: (event: PresenceEvent) => void): () => void;
  close(): void;
}

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

  const onRelayed = (payload: unknown) => {
    if (!pipe.isOpen() || !isRecord(payload)) return;
    const { from, intent, ...envelope } = payload;
    if (!isRef(from) || from === options.self) return;
    const frame = readFrame({ t: "intent", envelope, intent });
    if (frame) pipe.frames.emit({ from, frame });
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
    async send(frame) {
      if (!pipe.isOpen()) return CLOSED;
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
    close() {
      options.channel.stopListening?.(".cowork.intent", onRelayed);
      pipe.close();
    },
  };
}
