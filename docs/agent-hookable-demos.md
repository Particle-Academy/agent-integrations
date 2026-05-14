# Building agent-hookable demos on your site

End-to-end workflow for shipping a public-facing UI surface where visitors can
hand control to an MCP agent (Claude Code, Cursor, Claude Desktop, custom)
in real time. The piece you implement varies by site stack; the wire protocol
doesn't.

## The architecture, plainly

```
   ┌────────────────────────┐         ┌──────────────────────┐
   │ Visitor's browser tab  │         │  External agent      │
   │ ──────────────────     │         │  (Claude Code, etc.) │
   │  React app             │         └────────┬─────────────┘
   │  MicroMcpServer        │                  │
   │  (tools touch the      │                  │ HTTP POST + SSE
   │   live UI surface)     │                  │
   └──────────┬─────────────┘                  │
              │                                │
              │   SSE stream                   │
              │ + HTTP POST                    │
              ▼                                ▼
        ┌──────────────────────────────────────┐
        │           Relay broker               │
        │  ──────────────                      │
        │  - Holds session→token mapping       │
        │  - Fans frames between subscribers   │
        │  - In-memory queues + sliding TTL    │
        │  - No tool logic, no state           │
        └──────────────────────────────────────┘
```

Three pieces. You write zero of them yourself if you follow this guide:

1. **The browser-side MCP server.** Already shipped: `MicroMcpServer` + bridges +
   `SseRelayTransport` from this package.

2. **The relay broker.** *Pick one.* Either the bundled Node server (see
   [relay-server.md](./relay-server.md)) or a same-stack reference
   implementation (see § "Same-stack relays" below — currently includes a
   complete Laravel controller).

3. **The agent's client.** Out of your control — visitors paste your session
   URL into whatever MCP client they already use.

## End-user UX

This is what visitors actually experience. Every demo follows the same shape:

1. Visitor opens `https://your-site.example/demos/some-surface`.
2. Surface is interactive on its own — clicking around works, the in-page
   `MicroMcpServer` is already running.
3. Visitor clicks **Start share**.
4. The page mints a per-session token, registers it with the relay, and shows
   a copyable share URL.
