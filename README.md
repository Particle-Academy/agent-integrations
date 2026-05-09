# @particle-academy/agent-integrations

MCP-driven agent presence in collab sessions. Each open session gets a **micro-MCP server** running in-page; agents (in-browser or external via relay) connect to it and act as participants — adding sticky notes, drawing, moving items, leaving cursor trails.

Also ships the **agent UX surface**: a chat-and-tool-log panel, an on-canvas presence cursor, and a brief activity highlight for items the agent just touched.

> v0.1 — focused on `@particle-academy/fancy-whiteboard` as the first bridged surface. The bridge layer is package-agnostic, so other fancy-* packages can register their own tool sets per session.

## Install

```bash
npm install @particle-academy/agent-integrations
```

```ts
import "@particle-academy/agent-integrations/styles.css";
```

## Architecture

```
┌─ Browser tab ───────────────────────────────────────┐
│   Whiteboard UI ── controlled state ── Bridge       │
│        ▲                                  │        │
│        │ tool calls mutate state          ▼        │
│        └────────── MicroMcpServer ◄─── Transport ◄─ │
│                                          ▲          │
└──────────────────────────────────────────┼──────────┘
                                           │
                                  ┌────────┴─────────┐
                                  │                  │
                           in-process            relay
                       (in-page agent)      (external agent
                                            via Reverb / WS)
```

- **`MicroMcpServer`** is a transport-agnostic JSON-RPC 2.0 / MCP protocol handler. Register tools, attach transports, done.
- **`InProcessTransport`** wires an in-page agent (e.g. an embedded Claude widget) to the server with zero serialization.
- **`RelayTransport`** wraps any JSON duplex channel (Reverb whisper, WebRTC data channel, SSE+POST tunnel) so external agents can reach the browser session.
- **Bridges** install a cohesive set of MCP tools against a host's controlled state. v0.1 ships the whiteboard bridge with the full tool kit.
- **UI components** (`AgentPanel`, `AgentCursor`, `AgentActivityHighlight`) make agent presence visible.

## Quick start (in-page agent + whiteboard)

```tsx
import {
  MicroMcpServer,
  attachInProcess,
  registerWhiteboardBridge,
  AgentPanel,
  AgentCursor,
  type AgentActivity,
} from "@particle-academy/agent-integrations";
import "@particle-academy/agent-integrations/styles.css";

function MyBoard() {
  const [notes, setNotes] = useState([]);
  const [shapes, setShapes] = useState([]);
  const [connectors, setConnectors] = useState([]);
  const [strokes, setStrokes] = useState([]);
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [agentCursor, setAgentCursor] = useState(null);
  const [activity, setActivity] = useState<AgentActivity[]>([]);

  const serverRef = useRef<MicroMcpServer>();
  const transportRef = useRef<InProcessTransport>();

  useEffect(() => {
    const server = new MicroMcpServer({
      info: { name: "whiteboard-session", version: "0.1.0" },
    });
    const bridge = registerWhiteboardBridge(server, {
      adapter: {
        getNotes: () => notes, setNotes,
        getShapes: () => shapes, setShapes,
        getConnectors: () => connectors, setConnectors,
        getStrokes: () => strokes, setStrokes,
        getViewport: () => viewport, setViewport,
        setAgentCursor,
      },
    });
    const transport = attachInProcess(server);
    serverRef.current = server;
    transportRef.current = transport;
    return () => bridge.dispose();
  }, []);

  // ... render board, AgentPanel, AgentCursor when agentCursor is non-null ...
}
```

For an end-to-end runnable, see the sandbox demo at `/whiteboard-agent` (added in a follow-up PR).

## External agent via relay

The relay is host-implemented — this package only defines the JSON envelope. See `docs/relay-protocol.md`.

Pattern (Reverb):

```ts
const channel = Echo.private(`agent.session.${id}`);
const transport = attachRelay(server, {
  sendToRemote: (frame) => channel.whisper("mcp", frame),
});
channel.listenForWhisper("mcp", (frame) => transport.deliverFromRemote(frame));
```

Agents (Claude Desktop, Cline, custom) connect to the same channel via your auth bridge.

## Tools shipped (whiteboard bridge)

| Tool | Purpose |
|---|---|
| `whiteboard_get_state` | Full snapshot |
| `whiteboard_list_items` | Summary of every item |
| `whiteboard_get_item` | Detail by id |
| `whiteboard_add_sticky` / `_update_sticky` | Sticky CRUD |
| `whiteboard_add_shape` / `_update_shape` | Full shape kit (rect, rounded-rect, ellipse, diamond, triangle, line, arrow, text) |
| `whiteboard_add_connector` | Connect two items / points |
| `whiteboard_add_stroke` | Pen layer |
| `whiteboard_delete_item` | Generic delete |
| `whiteboard_set_viewport` | Pan / zoom |
| `whiteboard_set_agent_cursor` | Move presence |

## Status

`v0.1` — protocol + whiteboard bridge + UI. APIs will evolve before `v1`.

## License

MIT
