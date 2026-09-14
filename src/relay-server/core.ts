import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RelayBroker — pure logic for the SSE+POST tunnel described in
 * docs/relay-protocol.md, hostable in any Node-compatible runtime
 * (Node, Bun, Deno-with-Node-compat, Cloudflare Workers via the Web
 * standards subset). No HTTP framework opinions; this class just
 * stores sessions, validates tokens, enqueues frames, and produces
 * SSE event payloads ready to flush.
 *
 *   const broker = new RelayBroker();
 *   const reg     = broker.register("session-id", "token");      // ok / error
 *   broker.inbox("session-id", "token", '{"jsonrpc":"2.0",…}');  // enqueue inbound
 *   const sub = broker.subscribe("session-id", "token", "inbound");
 *   for await (const payload of sub.frames()) yield encodeSse(payload);
 *
 * Storage is an in-memory Map by default — fine for a single relay
 * process. To run multiple instances behind a load balancer, swap
 * `MemoryStore` for a Redis-backed equivalent (same Store interface).
 */

export type Direction = "inbound" | "outbound";

export type Session = {
  id: string;
  /** SHA-256 hex of the original token. Compared with timing-safe equals. */
  tokenHash: string;
  /** Last touched (ms since epoch). Used for TTL cleanup. */
  lastSeen: number;
};

export type Subscriber = {
  id: string;
  direction: Direction;
  queue: string[];
  resolveNext: ((frame: string | null) => void) | null;
  /**
   * The caller-supplied client label, when one was given.
   *
   * Used to route a RESPONSE back to whoever asked. Without it the broker
   * cannot tell two holders of one bearer token apart, and every reply goes to
   * every subscriber -- so a second token holder passively receives the results
   * of everyone else's tool calls without making one.
   */
  client?: string;
  /**
   * Present only for a LONG-POLL subscriber, which outlives any one request:
   * it is read by a series of `GET /poll` calls rather than one open stream,
   * so it needs its own liveness record.
   */
  poll?: {
    /** Last time a poll started or finished (ms since epoch). */
    lastSeen: number;
    /** Polls currently parked on this subscriber. Never pruned while > 0. */
    parked: number;
    /** Wake every parked poll — a frame landed, or the session ended. */
    wakers: Set<() => void>;
  };
  /** Set once the subscriber has been ended (unsubscribed, pruned, or its session is gone). */
  ended?: boolean;
};

export type RelayBrokerOptions = {
  /** Sessions auto-expire after this many ms of inactivity. Default 4h. */
  ttlMs?: number;
  /** Cleanup tick interval in ms. Default 60 000. */
  reapIntervalMs?: number;
  /**
   * A long-poll subscriber that has not polled for this long is dropped (and,
   * for an outbound one, the page is told the peer left). Checked on the reap
   * tick. Default 60 000 — the PHP relay's window, and comfortably longer than
   * the 25 s maximum park, so a healthy poller is never pruned between polls.
   */
  pollIdleMs?: number;
  /** Bring-your-own storage layer (redis, etc.). Defaults to in-memory. */
  store?: Store;
};

export interface Store {
  putSession(s: Session): void;
  getSession(id: string): Session | undefined;
  deleteSession(id: string): void;
  /** Used by the reap tick — return ids whose lastSeen < cutoff. */
  expiredSessionIds(cutoff: number): string[];
}

class MemoryStore implements Store {
  private sessions = new Map<string, Session>();
  putSession(s: Session) { this.sessions.set(s.id, s); }
  getSession(id: string) { return this.sessions.get(id); }
  deleteSession(id: string) { this.sessions.delete(id); }
  expiredSessionIds(cutoff: number) {
    const out: string[] = [];
    for (const [id, s] of this.sessions) if (s.lastSeen < cutoff) out.push(id);
    return out;
  }
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

/** The subscriber ids this broker hands out — and the only shape a poll may echo back. */
const SUBSCRIBER_ID_PATTERN = /^[a-f0-9]{16}$/;

export class RelayBroker {
  private readonly ttlMs: number;
  private readonly pollIdleMs: number;
  private readonly store: Store;
  /** Per-session, per-direction subscriber list. */
  private subs: Map<string, Map<string, Map<string, Subscriber>>> = new Map();

