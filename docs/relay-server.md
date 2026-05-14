# Relay server

Ships with `@particle-academy/agent-integrations` as of `0.6.0`. The relay is the
server-side half of the SSE+POST tunnel documented in [relay-protocol.md](./relay-protocol.md) —
it shuttles JSON-RPC frames between a browser-hosted `MicroMcpServer` and any
external MCP client (Claude Code, Cursor, Claude Desktop, custom agents).

The browser is the *server* in this model — it owns the tools and the state.
The relay is purely a broker. No tools run server-side; no state persists
across restarts.

## When you need a relay

- **In-process agents** (an AI assistant rendered inside the same React tree)
  don't need a relay — use `attachInProcess(server)` directly. The relay is for
  *external* agents whose process can't reach the browser tab.
- **End-user-facing demos** where a visitor pastes a session URL into Claude
  Code → the relay is hosted somewhere reachable from both the browser and the
  agent's machine.

## Three ways to run it

### 1. `npx` — local dev / one-off prod

```bash
npx -p @particle-academy/agent-integrations agent-integrations-relay --port 8787
```

End-to-end smoke test:

```bash
curl http://localhost:8787/                                                                                                  # health
curl -X POST -H 'content-type: application/json' \
  -d '{"session":"demo-001","token":"abcdef0123456789abcdef0123456789"}' \
  http://localhost:8787/register
```

CLI flags (or matching env vars `PORT`, `HOST`, `PREFIX`, `TTL_MS`, `CORS_ALLOW_ORIGIN`):

| Flag | Default | What |
|---|---|---|
| `--port <n>` | `8787` | Listen port. |
| `--host <addr>` | `0.0.0.0` | Bind address. |
| `--prefix <path>` | `""` | URL path prefix (e.g. `/mcp-relay`) when behind a reverse proxy. |
| `--ttl-ms <n>` | `14_400_000` (4h) | Session inactivity timeout. |
| `--cors <origin>` | `*` | `Access-Control-Allow-Origin` header value. |

### 2. Embed in an existing Node HTTP framework

```ts
import { createNodeRelay } from "@particle-academy/agent-integrations/relay-server";

const relay = createNodeRelay({ pathPrefix: "/mcp-relay", corsAllowOrigin: "*" });

app.post("/mcp-relay/register",         (req, res) => relay.register(req, res));
app.post("/mcp-relay/:s/inbox",         (req, res) => relay.inbox(req, res));
app.post("/mcp-relay/:s/outbox",        (req, res) => relay.outbox(req, res));
app.get ("/mcp-relay/:s/events",        (req, res) => relay.events(req, res));
app.post("/mcp-relay/:s/unregister",    (req, res) => relay.unregister(req, res));

// Or a single fall-through handler for routers that don't need per-route control:
app.use("/mcp-relay", (req, res) => relay.handler(req, res));
```

### 3. Docker

A `Dockerfile` ships in the package. Build + run:

```bash
git clone https://github.com/Particle-Academy/agent-integrations
cd agent-integrations
npm install
npm run build
docker build -t agent-integrations-relay .
docker run -p 8787:8787 agent-integrations-relay
```

Deploy targets that just want a container:

- **Fly.io:** `fly launch --image agent-integrations-relay --internal-port 8787`
- **Railway:** `railway up` after committing the Dockerfile
- **Render:** point a Web Service at the Dockerfile, expose 8787
- **Cloud Run:** `gcloud run deploy --image agent-integrations-relay --port 8787 --allow-unauthenticated`

## Wire protocol

Same shape every consumer expects:

```
POST  {prefix}/register                    body: { session, token } → { ok }
POST  {prefix}/{session}/inbox?token=…     body: JSON-RPC frame      → { ok }
POST  {prefix}/{session}/outbox?token=…    body: JSON-RPC frame      → { ok }
GET   {prefix}/{session}/events?token=…&direction=inbound|outbound
                                           SSE stream of `event: mcp\ndata: …\n\n`
POST  {prefix}/{session}/unregister?token=…                            → { ok }
GET   {prefix}/                            healthcheck → 200
```

The browser opens an `inbound` SSE subscription; external agents open `outbound`.
Both POST JSON-RPC frames at their own direction's inbox/outbox.

## Replacing the in-memory store

The default broker holds session state in a `Map`. To run multiple relay
processes behind a load balancer, swap the store:

```ts
import { RelayBroker, type Store } from "@particle-academy/agent-integrations/relay-server";

class RedisStore implements Store { /* ... */ }

const broker = new RelayBroker({ store: new RedisStore(/* … */) });
```

Frame fan-out within a single process is still in-memory; for multi-instance
correctness wire frames through a pub/sub (Redis Streams, NATS, etc.) by
extending the broker or running an instance per session-id-prefix.

## Security notes

- **Token comparison is timing-safe** (`crypto.timingSafeEqual`).
- **Sessions auto-expire** after `ttlMs` inactivity; every authenticated touch
  slides the TTL forward.
- **Payload caps** — individual frames are rejected past 256 KB.
- The relay carries opaque frames; auth is your session token. Tighter access
  control (per-IP rate limit, allowlist) belongs in your reverse proxy layer.