5. Visitor pastes the URL into their MCP client (`.mcp.json` for Claude Code,
   Cursor's MCP settings, etc.). The client connects to the relay.
6. Agent calls tools → tools mutate the host page's React state → visitor
   watches the surface change in real time. Optional: agent cursor + tool-call
   feed render alongside.
7. **Stop share** tears the session down.

## Browser-side wiring (any site)

```tsx
import {
  MicroMcpServer,
  attachInProcess,
  attachSseRelay,
  createSessionDescriptor,
  buildShareUrl,
  textResult,
} from "@particle-academy/agent-integrations";

// Once per page mount:
const server = new MicroMcpServer({
  info: { name: "your-demo", version: "0.1.0" },
});

server.registerTool(
  { name: "your_tool", description: "...", inputSchema: { /* JSON Schema */ } },
  async (args) => {
    // Touch React state, return a CallToolResult
    return textResult("ok");
  },
);

attachInProcess(server); // lets in-page UI also call tools

// When the user clicks "Start share":
async function startShare(relayBaseUrl: string) {
  const desc = createSessionDescriptor();
  await fetch(`${relayBaseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: desc.id, token: desc.token }),
  });
  attachSseRelay(server, {
    baseUrl: relayBaseUrl,
    sessionId: desc.id,
    token: desc.token,
  });
  const url = buildShareUrl(window.location.origin + relayBaseUrl, desc);
  // Show `url` to the user in a copy-able UI
}
```

The components that bundle this pattern out of the box:

- `<SharedWhiteboard>` (subpath `./components/shared-whiteboard`) — whiteboard
  + share controls + agent panel + presence cursor in one drop-in.
- The pa-ux-sandbox repo has reference React components for composer, sheets,
  flow, code-editor surfaces under `resources/js/react-demos/pages/*Agent*.tsx`.

## Relay broker — pick one

### Option A: bundled Node server (recommended for non-PHP hosts)

`@particle-academy/agent-integrations@^0.6.0` ships a complete Node HTTP
implementation, exposed three ways: standalone CLI, embeddable factory, and
Dockerfile. **Full docs:** [relay-server.md](./relay-server.md).

```bash
npx -p @particle-academy/agent-integrations agent-integrations-relay --port 8787
```

Point your demo's `relayBaseUrl` at this server's origin and you're done.

### Option B: same-stack reference implementation

If your site already runs Laravel/Rails/Django/etc., implementing the relay
in the same stack avoids the operational cost of a separate Node process. The
wire protocol is small (~5 endpoints); a port is ~200 LOC.

A complete **Laravel 10+** reference follows. It's framework-agnostic in
intent — adapt the route registration and cache binding to your framework's
conventions; the logic is the same shape everywhere.

#### Laravel reference implementation

**1. Controller** — drop into `app/Http/Controllers/McpRelayController.php`:

```php
<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Symfony\Component\HttpFoundation\StreamedResponse;

class McpRelayController extends Controller
{
    private const TTL_SECONDS = 14400; // 4h — refreshed on every authenticated touch.
    private const POLL_INTERVAL_MS = 200;

    public function register(Request $request): JsonResponse
    {
        $data = $request->validate([
            'session' => ['required', 'string', 'regex:/^[A-Za-z0-9_-]{4,64}$/'],
            'token'   => ['required', 'string', 'min:16', 'max:128'],
        ]);
        Cache::put($this->tokenKey($data['session']), hash('sha256', $data['token']), self::TTL_SECONDS);
        return response()->json(['ok' => true]);
    }

    public function unregister(Request $request, string $session): JsonResponse
    {
        if (! $this->validateToken($session, (string) $request->query('token'))) {
            return response()->json(['error' => 'invalid_token'], 401);
        }
        Cache::forget($this->tokenKey($session));
        return response()->json(['ok' => true]);
    }

    public function inbox(Request $request, string $session): JsonResponse
    {
        if (! $this->validateToken($session, (string) $request->query('token'))) {
            return response()->json(['error' => 'invalid_token'], 401);
        }
        $payload = $request->getContent();
        if ($payload === '' || ! str_contains($payload, '"jsonrpc"')) {
            return response()->json(['error' => 'invalid_frame'], 400);
        }
        $this->fanOut($session, 'inbound', $payload);
        return response()->json(['ok' => true]);
    }

    public function outbox(Request $request, string $session): JsonResponse
    {
        if (! $this->validateToken($session, (string) $request->query('token'))) {
            return response()->json(['error' => 'invalid_token'], 401);
        }
        $payload = $request->getContent();
        if ($payload === '' || ! str_contains($payload, '"jsonrpc"')) {
            return response()->json(['error' => 'invalid_frame'], 400);
        }
        $this->fanOut($session, 'outbound', $payload);
        return response()->json(['ok' => true]);
    }

    public function events(Request $request, string $session): StreamedResponse
    {
        $token = (string) $request->query('token');
        if (! $this->validateToken($session, $token)) {
            return response()->stream(
                fn () => print "event: error\ndata: invalid_token\n\n",
                401,
                ['content-type' => 'text/event-stream'],
            );
        }
        $direction = $request->query('direction', 'inbound') === 'outbound' ? 'outbound' : 'inbound';
        $subscriberId = bin2hex(random_bytes(8));

        return response()->stream(function () use ($session, $direction, $subscriberId) {
            @set_time_limit(0);
            @ini_set('output_buffering', 'off');
            @ini_set('zlib.output_compression', '0');

            $key = $this->queueKey($session, $direction, $subscriberId);
            $subsKey = $this->subscribersKey($session, $direction);
            $subs = Cache::get($subsKey, []);
            $subs[$subscriberId] = time();
            Cache::put($subsKey, $subs, self::TTL_SECONDS);

            if ($direction === 'outbound') {
                $this->fanOut($session, 'inbound', json_encode([
                    'jsonrpc' => '2.0',
                    'method'  => 'notifications/peer_joined',
                    'params'  => ['subscriberId' => $subscriberId, 'ts' => time() * 1000],
                ]));
            }

            echo "retry: 2000\n\n";
            $this->flush();

            $lastBeat = time();
            while (! connection_aborted()) {
                $frames = Cache::pull($key, []);
                foreach ($frames as $frame) {
                    echo "event: mcp\ndata: {$frame}\n\n";
                }
                if (! empty($frames)) {
                    $this->flush();
                }
                if ((time() - $lastBeat) >= 15) {
                    echo ": keepalive\n\n";
                    $this->flush();
                    $lastBeat = time();
                }
                usleep(self::POLL_INTERVAL_MS * 1000);
            }

            $subs = Cache::get($subsKey, []);
            unset($subs[$subscriberId]);
            Cache::put($subsKey, $subs, self::TTL_SECONDS);
            Cache::forget($key);

            if ($direction === 'outbound') {
                $this->fanOut($session, 'inbound', json_encode([
                    'jsonrpc' => '2.0',
                    'method'  => 'notifications/peer_left',
                    'params'  => ['subscriberId' => $subscriberId, 'ts' => time() * 1000],
                ]));
            }
        }, 200, [
            'content-type'    => 'text/event-stream',
            'cache-control'   => 'no-cache',
            'x-accel-buffering' => 'no',
        ]);
    }

    private function fanOut(string $session, string $direction, string $payload): void
    {
        $subsKey = $this->subscribersKey($session, $direction);
        $subs = Cache::get($subsKey, []);
        foreach (array_keys($subs) as $subscriberId) {
            $key = $this->queueKey($session, $direction, $subscriberId);
            $existing = Cache::get($key, []);
            $existing[] = $payload;
            Cache::put($key, $existing, self::TTL_SECONDS);
        }
        Cache::put($subsKey, $subs, self::TTL_SECONDS);
    }

    private function validateToken(string $session, string $token): bool
    {
        if ($session === '' || $token === '') return false;
        $key = $this->tokenKey($session);
        $stored = Cache::get($key);
        if ($stored === null) return false;
        if (! hash_equals((string) $stored, hash('sha256', $token))) return false;
        Cache::put($key, $stored, self::TTL_SECONDS);
        return true;
    }

    private function tokenKey(string $session): string
    {
        return "mcp-relay:token:{$session}";
    }

    private function subscribersKey(string $session, string $direction): string
    {
        return "mcp-relay:subs:{$session}:{$direction}";
    }

    private function queueKey(string $session, string $direction, string $subscriberId): string
    {
        return "mcp-relay:queue:{$session}:{$direction}:{$subscriberId}";
    }

    private function flush(): void
    {
        if (function_exists('ob_get_level') && ob_get_level() > 0) {
            @ob_flush();
        }
        @flush();
    }
}
```

**2. Routes** — `routes/web.php`:

```php
Route::post('/mcp-relay/register',              [McpRelayController::class, 'register']);
Route::post('/mcp-relay/{session}/unregister',  [McpRelayController::class, 'unregister']);
Route::post('/mcp-relay/{session}/inbox',       [McpRelayController::class, 'inbox']);
Route::post('/mcp-relay/{session}/outbox',      [McpRelayController::class, 'outbox']);
Route::get ('/mcp-relay/{session}/events',      [McpRelayController::class, 'events']);
```

**3. CSRF exemption** — `bootstrap/app.php` (Laravel 11+):

```php
->withMiddleware(function (Middleware $middleware) {
    $middleware->validateCsrfTokens(except: [
        'mcp-relay/*',
    ]);
})
```

(Laravel 10: add to `VerifyCsrfToken::$except` in `app/Http/Middleware/`.)

**4. Operational notes**

- Storage uses the default cache driver — `file` works for single-server
  setups, but for any production deploy use `redis` so the broker survives
  PHP-FPM worker recycles and load-balances correctly across processes.
- The SSE `events()` action holds a long-lived HTTP connection. Confirm your
  proxy / PHP-FPM timeouts allow this:
  - Nginx: `proxy_read_timeout` ≥ 6h, `proxy_buffering off` for SSE
  - PHP-FPM: `request_terminate_timeout = 0` or `>= 4h`
- The 15-second keepalive ping (`: keepalive\n\n`) prevents most proxies from
  killing idle connections. Validate after deploy.
- This implementation handles ~50 concurrent sessions on a single Laravel
  worker. For more, run multiple workers behind a load balancer with a
  redis cache backend.

### Option C: implement in another stack

Same protocol, same five endpoints, same wire format. Reference the Laravel
controller above and the [relay-protocol.md](./relay-protocol.md) wire spec.
For Rails: `ActionController::Live` for SSE + `Rails.cache` for storage. For
Django: `StreamingHttpResponse` + `django.core.cache`. For Express/Fastify:
just use the bundled `createNodeRelay()` factory from this package.

## Choosing between A and B

| You want… | Pick |
|---|---|
| Add a couple of demos to an existing Laravel app | **B (Laravel)** — no new infrastructure |
| Demo site is static / no backend yet | **A (Node)** — `agent-integrations-relay` container |
| Multiple Fancy UI demos across multiple sites | **A**, deployed once at a central origin |
| Already running Rails/Django/etc. | **C** — port the Laravel reference |
| Edge / serverless | **A** with `createNodeRelay` adapted to your runtime, or bring your own `RelayBroker` + `Store` |

The browser-side code doesn't change between options. The relay broker URL is
the only difference.

## Worked example — the particle.academy site

The marketing site for this kit hosts two agent-hookable demos at
`/ui/demos/composer` and `/ui/demos/agent-presence`. Stack: Laravel 12 +
Livewire + Tailwind v4, plus a React island for the demo surfaces. The relay
runs in-app via Option B (the Laravel reference above lives at
`app/Http/Controllers/McpRelayController.php` in the
[Particle-Academy/website](https://github.com/Particle-Academy/website) repo).

The pattern there matches this doc exactly: a controlled React component
mounts via `data-fancy-demo` placeholders; `MicroMcpServer` registers
composer/whiteboard tools that touch local state; clicking *Start share*
hits the relay's `/register` and opens an SSE subscription. Visitors paste
the resulting URL into their MCP client and the demo becomes agent-driven.

## See also

- [relay-protocol.md](./relay-protocol.md) — the wire format, including the
  three transports the protocol supports (Reverb, WebRTC, SSE+POST)
- [relay-server.md](./relay-server.md) — the bundled Node relay
- [`SharedWhiteboard`](../src/components/SharedWhiteboard/SharedWhiteboard.tsx) —
  source for a fully-composed agent-hookable surface, useful as a template
