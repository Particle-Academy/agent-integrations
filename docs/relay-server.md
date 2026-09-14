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

## When a session is gone

A relay session ends when the page closes or its TTL elapses. That is the
**normal** end of a lifecycle, not an error condition: the browser is the server,
it owns the tools and the state, and nothing persists across restarts.

So a client must be able to tell "this session is over" from "your credentials
are wrong". The broker reports them separately:

| condition | `check()` | HTTP |
|---|---|---|
| live session, good token | `{ok: true}` | `200` |
| session never existed, or has expired | `{ok: false, reason: "session_gone"}` | **`410 Gone`** |
| wrong token on a LIVE session | `{ok: false, reason: "invalid_token"}` | `401` |
| no session id or no token supplied | `{ok: false, reason: "invalid_token"}` | `401` |

`410` rather than `404`: the session existed and is now over, which is what the
status means, and it separates "this is finished" from "you have the wrong URL".

The table holds for **every** session route — `inbox`, `outbox`, `poll` and
`events`. The POST routes and `poll` answer JSON (`{"error":"session_gone"}`);
`events` answers the same status with an SSE body, `event: error` /
`data: session_gone`. A browser's `EventSource` treats a `410` (or `401`) as
final and stops reconnecting. An SSE stream that is OPEN when its session ends
is closed by the relay, so its client reconnects and gets the `410`.
(Before 0.46.0 `events` still answered `401` for a gone session, and an open
stream stayed open.)

Two deliberate choices:

- **A wrong token on a live session is never `session_gone`.** Answering
  otherwise would tell an unauthenticated caller which sessions exist.
- **Unregistering an already-gone session succeeds** (`{ok: true, alreadyGone:
  true}`). The caller wanted it gone and it is gone; reporting an auth failure
  for a correct token would make a clean shutdown look broken, and a client
  retrying it would loop.

Every failure previously came back as `401 invalid_token_or_frame`, so an agent
whose page had simply closed was told its credentials or its JSON were wrong —
an actively misleading answer that sends the reader to debug an auth path that
was never the problem. `validate()` still returns a boolean for existing
callers; `check()` is the one that says why.

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

CLI flags and their env vars:

| Flag | Env var | Default | What |
|---|---|---|---|
| `--port <n>` | `PORT` | `8787` | Listen port. |
| `--host <addr>` | `HOST` | `127.0.0.1` | Bind address. Loopback since 0.30.0: `register` is unauthenticated and a session token reaches every tool the page exposes, so the port should only be reachable through your proxy. `--host 0.0.0.0` exposes it and prints a warning. (The Dockerfile sets `HOST=0.0.0.0`, which is what a container needs; publish the port only to your proxy.) |
| `--prefix <path>` | `PREFIX` | `""` | URL path prefix (e.g. `/mcp-relay`) when behind a reverse proxy. |
| `--ttl-ms <n>` | `TTL_MS` | `14_400_000` (4h) | Session inactivity timeout. |
| `--cors <origins>` | `CORS_ALLOW_ORIGIN` | `*` | Browser origins allowed to read responses: `*`, or a comma-separated list (see below). May be repeated. |

**Precedence: flag, then env var, then default — for every setting.** A flag is
what the person starting the process typed; an env var is often set by a
platform (Forge sets `PORT`), so the explicit one wins. When a flag overrides an
env var set to something different, the relay says so at startup:

```
[relay] WARNING: CORS_ALLOW_ORIGIN=https://b.example is ignored: --cors https://a.example was passed, and a flag wins over its env var.
```

So if your start script passes `--cors`, change the start script, not the env
var. An env var set to the empty string counts as unset. The startup line names
where the CORS policy came from: `cors=https://a.example from --cors`.

### CORS: `*` or a list

`Access-Control-Allow-Origin` holds ONE origin or `*`, so a list is enforced per
request:

- `--cors "https://example.com,https://www.example.com"` (or `--cors` twice):
  a request whose `Origin` is listed gets that origin echoed back, every
  response carries `Vary: Origin`, and an unlisted origin gets **no**
  `Access-Control-Allow-Origin` at all — never `null`, which is what sandboxed
  iframes and `file://` pages send.
- `--cors "*"` (the default) sends `*`.
- Entries are normalised to what a browser sends (`HTTPS://Example.com:443/` →
  `https://example.com`). `*` mixed with origins, an empty list, `null`, or an
  entry with a path is refused at startup with exit code 2.

Before 0.46.0 the value was sent verbatim, so a comma-separated list produced a
header no browser accepts.