  /** Per-session map of JSON-RPC request id -> the client that asked. */
  private callers: Map<string, Map<string, string>> = new Map();
  private reaper?: ReturnType<typeof setInterval>;

  constructor(opts: RelayBrokerOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 4 * 60 * 60 * 1000; // 4h
    this.pollIdleMs = opts.pollIdleMs ?? 60_000;
    this.store = opts.store ?? new MemoryStore();
    const tick = opts.reapIntervalMs ?? 60_000;
    if (tick > 0) {
      this.reaper = setInterval(() => this.reap(), tick);
      // Don't keep the process alive just for the reaper.
      if (typeof (this.reaper as { unref?: () => void }).unref === "function") {
        (this.reaper as { unref: () => void }).unref();
      }
    }
  }

  dispose() {
    if (this.reaper) clearInterval(this.reaper);
    for (const id of [...this.subs.keys()]) this.endSubscribers(id);
    this.subs.clear();
    this.callers.clear();
  }

  /** Register a session id + token. Idempotent — same id+token re-registers,
   *  different token fails. */
  register(id: string, token: string): { ok: true } | { ok: false; reason: string } {
    if (!SESSION_ID_PATTERN.test(id)) return { ok: false, reason: "invalid_session_id" };
    if (typeof token !== "string" || token.length < 16 || token.length > 128) {
      return { ok: false, reason: "invalid_token" };
    }
    const existing = this.store.getSession(id);
    const hash = sha256Hex(token);
    if (existing) {
      if (!timingSafeEqualHex(existing.tokenHash, hash)) return { ok: false, reason: "session_taken" };
      existing.lastSeen = Date.now();
      this.store.putSession(existing);
      return { ok: true };
    }
    this.store.putSession({ id, tokenHash: hash, lastSeen: Date.now() });
    return { ok: true };
  }

  unregister(id: string, token: string): boolean {
    if (!this.validate(id, token)) return false;
    this.store.deleteSession(id);
    this.endSubscribers(id);
    this.subs.delete(id);
    this.callers.delete(id);
    return true;
  }

  /**
   * Validate an authenticated touch, saying WHY when it fails.
   *
   * `session_gone` and `invalid_token` are different facts and a client acts on
   * them differently. A gone session means the page has closed or the TTL has
   * elapsed — the NORMAL end of a relay lifecycle, since the browser is the
   * server and no state persists across restarts. A bad token means the caller
   * is wrong.
   *
   * They were collapsed into one boolean and reported as `invalid_token`, so an
   * agent holding a perfectly good token against a closed page was told its
   * credentials were wrong. Not a missing signal — an actively misleading one,
   * which sends the reader to debug an auth path that was never the problem.
   *
   * Missing credentials stay `invalid_token`: a request that never named a
   * session has not discovered a dead one.
   *
   * The reason is deliberately NOT widened to cover a wrong token on a live
   * session — answering `session_gone` there would tell an unauthenticated
   * caller which sessions exist.
   *
   * Requested by the Prism harness while designing a non-Node relay client.
   */
  check(id: string, token: string): { ok: true } | { ok: false; reason: "invalid_token" | "session_gone" } {
    if (!id || !token) return { ok: false, reason: "invalid_token" };

    const s = this.store.getSession(id);
    if (!s) return { ok: false, reason: "session_gone" };

    if (!timingSafeEqualHex(s.tokenHash, sha256Hex(token))) {
      return { ok: false, reason: "invalid_token" };
    }

    s.lastSeen = Date.now();
    this.store.putSession(s);
    return { ok: true };
  }

  /**
   * Validate an authenticated touch and slide the TTL forward.
   *
   * Kept as-is for existing callers; `check()` is the one that says why.
   */
  validate(id: string, token: string): boolean {
    return this.check(id, token).ok;
  }

  /** Drop a session — the page closed, or a test needs it gone. */
  dropSession(id: string): void {
    this.store.deleteSession(id);
    this.endSubscribers(id);
    this.subs.delete(id);
    this.callers.delete(id);
  }

