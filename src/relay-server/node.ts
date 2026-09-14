import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { RelayBroker, type RelayBrokerOptions } from "./core";
import { allowOriginFor, parseCorsOrigins, type CorsPolicy } from "./cors";

/**
 * Node HTTP adapter for {@link RelayBroker}. Returns a single request
 * handler plus per-route handlers, so you can either drop it into
 * `http.createServer(...)` directly or mount the individual handlers
 * onto your existing Node HTTP framework (Express, Hono w/ node-adapter,
 * native http).
 *
 *   const relay = createNodeRelay({ pathPrefix: "/mcp-relay" });
 *   http.createServer(relay.handler).listen(8787);
 *
 *   // Or piecemeal:
 *   app.post("/mcp-relay/register",       relay.register);
 *   app.post("/mcp-relay/:s/inbox",       relay.inbox);
 *   app.post("/mcp-relay/:s/outbox",      relay.outbox);
 *   app.get ("/mcp-relay/:s/events",      relay.events);
 *   app.get ("/mcp-relay/:s/poll",        relay.poll);
 *   app.post("/mcp-relay/:s/unregister",  relay.unregister);
 */

/** Longest a single poll may park, in ms — the PHP relay's cap, kept identical. */
export const POLL_MAX_WAIT_MS = 25_000;

/** Park window when a poll names none, in ms — fancy-cf-relay's default. */
export const POLL_DEFAULT_WAIT_MS = 20_000;

/**
 * The park window a poll asked for, clamped to 0..{@link POLL_MAX_WAIT_MS}.
 *
 * Absent means the default; present but not a number means 0, which is what
 * the PHP relay's integer cast makes of it — a malformed hint returns at once
 * rather than parking for a length nobody chose.
 */
export function pollWaitMs(raw: string | null | undefined): number {
  if (raw === null || raw === undefined) return POLL_DEFAULT_WAIT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), POLL_MAX_WAIT_MS);
}

export type NodeRelayOptions = RelayBrokerOptions & {
  /** URL path prefix (without trailing slash). Default `""` — handlers
   *  expect paths like `/register`, `/{id}/inbox`, etc. directly. */
  pathPrefix?: string;
  /**
   * Browser origins allowed to read relay responses: `*`, or a comma-separated
   * list of origins (`"https://example.com,https://www.example.com"`).
   * Default `*` — relays are typically called cross-origin from the demo host.
   *
   * A list is enforced per request: a listed `Origin` is echoed back as
   * `Access-Control-Allow-Origin` with `Vary: Origin`, and an unlisted one
   * gets no allow-origin header at all. `*` mixed into a list, an empty value,
   * `null` or an entry with a path throws here, at construction.
   */
  corsAllowOrigin?: string;
  /**
   * The same allow-list as an array. When non-empty it takes precedence over
   * `corsAllowOrigin`. Recommended for any browser-facing deployment: it blunts
   * DNS rebinding and hostile cross-origin pages reading relay responses. When
   * neither names origins, `*` is used and the session token is the only auth
   * — pair that with a loopback bind.
   */
  allowedOrigins?: string[];
};

export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => unknown | Promise<unknown>;

export type NodeRelay = {
  broker: RelayBroker;
  /** Single-handler shape — routes internally based on method + URL. */
  handler: NodeHandler;
  /** Per-route handlers. Each handler ignores the URL prefix and
   *  acts on the path remainder, so you can mount them under any
   *  prefix in your existing app. */
  register: NodeHandler;
  inbox: NodeHandler;
  outbox: NodeHandler;
  events: NodeHandler;
  /** Long-poll receive leg — the CDN-safe alternative to `events`. */
  poll: NodeHandler;
  unregister: NodeHandler;
};

