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

### SSE + POST tunnel

The browser opens a long-lived `EventSource` to a relay service (e.g. a Cloudflare Worker) that also accepts `POST /mcp/{session}` from external agents. The relay forwards each request as an SSE event and accepts responses via a paired POST endpoint.

## Multiple clients

A single `MicroMcpServer` can have multiple transports attached at once (e.g. an in-page agent **and** an external relay). Each receives all server-pushed notifications; tool-call replies go back on the transport that originated the call.

## Security

- **Per-session scope.** A relay channel maps 1:1 to a collab session. Tools mutate that session's state; an agent connected to session A cannot reach session B unless the host app routes it there.
- **Authorization is the host's job.** The relay carries opaque frames — gate channel access with the same auth your collab session already uses.
- **Tool surface is intentional.** Bridges register only the tools you want exposed. To restrict an agent (e.g. read-only mode), register a subset of the bridge's tools or unregister mutators after install.
