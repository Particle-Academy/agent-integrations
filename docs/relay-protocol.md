# Relay protocol

A relay lets external MCP clients (Claude Desktop, Cline, a custom agent) reach a `MicroMcpServer` running inside a browser session. The relay carries opaque JSON-RPC frames between the two endpoints.

## Wire format

The relay is just a duplex JSON-frame channel. Each frame is a complete MCP / JSON-RPC 2.0 message:

```jsonc
// client → server
{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }

// server → client
{ "jsonrpc": "2.0", "id": 1, "result": { "tools": [...] } }

// server → client (notification)
{ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }
```

The relay is responsible for **delivery**, not framing or authorization — the underlying transport (websocket, SSE+POST, WebRTC data channel) handles those concerns.

## Recommended transports

### Laravel Reverb (private channel)

A single private channel per session. The browser tab and the agent both connect via the host app's auth bridge. Whispers carry MCP frames.

```ts
// Browser side
import { attachRelay } from "@particle-academy/agent-integrations";

const channel = Echo.private(`agent.session.${sessionId}`);
const transport = attachRelay(server, {
  sendToRemote: (frame) => channel.whisper("mcp", frame),
});
channel.listenForWhisper("mcp", (frame) => transport.deliverFromRemote(frame));
```

The agent side connects to the same Reverb channel via your auth bridge and reads/writes whispers identically.

### WebRTC data channel

For direct peer connections (no server hop), open a data channel and pipe frames through it.

### SSE + POST tunnel (the HTTP relay)

What the bundled Node relay (`agent-integrations-relay`, see
[relay-server.md](./relay-server.md)) and the PHP relay in px-ui-sandbox both
serve. Every route sits under the relay's base URL, with the session id as the
first path segment:

```
POST {base}/register                                   { session, token }
POST {base}/{session}/inbox?token=…[&client=…]         agent → page   (a JSON-RPC frame)
POST {base}/{session}/outbox?token=…                   page  → agent  (a JSON-RPC frame)
GET  {base}/{session}/events?token=…&direction=…[&client=…]   receive leg, SSE
GET  {base}/{session}/poll?token=…&direction=…&wait=…&subscriber=…[&client=…]
                                                       receive leg, long-poll
POST {base}/{session}/unregister?token=…
```

`direction` names the queue a subscriber READS: the page reads `inbound` (what
agents sent it) and an agent reads `outbound` (what the page answered).

**Two receive legs, one queue model.** `events` is one long-lived SSE stream of
`event: mcp
data: <frame>

`. `poll` is a series of short requests, each
answering `{ "subscriber": "<id>", "frames": ["<frame>", …] }` as soon as a frame
is queued or the `wait` window (ms, at most 25000) runs out; the client echoes
`subscriber` back on the next poll to keep reading the same queue. Use `poll`
behind a CDN: Cloudflare's HTTP/3 edge resets long-lived SSE streams
(`net::ERR_QUIC_PROTOCOL_ERROR`), and short requests pass.
[`@particle-academy/fancy-cf-relay`](https://github.com/Particle-Academy/fancy-cf-relay)
picks between the two automatically in the browser; `mcp-relay-client` polls.

**A session that has ended answers `410`** (`{"error":"session_gone"}`, or an
`event: error` / `data: session_gone` SSE body on `events`) on every session
route. `401` means a wrong or missing token on a live session. An SSE leg open
when its session ends is closed by the relay.

## Multiple clients, and who sees a reply

**A tool reply goes to the client that asked. Notifications go to everyone.**

Identify yourself with a `client` query parameter on BOTH your subscription and
your posts — the same value on each:

```
GET  {base}/{session}/events?token=…&direction=outbound&client=worker-7
POST {base}/{session}/inbox?token=…&client=worker-7
```

A long-poll subscriber labels itself the same way: `GET {base}/{session}/poll?…&client=worker-7`.

The broker records which client sent each JSON-RPC request id and delivers the
matching response to that client alone. Notifications (frames with no `id`)
still reach every subscriber, because presence, activity and server-pushed state
answer nobody and are meant for all of them.

**Why this is not optional in a shared session.** The relay broadcast every
frame, and the session token carries no per-agent identity — so a second holder
of the token did not merely gain the ability to call tools, they *passively
received the results of everyone else's calls* without making one. On a live
application page those results carry whatever the bridges expose. That turned a
share link from "you may act here" into "you may watch everyone acting here",
which nobody chose: it fell out of two independently sensible decisions meeting.

A client that sends no `client` label still gets the old broadcast — narrowing
it would break existing clients in silence — but a session where **any**
subscriber identifies itself switches to scoped routing, and an uncorrelated
response then reaches nobody rather than everyone. Fail closed.

Fixed in 0.44.0. Reported by the Prism harness, composing two separate answers
about fan-out and token semantics.

## Multiple transports on one server

A single `MicroMcpServer` can have multiple transports attached at once (e.g. an in-page agent **and** an external relay). Each receives all server-pushed notifications; tool-call replies go back on the transport that originated the call.

## Security

- **Per-session scope.** A relay channel maps 1:1 to a collab session. Tools mutate that session's state; an agent connected to session A cannot reach session B unless the host app routes it there.
- **Authorization is the host's job.** The relay carries opaque frames — gate channel access with the same auth your collab session already uses.
- **Tool surface is intentional.** Bridges register only the tools you want exposed. To restrict an agent (e.g. read-only mode), register a subset of the bridge's tools or unregister mutators after install.
