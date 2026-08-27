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
};

export type RelayBrokerOptions = {
  /** Sessions auto-expire after this many ms of inactivity. Default 4h. */
  ttlMs?: number;
  /** Cleanup tick interval in ms. Default 60 000. */
  reapIntervalMs?: number;
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

export class RelayBroker {
  private readonly ttlMs: number;
  private readonly store: Store;
  /** Per-session, per-direction subscriber list. */
  private subs: Map<string, Map<string, Map<string, Subscriber>>> = new Map();
  private reaper?: ReturnType<typeof setInterval>;

  constructor(opts: RelayBrokerOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 4 * 60 * 60 * 1000; // 4h
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
    this.subs.clear();
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
    this.subs.delete(id);
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
    this.subs.delete(id);
  }

  /** Push a frame onto the inbound queue (external agent → browser). */
  inbox(id: string, token: string, payload: string): boolean {
    if (!this.validate(id, token)) return false;
    if (!this.isFrame(payload)) return false;
    this.fanOut(id, "inbound", payload);
    return true;
  }

  /** Push a frame onto the outbound queue (browser server → external agents). */
  outbox(id: string, token: string, payload: string): boolean {
    if (!this.validate(id, token)) return false;
    if (!this.isFrame(payload)) return false;
    this.fanOut(id, "outbound", payload);
    return true;
  }

  /**
   * Subscribe to a session's queue for one direction. Returns an iterable
   * the caller (an HTTP handler) pumps as SSE.
   */
  subscribe(id: string, token: string, direction: Direction): SubscribeResult {
    if (!this.validate(id, token)) return { ok: false, reason: "invalid_token" };
    const subscriberId = randomBytes(8).toString("hex");
    const subscriber: Subscriber = { id: subscriberId, direction, queue: [], resolveNext: null };
    this.getDirSubs(id, direction).set(subscriberId, subscriber);

    // Notify the inbound side (= browser) that an outbound subscriber
    // (= external agent) just connected.
    if (direction === "outbound") {
      this.fanOut(
        id,
        "inbound",
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/peer_joined",
          params: { subscriberId, ts: Date.now() },
        }),
      );
    }

    const unsubscribe = () => {
      this.getDirSubs(id, direction).delete(subscriberId);
      if (direction === "outbound") {
        this.fanOut(
          id,
          "inbound",
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/peer_left",
            params: { subscriberId, ts: Date.now() },
          }),
        );
      }
    };

    /** Async generator the HTTP handler drains. Yields raw frame payloads;
     *  the handler is responsible for SSE framing (`event: mcp\ndata: …`). */
    const frames = async function* (this: Subscriber): AsyncGenerator<string, void, void> {
      while (true) {
        if (this.queue.length > 0) {
          const next = this.queue.shift();
          if (next !== undefined) yield next;
          continue;
        }
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
        subscriber.resolveNext?.(null);
        unsubscribe();
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

  private fanOut(sessionId: string, direction: Direction, payload: string) {
    const dir = this.subs.get(sessionId)?.get(direction);
    if (!dir) return;
    for (const sub of dir.values()) {
      sub.queue.push(payload);
      sub.resolveNext?.(sub.queue.shift() ?? null);
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
    const cutoff = Date.now() - this.ttlMs;
    for (const id of this.store.expiredSessionIds(cutoff)) {
      const dirs = this.subs.get(id);
      if (dirs) {
        for (const dir of dirs.values()) {
          for (const sub of dir.values()) sub.resolveNext?.(null);
        }
      }
      this.subs.delete(id);
      this.store.deleteSession(id);
    }
  }
}

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
