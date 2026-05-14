#!/usr/bin/env node
import { createServer } from "node:http";
import { createNodeRelay } from "./node";

/**
 * `agent-integrations-relay` — standalone Node HTTP server hosting the
 * SSE+POST relay broker. End users hit `Start share` on a /ui/demos
 * page, get a session URL pointing at this service, and paste it into
 * their MCP client. No state persists across restarts.
 *
 * Flags:
 *   --port <n>          Listen port. Default 8787.
 *   --host <addr>       Bind address. Default 0.0.0.0.
 *   --prefix <path>     URL path prefix (no trailing slash). Default "".
 *                       Useful when mounting behind a reverse proxy.
 *   --ttl-ms <n>        Session TTL ms. Default 14_400_000 (4h).
 *   --cors <origin>     Access-Control-Allow-Origin. Default "*".
 *   -h, --help          Show this help.
 *
 * Health: any request to `/` returns 200 OK so platform health checks
 * pass without authenticating.
 */
async function main() {
  const argv = process.argv.slice(2);
  let port = Number(process.env.PORT ?? 8787);
  let host = process.env.HOST ?? "0.0.0.0";
  let prefix = process.env.PREFIX ?? "";
  let ttlMs = Number(process.env.TTL_MS ?? 4 * 60 * 60 * 1000);
  let cors = process.env.CORS_ALLOW_ORIGIN ?? "*";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--port": port = Number(argv[++i]); break;
      case "--host": host = argv[++i]; break;
      case "--prefix": prefix = argv[++i]; break;
      case "--ttl-ms": ttlMs = Number(argv[++i]); break;
      case "--cors": cors = argv[++i]; break;
      case "-h":
      case "--help":
        process.stdout.write(HELP);
        process.exit(0);
      default:
        process.stderr.write(`[relay] unknown flag: ${a}\n`);
        process.exit(2);
    }
  }

  if (!Number.isFinite(port) || port <= 0) {
    process.stderr.write(`[relay] invalid --port: ${port}\n`);
    process.exit(2);
  }

  const relay = createNodeRelay({ pathPrefix: prefix, ttlMs, corsAllowOrigin: cors });

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

  server.listen(port, host, () => {
    process.stdout.write(
      `[relay] listening on http://${host}:${port}${prefix || ""} ` +
        `(ttl=${Math.round(ttlMs / 1000)}s, cors=${cors})\n`,
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
  --host <addr>       Bind address (env: HOST). Default 0.0.0.0.
  --prefix <path>     URL path prefix (env: PREFIX). Default "".
  --ttl-ms <n>        Session TTL ms (env: TTL_MS). Default 14_400_000.
  --cors <origin>     CORS Access-Control-Allow-Origin (env: CORS_ALLOW_ORIGIN). Default "*".
  -h, --help          Show this help.

Endpoints (under --prefix):
  POST  /register                          { session, token } → { ok: true }
  POST  /<session>/inbox?token=...         body: JSON-RPC frame
  POST  /<session>/outbox?token=...        body: JSON-RPC frame
  GET   /<session>/events?token=...&direction=inbound|outbound
                                           Server-sent events stream
  POST  /<session>/unregister?token=...    Tear down session
  GET   /                                  Healthcheck → 200
`;

main().catch((e) => {
  process.stderr.write(`[relay] fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
