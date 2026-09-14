#!/usr/bin/env node
import { createServer } from "node:http";
import { parseRelayArgs } from "./args";
import { describeCorsPolicy } from "./cors";
import { createNodeRelay } from "./node";

/**
 * `agent-integrations-relay` — standalone Node HTTP server hosting the relay
 * broker. End users hit `Start share` on a demo page, get a session URL pointing
 * at this service, and paste it into their MCP client. No state persists across
 * restarts.
 *
 * Settings resolve flag → env var → default; see ./args.ts and HELP below.
 *
 * Health: any request to `/` returns 200 OK so platform health checks pass
 * without authenticating.
 */
async function main() {
  const parsed = parseRelayArgs(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    process.stderr.write(`[relay] ${parsed.error}\n`);
    process.exit(2);
  }

  const { config } = parsed;
  if (config.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  for (const warning of config.warnings) {
    process.stderr.write(`[relay] WARNING: ${warning}\n`);
  }

  const { port, host, prefix, ttlMs, cors } = config;
  const relay = createNodeRelay({
    pathPrefix: prefix,
    ttlMs,
    corsAllowOrigin: cors.kind === "any" ? "*" : cors.origins.join(","),
  });

  const server = createServer((req, res) => {
    // Health: GET / always 200 so platform health checks succeed without auth.
    const url = req.url || "/";
    if ((url === "/" || url === "/healthz" || url === (prefix + "/")) && req.method === "GET") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, service: "agent-integrations-relay" }));
      return;
    }
    relay.handler(req, res);
  });

  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!isLoopback) {
    process.stderr.write(
      `[relay] WARNING: binding ${host} exposes the relay on non-loopback interfaces. ` +
        `register is unauthenticated and a leaked session token grants terminal_run. ` +
        `Only do this behind an authenticating proxy / trusted network.\n`,
    );
  }

  const corsSource = { flag: "--cors", env: "CORS_ALLOW_ORIGIN", default: "default" }[config.sources.cors];
  server.listen(port, host, () => {
    process.stdout.write(
      `[relay] listening on http://${host}:${port}${prefix || ""} ` +
        `(ttl=${Math.round(ttlMs / 1000)}s, cors=${describeCorsPolicy(cors)} from ${corsSource})\n`,
    );
  });

  const shutdown = () => {
    process.stdout.write("[relay] shutting down\n");
    relay.broker.dispose();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const HELP = `agent-integrations-relay — Node HTTP server for the MCP relay broker.

Usage: agent-integrations-relay [options]

Options:
  --port <n>          Listen port (env: PORT). Default 8787.
  --host <addr>       Bind address (env: HOST). Default 127.0.0.1 (loopback).
                      Pass 0.0.0.0 to expose on all interfaces (prints a warning).
  --prefix <path>     URL path prefix (env: PREFIX). Default "".
  --ttl-ms <n>        Session TTL ms (env: TTL_MS). Default 14_400_000.
  --cors <origins>    Allowed browser origins (env: CORS_ALLOW_ORIGIN). Default "*".
                      "*", or a comma-separated list such as
                      "https://example.com,https://www.example.com". May be
                      repeated. A listed Origin is echoed back with Vary: Origin;
                      an unlisted one gets no Access-Control-Allow-Origin.
  -h, --help          Show this help.

Precedence: a flag wins over its env var, which wins over the default. An env
var that a flag overrides is reported at startup. An empty env var is unset.

Endpoints (under --prefix):
  POST  /register                          { session, token } → { ok: true }
  POST  /<session>/inbox?token=...         body: JSON-RPC frame
  POST  /<session>/outbox?token=...        body: JSON-RPC frame
  GET   /<session>/events?token=...&direction=inbound|outbound
                                           Server-sent events stream
  GET   /<session>/poll?token=...&direction=inbound|outbound&wait=<ms>&subscriber=<id>
                                           Long-poll → { subscriber, frames }
  POST  /<session>/unregister?token=...    Tear down session
  GET   /                                  Healthcheck → 200

A session that has ended answers 410 {"error":"session_gone"} on every session
route; a wrong or missing token answers 401.
`;

main().catch((e) => {
  process.stderr.write(`[relay] fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
