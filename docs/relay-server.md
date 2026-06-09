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

## Connecting a client to a session

This doc covers running the **broker**. The agent connects from the other end
with an MCP **client** pointed at a session URL. Two options:

- **A generic MCP client you already have** — paste the session URL into Claude
  Code's `.mcp.json`, Cursor's MCP settings, Claude Desktop, etc.
- **[`mcp-relay-client`](https://github.com/Particle-Academy/mcp-relay-client)** —
  a super-lite, **single-file, zero-dependency** client in bash / Python / TS /
  Go, purpose-built for these relay sessions. Grab the one you have a runtime for
  and point it at the session URL:

  ```bash
  curl -O https://raw.githubusercontent.com/Particle-Academy/mcp-relay-client/main/connect.sh
  bash connect.sh "https://host/agent-playground?session=ABC&token=XYZ" tools
  bash connect.sh "<session-url>" call whiteboard_add_sticky '{"x":300,"y":200,"text":"hi"}'
  ```

  It derives the relay endpoints, session id, and token from the URL and runs the
  full `initialize` → `tools/list` → `tools/call` handshake for you.

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

## Deployment recipes

The relay is a tiny stateless Node HTTP server. Any platform that can host a
long-running Node process works. Pick whichever matches the rest of your
infrastructure — verification steps are at the bottom of each recipe.

### Laravel Forge (Node site or daemon)

Forge supports both Node sites and standalone daemons, either fits.

**Option A — Forge "Static" site running Node:**

1. In Forge, create a new site on your server. Set **Project Type** to
   *Static / Node*. Web directory: `/public` (unused — we'll serve from the
   relay port).
2. Add a domain (e.g. `relay.particle.academy`) and an LE SSL cert.
3. Connect the site to a deploy repo — point it at this package's git URL or
   a thin wrapper repo containing just:
   ```
   .
   ├── package.json   (just "scripts": { "start": "agent-integrations-relay --port 8787" }
   │                   and "dependencies": { "@particle-academy/agent-integrations": "^0.6.1" })
   └── README.md
   ```
4. Deploy script:
   ```bash
   cd $FORGE_SITE_PATH
   npm install --omit=dev
   ```
5. In **Daemons** (sidebar), add:
   - **Command:** `npx agent-integrations-relay --port 8787 --cors https://your-site.example`
   - **Directory:** `$FORGE_SITE_PATH`
   - **User:** `forge`
   Daemon auto-restarts on crash.
6. In the site's **Nginx config**, replace the upstream block with:
   ```nginx
   location / {
       proxy_pass http://127.0.0.1:8787;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;

       # SSE needs these — otherwise the stream is buffered and never reaches the agent.
       proxy_buffering off;
       proxy_cache off;
       proxy_read_timeout 6h;
       proxy_send_timeout 6h;
       chunked_transfer_encoding on;
   }
   ```
7. Restart Nginx via the Forge UI button or `sudo nginx -s reload`.

**Option B — daemon alongside an existing Laravel app on the same server:**

If you'd rather not give it its own subdomain, run it as a Forge daemon on
an internal port and proxy from an existing site's Nginx config:

```nginx
# Inside an existing Forge Laravel site
location /mcp-relay/ {
    proxy_pass http://127.0.0.1:8787/;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 6h;
    chunked_transfer_encoding on;
}
```

**Verify:**

```bash
curl https://relay.particle.academy/                  # → {"ok":true,"service":"…"}
curl -X POST -H 'content-type: application/json' \
  -d '{"session":"smoke-001","token":"abcdef0123456789abcdef0123456789"}' \
  https://relay.particle.academy/register             # → {"ok":true}
```

### Fly.io

```bash
git clone https://github.com/Particle-Academy/agent-integrations
cd agent-integrations
npm install && npm run build
docker build -t agent-integrations-relay .

# Init + deploy (first time only):
fly launch \
  --name relay-particle-academy \
  --no-deploy \
  --copy-config \
  --image agent-integrations-relay \
  --internal-port 8787 \
  --region iad
fly deploy
```

Public URL prints at the end, e.g. `https://relay-particle-academy.fly.dev`.

### Railway

```bash
# Commit the Dockerfile to your relay repo, then:
railway login
railway init
railway up
```

In the Railway dashboard, enable a public domain on the service; copy the
generated `*.up.railway.app` URL.

### Render

1. New → **Web Service**
2. Connect a git repo containing the Dockerfile
3. Runtime: **Docker**
4. Port: `8787`
5. Add `Header: Cache-Control: no-cache` on the service so Render's CDN
   doesn't buffer SSE

### Google Cloud Run

```bash
gcloud builds submit --tag gcr.io/$PROJECT/agent-integrations-relay
gcloud run deploy agent-integrations-relay \
  --image gcr.io/$PROJECT/agent-integrations-relay \
  --port 8787 \
  --allow-unauthenticated \
  --min-instances 1 \
  --timeout 3600
```

Cloud Run's default request timeout is 60s — bump it via `--timeout 3600`
(max 3600s on managed Cloud Run) so SSE streams aren't cut off. For longer
sessions, use **Cloud Run for Anthos / GKE** or a Compute Engine VM.

### Bare server (systemd)

If the relay is going on a VM you already own, `systemd`:

```ini
# /etc/systemd/system/mcp-relay.service
[Unit]
Description=MCP relay broker
After=network.target

[Service]
Type=simple
User=relay
WorkingDirectory=/opt/relay
ExecStart=/usr/bin/npx agent-integrations-relay --port 8787 --cors https://your-site.example
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mcp-relay
sudo systemctl status mcp-relay
```

Front with Nginx using the same SSE-friendly proxy block as the Forge
recipe.

## Smoke testing any deploy

After you have a public URL, regardless of host:

```bash
RELAY=https://relay.example.com

# 1. Health
curl $RELAY/

# 2. Register a session
curl -X POST -H 'content-type: application/json' \
  -d '{"session":"smoke-001","token":"abcdef0123456789abcdef0123456789"}' \
  $RELAY/register

# 3. POST a frame
curl -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  "$RELAY/smoke-001/inbox?token=abcdef0123456789abcdef0123456789"

# 4. SSE stream — should hang open + emit keepalive comments every 15s
curl -N "$RELAY/smoke-001/events?token=abcdef0123456789abcdef0123456789&direction=inbound"
```

If `curl -N` returns immediately, your proxy is buffering. Re-check
`proxy_buffering off` (Nginx) or the equivalent on your edge.

## Hooking into your demo site

Set the relay base URL in your demo's environment. For a Laravel host (like
particle.academy):

```env
# .env on the demo site
MCP_RELAY_BASE_URL=https://relay.particle.academy
```

Bind it to a config and read it from your Livewire/Blade layer:

```php
// config/mcp.php
return [
    'relay_base_url' => env('MCP_RELAY_BASE_URL', ''),
];
```

Then pass it to the React mount placeholder:

```blade
<div
    data-fancy-demo="composer"
    data-relay-base="{{ config('mcp.relay_base_url') }}"
></div>
```

The React side reads `node.dataset.relayBase`, passes it to the demo
component, and the component uses it for `attachSseRelay({ baseUrl: ... })`.
See [agent-hookable-demos.md](./agent-hookable-demos.md) for the
end-to-end pattern.

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
