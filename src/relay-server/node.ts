import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { RelayBroker, type RelayBrokerOptions } from "./core";

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
 *   app.post("/mcp-relay/:s/unregister",  relay.unregister);
 */

export type NodeRelayOptions = RelayBrokerOptions & {
  /** URL path prefix (without trailing slash). Default `""` — handlers
   *  expect paths like `/register`, `/{id}/inbox`, etc. directly. */
  pathPrefix?: string;
  /** Comma-separated origins (or `*`) for CORS. Default `*` — relays
   *  are typically called cross-origin from the demo host. */
  corsAllowOrigin?: string;
  /**
   * Strict browser-origin allow-list. When set, only these Origins get a
   * matching `Access-Control-Allow-Origin` (the request's own Origin is
   * reflected, never `*`), which blunts DNS-rebinding + hostile cross-origin
   * pages from reading relay responses. Recommended for any browser-facing
   * deployment. When unset, `corsAllowOrigin` (default `*`) is used and the
   * session token is the only auth — pair that with a loopback bind.
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
  unregister: NodeHandler;
};

export function createNodeRelay(opts: NodeRelayOptions = {}): NodeRelay {
  const broker = new RelayBroker(opts);
  const prefix = (opts.pathPrefix ?? "").replace(/\/$/, "");
  const cors = opts.corsAllowOrigin ?? "*";

  const allowedOrigins = opts.allowedOrigins;

  function setCorsHeaders(res: ServerResponse, req?: IncomingMessage) {
    if (allowedOrigins && allowedOrigins.length) {
      // Strict mode: reflect the request Origin only when it's allow-listed;
      // otherwise emit an origin that no browser will match.
      const origin = req?.headers.origin;
      res.setHeader("access-control-allow-origin", origin && allowedOrigins.includes(origin) ? origin : "null");
      res.setHeader("vary", "origin");
    } else {
      res.setHeader("access-control-allow-origin", cors);
    }
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
        const ok = broker.unregister(session, token);
        return json(res, ok ? 200 : 401, ok ? { ok: true } : { error: "invalid_token" });
      }

      let body: string;
      try { body = await readBody(req); } catch (e) {
        return json(res, 413, { error: e instanceof Error ? e.message : "payload_error" });
      }
      const ok = direction === "inbound"
        ? broker.inbox(session, token, body)
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

    const sub = broker.subscribe(session, token, direction);
    if (!sub.ok) {
      res.statusCode = 401;
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
    const m = /^\/([A-Za-z0-9_-]{4,64})\/(inbox|outbox|events|unregister)$/.exec(rest);
    if (!m) return json(res, 404, { error: "not_found" });
    const route = m[2];
    if (route === "inbox") return inbox(req, res);
    if (route === "outbox") return outbox(req, res);
    if (route === "events") return events(req, res);
    if (route === "unregister") return unregister(req, res);
    return json(res, 404, { error: "not_found" });
  };

  return { broker, handler, register, inbox, outbox, events, unregister };
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