  /** Push a frame onto the inbound queue (external agent → browser). */
  inbox(id: string, token: string, payload: string, opts: { client?: string } = {}): boolean {
    if (!this.validate(id, token)) return false;
    if (!this.isFrame(payload)) return false;

    // Remember WHO asked, so the reply can go back to them alone.
    if (opts.client !== undefined) {
      this.rememberCaller(id, payload, opts.client);
    }

    this.fanOut(id, "inbound", payload);
    return true;
  }

  /** Push a frame onto the outbound queue (browser server → external agents). */
  outbox(id: string, token: string, payload: string): boolean {
    if (!this.validate(id, token)) return false;
    if (!this.isFrame(payload)) return false;

    // A RESPONSE goes to the caller. A NOTIFICATION goes to everyone.
    //
    // `relay-protocol.md` has always said "tool-call replies go back on the
    // transport that originated the call"; the relay broadcast them instead.
    // Combined with a bearer token that carries no per-agent identity, that
    // meant a second token holder passively received the results of everyone
    // else's calls -- turning a share link from "you may act here" into "you
    // may watch everyone acting here", which nobody chose.
    //
    // Notifications stay broadcast: presence, activity and server-pushed state
    // answer nobody and are meant for every attached client. Narrowing those
    // would break the collaboration this exists to serve.
    const target = this.callerFor(id, payload);

    if (target === null) {
      this.fanOut(id, "outbound", payload);
      return true;
    }

    this.fanOutTo(id, "outbound", payload, target);
    return true;
  }

  /**
   * Subscribe to a session's queue for one direction. Returns an iterable
   * the caller (an HTTP handler) pumps as SSE.
   */
  subscribe(id: string, token: string, direction: Direction, opts: { client?: string } = {}): SubscribeResult {
    // check(), not validate(): a stream re-attaching to an ended session must be
    // told the session is GONE, not that its token is wrong.
    const auth = this.check(id, token);
    if (!auth.ok) return auth;

    const subscriberId = randomBytes(8).toString("hex");
    const subscriber: Subscriber = {
      id: subscriberId,
      direction,
      queue: [],
      resolveNext: null,
      client: opts.client,
    };
    this.getDirSubs(id, direction).set(subscriberId, subscriber);
    if (direction === "outbound") this.announcePeer(id, "notifications/peer_joined", subscriberId);

    /** Async generator the HTTP handler drains. Yields raw frame payloads;
     *  the handler is responsible for SSE framing (`event: mcp
data: …`). */
    const frames = async function* (this: Subscriber): AsyncGenerator<string, void, void> {
      while (true) {
        if (this.queue.length > 0) {
          const next = this.queue.shift();
          if (next !== undefined) yield next;
          continue;
        }
        // Checked before parking, not only on wake: a subscriber ended while
        // the generator was busy yielding has nobody left to wake it.
        if (this.ended) return;
        const next = await new Promise<string | null>((resolve) => {
          this.resolveNext = resolve;
        });
        this.resolveNext = null;
        if (next === null) return;
        yield next;
      }
    }.bind(subscriber);

    return {
      ok: true,
      subscriberId,
      frames: frames(),
      unsubscribe: () => {
        // Wake the generator and let it return cleanly.
        this.endSubscriber(subscriber);
        this.removeSubscriber(id, subscriber);
      },
    };
  }