### 2. Embed in an existing Node HTTP framework

```ts
import { createNodeRelay } from "@particle-academy/agent-integrations/relay-server";

const relay = createNodeRelay({
  pathPrefix: "/mcp-relay",
  corsAllowOrigin: "https://example.com,https://www.example.com", // or "*"
});

app.post("/mcp-relay/register",         (req, res) => relay.register(req, res));
app.post("/mcp-relay/:s/inbox",         (req, res) => relay.inbox(req, res));
app.post("/mcp-relay/:s/outbox",        (req, res) => relay.outbox(req, res));
app.get ("/mcp-relay/:s/events",        (req, res) => relay.events(req, res));
app.get ("/mcp-relay/:s/poll",          (req, res) => relay.poll(req, res));
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
   │                   and "dependencies": { "@particle-academy/agent-integrations": ">=0.46.0 <2.0" })
   └── README.md
   ```
4. Deploy script:
   ```bash
   cd $FORGE_SITE_PATH
   npm install --omit=dev
   ```
5. In **Daemons** (sidebar), add:
   - **Command:** `npx agent-integrations-relay --port 8787 --cors "https://your-site.example,https://www.your-site.example"`
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
ExecStart=/usr/bin/npx agent-integrations-relay --port 8787 --cors "https://your-site.example,https://www.your-site.example"
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

# 5. Long-poll — returns {"subscriber":"…","frames":[…]} at once with wait=0
curl "$RELAY/smoke-001/poll?token=abcdef0123456789abcdef0123456789&direction=inbound&wait=0"

# 6. CORS — a listed origin is echoed back; an unlisted one gets no allow-origin header
curl -si -X OPTIONS -H 'Origin: https://your-site.example' $RELAY/register | grep -i '^access-control-allow-origin\|^vary'
```

If `curl -N` returns immediately, your proxy is buffering. Re-check
`proxy_buffering off` (Nginx) or the equivalent on your edge.

## Behind Cloudflare (or any CDN that resets long streams)

Cloudflare's HTTP/3 (QUIC) edge resets long-lived SSE streams — the browser logs
`net::ERR_QUIC_PROTOCOL_ERROR` and the `events` leg never holds. Short requests
are unaffected, so the relay also serves a **long-poll** receive leg,
`GET {prefix}/{session}/poll`, which carries the same frames:

- In the browser, `SseRelayTransport` uses
  [`@particle-academy/fancy-cf-relay`](https://github.com/Particle-Academy/fancy-cf-relay)
  when it is installed: it detects Cloudflare from the `cf-ray` header and polls
  there, and falls back to polling anywhere SSE fails early. Install it
  (`npm i @particle-academy/fancy-cf-relay`) for any relay behind a CDN.
- Agents on [`mcp-relay-client`](https://github.com/Particle-Academy/mcp-relay-client)
  poll already.

A parked poll costs nothing on Node's event loop, so the relay allows the full
25-second window; the park returns early the moment a frame is queued. The
contract is the PHP relay's (px-ui-sandbox `AgentRelayController::poll`), and
the Node relay's tests mirror its PHP tests case for case. (The poll route is new
in 0.46.0; before it, a Node relay behind Cloudflare HTTP/3 had no working
receive leg.)

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
GET   {prefix}/{session}/events?token=…&direction=inbound|outbound[&client=…]
                                           SSE stream of `event: mcp\ndata: …\n\n`
GET   {prefix}/{session}/poll?token=…&direction=inbound|outbound&wait=<ms>&subscriber=<id>[&client=…]
                                           → { subscriber, frames: ["<frame>", …] }
POST  {prefix}/{session}/unregister?token=…                            → { ok }
GET   {prefix}/                            healthcheck → 200
```

The browser subscribes `inbound`; external agents subscribe `outbound` — over
`events` or `poll`. The browser POSTs its frames to `outbox`, agents to `inbox`.

`poll`: the first call (no `subscriber`) is handed a 16-hex-digit id; echo it back
on every later poll to keep reading the same queue. `wait` is the park window in
ms, clamped to 0–25000, default 20000. Frames queue between polls, so none is
lost in the gap; a poller that stops for 60 s (`pollIdleMs`) is dropped, and for
an agent the page is sent `notifications/peer_left`.

A session that has ended answers `410` on every session route; a wrong or
missing token answers `401` — see [When a session is gone](#when-a-session-is-gone).

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
- **CORS is not access control.** An origin list stops other sites' pages from
  READING relay responses; it does not stop a request from being sent, and
  non-browser clients ignore it entirely. The session token is still the only
  authority.