export function createNodeRelay(opts: NodeRelayOptions = {}): NodeRelay {
  const broker = new RelayBroker(opts);
  const prefix = (opts.pathPrefix ?? "").replace(/\/$/, "");
  // Parsed once, here, so a bad policy fails at startup rather than in a browser.
  const cors: CorsPolicy =
    opts.allowedOrigins && opts.allowedOrigins.length > 0
      ? parseCorsOrigins(opts.allowedOrigins)
      : parseCorsOrigins(opts.corsAllowOrigin ?? "*");

  function setCorsHeaders(res: ServerResponse, req?: IncomingMessage) {
    if (cors.kind === "list") {
      // The answer depends on who asked, so say so to every cache in between —
      // including on a refusal, or a cached refusal could be served to a listed
      // origin.
      res.setHeader("vary", "Origin");
    }
    const origin = req?.headers.origin;
    const allow = allowOriginFor(cors, typeof origin === "string" ? origin : undefined);
    // No header at all for an unlisted origin. Not `null`: sandboxed iframes and
    // file:// pages send `Origin: null`, so that value would admit exactly them.
    if (allow !== null) res.setHeader("access-control-allow-origin", allow);
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    // `authorization` is forward-compat for a header-borne session token.
    res.setHeader("access-control-allow-headers", "content-type, x-csrf-token, accept, authorization");
    res.setHeader("access-control-max-age", "86400");
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      req.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        // Cap individual frames at 256 KB — protect against runaway payloads.
        if (bytes > 256 * 1024) {
          reject(new Error("payload_too_large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }

  function getQuery(req: IncomingMessage): URLSearchParams {
    const host = req.headers.host || "x";
    const u = new URL(req.url || "/", `http://${host}`);
    return u.searchParams;
  }

  function getPathname(req: IncomingMessage): string {
    const host = req.headers.host || "x";
    const u = new URL(req.url || "/", `http://${host}`);
    return u.pathname;
  }

  const register: NodeHandler = async (req, res) => {
    setCorsHeaders(res, req);
    if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
    if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
    let body: string;
    try { body = await readBody(req); } catch (e) {
      return json(res, 413, { error: e instanceof Error ? e.message : "payload_error" });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: "invalid_json" }); }
    const { session, token } = (parsed ?? {}) as { session?: string; token?: string };
    if (typeof session !== "string" || typeof token !== "string") {
      return json(res, 400, { error: "missing_fields" });
    }
    const result = broker.register(session, token);
    if (!result.ok) return json(res, 401, { error: result.reason });
    return json(res, 200, { ok: true });
  };

  /** Handler for endpoints with a `{session}` segment. The path matcher
   *  caller passes the session id explicitly so this works mounted under
   *  any route shape. */
  function makeSessionHandler(
    direction: Direction | "unregister",
  ): NodeHandler {
    return async (req, res) => {
      setCorsHeaders(res, req);
      if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
      if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
      const session = extractSession(req, prefix);
      if (!session) return json(res, 400, { error: "missing_session" });
      const token = getQuery(req).get("token") ?? "";

      if (direction === "unregister") {
        // Unregistering a session that is already gone is a SUCCESS, not an
        // auth failure. The caller wanted it gone and it is gone; reporting
        // `invalid_token` for a correct token would make a clean shutdown look
        // like a broken one, and a client retrying it would loop.
        const state = broker.check(session, token);
        if (!state.ok && state.reason === "session_gone") {
          return json(res, 200, { ok: true, alreadyGone: true });
        }

        const ok = broker.unregister(session, token);
        return json(res, ok ? 200 : 401, ok ? { ok: true } : { error: "invalid_token" });
      }

      let body: string;
      try { body = await readBody(req); } catch (e) {
        return json(res, 413, { error: e instanceof Error ? e.message : "payload_error" });
      }
      // A GONE SESSION IS REPORTED AS ITSELF, with 410, before the frame is
      // even considered.
      //
      // Every failure here used to come back as `401 invalid_token_or_frame`,
      // so an agent whose page had simply closed was told its credentials or
      // its JSON were wrong. A relay session ending is the NORMAL end of a
      // lifecycle -- the browser is the server and nothing persists -- so it is
      // the one outcome a server-side client must be able to recognise.
      //
      // 410 Gone rather than 404: the session existed and is now over, which is
      // exactly what the status means, and it distinguishes "this is finished"
      // from "you have the wrong URL".
      const auth = broker.check(session, token);
      if (!auth.ok && auth.reason === "session_gone") {
        return json(res, 410, { error: "session_gone" });
      }

      // `client` identifies WHICH agent is calling, so its reply can be routed
      // back to it alone. Optional: a client that sends none gets the legacy
      // broadcast, which is the only thing that can work for it.
      const client = getQuery(req).get("client") ?? undefined;

      const ok = direction === "inbound"
        ? broker.inbox(session, token, body, { client })
        : broker.outbox(session, token, body);
      return json(res, ok ? 200 : 401, ok ? { ok: true } : { error: "invalid_token_or_frame" });
    };
  }

  const inbox = makeSessionHandler("inbound");
  const outbox = makeSessionHandler("outbound");
  const unregister = makeSessionHandler("unregister");

  const events: NodeHandler = async (req, res) => {
    setCorsHeaders(res, req);
    if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
    if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
    const session = extractSession(req, prefix);
    if (!session) return json(res, 400, { error: "missing_session" });
    const q = getQuery(req);
    const token = q.get("token") ?? "";
    const direction = q.get("direction") === "outbound" ? "outbound" : "inbound";

    // The SAME `client` the agent posts under, so a reply can find its way
    // back. An agent that subscribes with a label and posts without one (or
    // vice versa) simply does not correlate and its replies go nowhere -- which
    // fails closed, and is the right way round for a leak fix.
    const sub = broker.subscribe(session, token, direction, {
      client: getQuery(req).get("client") ?? undefined,
    });
    if (!sub.ok) {
      // 410 for a session that has ended, as on every other route; 401 only for
      // a wrong or missing token. EventSource treats either as final, so a
      // browser stops reconnecting to a page that is gone.
      res.statusCode = sub.reason === "session_gone" ? 410 : 401;
      res.setHeader("content-type", "text/event-stream");
      res.write(`event: error\ndata: ${sub.reason}\n\n`);
      return res.end();
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.write("retry: 2000\n\n");
    flush(res);

    let heartbeat: ReturnType<typeof setInterval> | null = setInterval(() => {
      res.write(": keepalive\n\n");
      flush(res);
    }, 15_000);
    if (heartbeat && typeof (heartbeat as { unref?: () => void }).unref === "function") {
      (heartbeat as { unref: () => void }).unref();
    }

    const cleanup = () => {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      sub.unsubscribe();
    };
    req.on("close", cleanup);
    req.on("error", cleanup);

    try {
      for await (const frame of sub.frames) {
        res.write(`event: mcp\ndata: ${frame}\n\n`);
        flush(res);
      }
    } catch {
      /* stream ended */
    } finally {
      cleanup();
      res.end();
    }
  };

  /**
   * Long-poll receive leg: `GET /{session}/poll?token&direction&wait&subscriber&client`.
   *
   * Answers `200 { subscriber, frames }` once a frame is queued or the park
   * window (`wait`, ms, clamped to 0..25000) runs out. Short requests survive a
   * Cloudflare HTTP/3 edge that resets long-lived SSE streams. Parking is ~free
   * on the Node event loop, unlike PHP-FPM where it holds a worker.
   */
  const poll: NodeHandler = async (req, res) => {
    setCorsHeaders(res, req);
    if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
    if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
    const session = extractSession(req, prefix);
    if (!session) return json(res, 400, { error: "missing_session" });
    const q = getQuery(req);
    const direction = q.get("direction") === "outbound" ? "outbound" : "inbound";

    const attached = broker.poll(session, q.get("token") ?? "", direction, {
      subscriber: q.get("subscriber") ?? undefined,
      client: q.get("client") ?? undefined,
    });
    if (!attached.ok) {
      return json(res, attached.reason === "session_gone" ? 410 : 401, { error: attached.reason });
    }

    // `res` 'close' fires when the client goes away before we answer. `req`
    // 'close' is not a disconnect signal: on a bodiless GET it can fire as soon
    // as the request has been read.
    const gone = new AbortController();
    const onClose = () => { if (!res.writableEnded) gone.abort(); };
    res.on("close", onClose);

    const frames = await attached.wait(pollWaitMs(q.get("wait")), gone.signal);
    res.off("close", onClose);

    if (gone.signal.aborted || res.destroyed) {
      // Nobody will read this answer. Put back anything taken for it.
      attached.requeue(frames);
      return;
    }

    res.setHeader("cache-control", "no-store");
    return json(res, 200, { subscriber: attached.subscriberId, frames });
  };

  /**
   * Single handler — routes based on method + path. Useful for mounting
   * via `http.createServer(relay.handler)` without an Express layer.
   */
  const handler: NodeHandler = async (req, res) => {
    const pathname = getPathname(req);
    if (!pathname.startsWith(prefix + "/")) {
      return json(res, 404, { error: "not_found" });
    }
    const rest = pathname.slice(prefix.length); // "/register", "/<id>/inbox", etc.
    if (rest === "/register") return register(req, res);
    const m = /^\/([A-Za-z0-9_-]{4,64})\/(inbox|outbox|events|poll|unregister)$/.exec(rest);
    if (!m) return json(res, 404, { error: "not_found" });
    const route = m[2];
    if (route === "inbox") return inbox(req, res);
    if (route === "outbox") return outbox(req, res);
    if (route === "events") return events(req, res);
    if (route === "poll") return poll(req, res);
    if (route === "unregister") return unregister(req, res);
    return json(res, 404, { error: "not_found" });
  };

  return { broker, handler, register, inbox, outbox, events, poll, unregister };
}

function extractSession(req: IncomingMessage, prefix: string): string | null {
  const host = req.headers.host || "x";
  const u = new URL(req.url || "/", `http://${host}`);
  const path = u.pathname;
  if (prefix && !path.startsWith(prefix + "/")) return null;
  const rest = prefix ? path.slice(prefix.length) : path;
  const m = /^\/([A-Za-z0-9_-]{4,64})\//.exec(rest);
  return m ? m[1] : null;
}

function flush(res: ServerResponse) {
  // Node doesn't expose explicit flush, but write returns false when buffered;
  // explicit flushHeaders + write is enough for SSE in practice.
  const r = res as { flush?: () => void };
  r.flush?.();
}

type Direction = "inbound" | "outbound";