  /**
   * Attach a LONG-POLL subscriber, or re-attach the one a previous poll created.
   *
   * The CDN-safe receive leg: a series of short requests instead of one open
   * stream, because Cloudflare's HTTP/3 edge resets long-lived SSE. Same
   * contract as the PHP relay in px-ui-sandbox and the one
   * `@particle-academy/fancy-cf-relay` and `mcp-relay-client` speak:
   *
   * - The first poll gets a fresh 16-hex subscriber id; the client echoes it back
   *   as `subscriber` on every later poll and reads the same queue.
   * - An id in that shape that this session does not know (pruned, say) is
   *   adopted as a NEW subscriber under that id, as the PHP relay does, so a
   *   client that went quiet and came back keeps its identity.
   * - An id belonging to a STREAMING subscriber is never adopted: one queue read
   *   by two consumers splits its frames between them.
   *
   * Frames queue on the subscriber between polls, so nothing is lost in the gap
   * between one request ending and the next arriving. A poller that stops is
   * pruned after `pollIdleMs`.
   */
  poll(
    id: string,
    token: string,
    direction: Direction,
    opts: { subscriber?: string; client?: string } = {},
  ): PollResult {
    const auth = this.check(id, token);
    if (!auth.ok) return auth;

    const dir = this.getDirSubs(id, direction);
    const requested = opts.subscriber && SUBSCRIBER_ID_PATTERN.test(opts.subscriber) ? opts.subscriber : undefined;
    const existing = requested ? dir.get(requested) : undefined;

    let subscriber: Subscriber;
    let created: boolean;
    if (existing?.poll) {
      subscriber = existing;
      created = false;
    } else {
      const subscriberId = requested && !existing ? requested : randomBytes(8).toString("hex");
      subscriber = {
        id: subscriberId,
        direction,
        queue: [],
        resolveNext: null,
        client: opts.client,
        poll: { lastSeen: Date.now(), parked: 0, wakers: new Set() },
      };
      dir.set(subscriberId, subscriber);
      created = true;
      if (direction === "outbound") this.announcePeer(id, "notifications/peer_joined", subscriberId);
    }

    const state = subscriber.poll!;
    state.lastSeen = Date.now();

    return {
      ok: true,
      subscriberId: subscriber.id,
      created,
      wait: async (ms: number, signal?: AbortSignal): Promise<string[]> => {
        state.parked++;
        state.lastSeen = Date.now();
        try {
          if (subscriber.queue.length === 0 && ms > 0 && !subscriber.ended && !signal?.aborted) {
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", done);
                state.wakers.delete(done);
                resolve();
              };
              const timer = setTimeout(done, ms);
              state.wakers.add(done);
              signal?.addEventListener("abort", done, { once: true });
            });
          }
          // An aborted poll takes NOTHING: its response will never be read, and
          // a frame handed to it would be a frame nobody receives.
          if (signal?.aborted) return [];
          return subscriber.queue.splice(0);
        } finally {
          state.parked--;
          state.lastSeen = Date.now();
        }
      },
      requeue: (frames: string[]) => {
        if (frames.length > 0 && !subscriber.ended) subscriber.queue.unshift(...frames);
      },
    };
  }

  // ────────────────────────────────────────────────────────────── internals

  private getDirSubs(sessionId: string, direction: Direction): Map<string, Subscriber> {
    let bySession = this.subs.get(sessionId);
    if (!bySession) {
      bySession = new Map();
      this.subs.set(sessionId, bySession);
    }
    let byDir = bySession.get(direction);
    if (!byDir) {
      byDir = new Map();
      bySession.set(direction, byDir);
    }
    return byDir;
  }

  /**
   * Record which client asked, keyed by JSON-RPC id.
   *
   * Only for REQUESTS — a frame with both an `id` and a `method`. A
   * notification answers nobody and a response is not a question.
   */
  private rememberCaller(sessionId: string, payload: string, client: string): void {
    const frame = this.parseFrame(payload);
    if (!frame || frame.id === undefined || frame.id === null || typeof frame.method !== "string") {
      return;
    }

    let byId = this.callers.get(sessionId);
    if (!byId) {
      byId = new Map();
      this.callers.set(sessionId, byId);
    }

    // BOUNDED. A session that asks for hours must not grow this without limit,
    // and an unanswered request would otherwise sit here forever. Oldest out
    // first; losing the oldest correlation degrades to "delivered to nobody",
    // which fails closed rather than open.
    if (byId.size >= 1000) {
      const oldest = byId.keys().next();
      if (!oldest.done) byId.delete(oldest.value);
    }

    byId.set(String(frame.id), client);
  }

  /**
   * The client a RESPONSE belongs to, or `null` when the frame is a broadcast.
   *
   * Returns the empty string for a response whose id nobody is recorded as
   * having asked — routed to NOBODY rather than to everyone. Broadcasting an
   * uncorrelated reply "just in case" is precisely the leak being closed.
   */
  private callerFor(sessionId: string, payload: string): string | null {
    const frame = this.parseFrame(payload);

    // Not a response: no id, or it carries a method (a request/notification).
    if (!frame || frame.id === undefined || frame.id === null || typeof frame.method === "string") {
      return null;
    }

    // LEGACY MODE is decided by whether any subscriber IDENTIFIED ITSELF, not
    // by whether a correlation happens to have been recorded yet.
    //
    // Keying on the correlation map was wrong in a way a test caught: a
    // labelled client that has subscribed but not yet asked leaves the map
    // empty, and an unsolicited response would then broadcast to everyone --
    // the leak reopening in the window before the first call.
    //
    // If nobody labelled themselves, every client is legacy and broadcast is
    // the only thing that can work; narrowing would break them in silence.
    if (!this.anyIdentifiedSubscriber(sessionId)) {
      return null;
    }

    const byId = this.callers.get(sessionId);
    const key = String(frame.id);
    const client = byId?.get(key);

    // CONSUMED. Correlation is not a standing subscription: leaving it would
    // let a replayed frame with the same id be delivered again, and would make
    // the map a slow leak on a long session.
    byId?.delete(key);

    return client ?? "";
  }

  /**
   * Has any subscriber on this session told the broker who it is?
   *
   * The discriminator between a scoped session and a legacy one. Checked across
   * BOTH directions: the page subscribes inbound and rarely labels itself, so
   * asking only about the outbound side would misread a scoped session whose
   * agents have not yet attached.
   */
  private anyIdentifiedSubscriber(sessionId: string): boolean {
    const dirs = this.subs.get(sessionId);
    if (!dirs) return false;

    for (const dir of dirs.values()) {
      for (const sub of dir.values()) {
        if (sub.client !== undefined) return true;
      }
    }

    return false;
  }

  private parseFrame(payload: string): { id?: unknown; method?: unknown } | null {
    try {
      const parsed: unknown = JSON.parse(payload);
      return parsed && typeof parsed === "object" ? (parsed as { id?: unknown; method?: unknown }) : null;
    } catch {
      return null;
    }
  }

  /** Deliver to the subscribers of one client only. */
  private fanOutTo(sessionId: string, direction: Direction, payload: string, client: string) {
    const dir = this.subs.get(sessionId)?.get(direction);
    if (!dir) return;

    for (const sub of dir.values()) {
      if (sub.client !== client) continue;
      this.deliver(sub, payload);
    }
  }

  private fanOut(sessionId: string, direction: Direction, payload: string) {
    const dir = this.subs.get(sessionId)?.get(direction);
    if (!dir) return;
    for (const sub of dir.values()) this.deliver(sub, payload);
  }

  /**
   * Hand one frame to one subscriber.
   *
   * The resolver is CLEARED before it is called. It used to stay set until the
   * generator resumed on a later microtask, so a second frame in the same tick
   * called an already-settled resolver — a no-op — after shifting its frame out
   * of the queue, and that frame was lost. Cleared first, the second frame just
   * waits in the queue for the generator to come back for it.
   */
  private deliver(sub: Subscriber, payload: string) {
    if (sub.ended) return;
    sub.queue.push(payload);

    const resolve = sub.resolveNext;
    if (resolve) {
      sub.resolveNext = null;
      resolve(sub.queue.shift() ?? null);
      return;
    }

    if (sub.poll) for (const wake of [...sub.poll.wakers]) wake();
  }

  /** Tell the page (the inbound side) that an agent arrived or left. */
  private announcePeer(sessionId: string, method: "notifications/peer_joined" | "notifications/peer_left", subscriberId: string) {
    this.fanOut(sessionId, "inbound", JSON.stringify({ jsonrpc: "2.0", method, params: { subscriberId, ts: Date.now() } }));
  }

  /** End one subscriber: close its stream, or release its parked polls. Idempotent. */
  private endSubscriber(sub: Subscriber) {
    if (sub.ended) return;
    sub.ended = true;

    const resolve = sub.resolveNext;
    sub.resolveNext = null;
    resolve?.(null);

    if (sub.poll) for (const wake of [...sub.poll.wakers]) wake();
  }

  /**
   * End every subscriber of a session whose session is going away.
   *
   * Streams used to be dropped from the map WITHOUT being woken, so an SSE leg
   * stayed open, heartbeating, for a session that no longer existed — and its
   * client could not learn the page had closed. Ended, the stream closes, the
   * client reconnects, and `events` answers 410.
   */
  private endSubscribers(sessionId: string) {
    const dirs = this.subs.get(sessionId);
    if (!dirs) return;
    for (const dir of dirs.values()) for (const sub of dir.values()) this.endSubscriber(sub);
  }

  /** Remove a subscriber from its session, announcing an agent's departure once. */
  private removeSubscriber(sessionId: string, sub: Subscriber) {
    const dir = this.subs.get(sessionId)?.get(sub.direction);
    // Look it up rather than recreating the maps: a session that has already
    // been dropped must not grow an empty entry back, nor announce to nobody.
    if (!dir || dir.get(sub.id) !== sub) return;
    dir.delete(sub.id);
    if (sub.direction === "outbound") this.announcePeer(sessionId, "notifications/peer_left", sub.id);
  }

  /** Drop long-poll subscribers that stopped polling. Never one with a poll parked. */
  private prunePollers(now: number) {
    for (const [sessionId, dirs] of this.subs) {
      for (const dir of dirs.values()) {
        for (const sub of [...dir.values()]) {
          if (!sub.poll || sub.poll.parked > 0) continue;
          if (now - sub.poll.lastSeen <= this.pollIdleMs) continue;
          this.endSubscriber(sub);
          this.removeSubscriber(sessionId, sub);
        }
      }
    }
  }

  /**
   * Validate that a peer-supplied payload is a well-formed JSON-RPC 2.0 frame
   * (or batch) before it is fanned out. Previously this was a substring match on
   * `"jsonrpc"`, which let any token holder inject spoofed frames — a forged
   * `notifications/peer_joined` / `peer_left` (broker-reserved presence control),
   * a fake `notifications/agent_activity {source:"user"}` ("human took control"),
   * or a forged response with a matching id. We now parse + shape-check, and
   * reject the broker-reserved control methods (the broker emits those itself,
   * never a peer).
   */
  private isFrame(payload: string): boolean {
    if (payload.length === 0) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return false;
    }
    const frames = Array.isArray(parsed) ? parsed : [parsed];
    return frames.length > 0 && frames.every((f) => this.isValidFrame(f));
  }

  private isValidFrame(f: unknown): boolean {
    if (!f || typeof f !== "object" || Array.isArray(f)) return false;
    const o = f as Record<string, unknown>;
    if (o.jsonrpc !== "2.0") return false;
    const method = typeof o.method === "string" ? o.method : undefined;
    // Broker-reserved control frames may never arrive from a peer.
    if (method === "notifications/peer_joined" || method === "notifications/peer_left") return false;
    if (method !== undefined) return true; // request or notification
    // Response: needs an id and exactly one of result / error.
    const hasResult = "result" in o;
    const hasError = "error" in o;
    return "id" in o && hasResult !== hasError;
  }

  private reap() {
    const now = Date.now();
    const cutoff = now - this.ttlMs;
    for (const id of this.store.expiredSessionIds(cutoff)) {
      this.endSubscribers(id);
      this.subs.delete(id);
      this.callers.delete(id);
      this.store.deleteSession(id);
    }
    this.prunePollers(now);
  }
}

export type PollResult =
  | { ok: false; reason: "invalid_token" | "session_gone" }
  | {
      ok: true;
      /** The id the client must echo back as `subscriber` on its next poll. */
      subscriberId: string;
      /** Whether this poll created the subscriber (and, outbound, announced it). */
      created: boolean;
      /**
       * Park up to `ms` for frames, then take everything queued. Returns at once
       * when frames are already waiting, when `ms` is 0, or when the session
       * ends. An aborted `signal` returns `[]` and takes nothing.
       */
      wait: (ms: number, signal?: AbortSignal) => Promise<string[]>;
      /** Put frames back at the head of the queue — a response that could not be written. */
      requeue: (frames: string[]) => void;
    };

export type SubscribeResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      subscriberId: string;
      frames: AsyncGenerator<string, void, void>;
      unsubscribe: () => void;
    };

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
