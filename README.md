# @particle-academy/agent-integrations

[![Fancified](art/fancified.svg)](https://particle.academy)

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

## Tree-shake-safe imports

The root barrel is **core-only** — MCP server, presence, undo, sharing,
plus the bridges and components that don't depend on optional peer
packages (`fancy-sheets`, `fancy-forms`, `fancy-code`, `fancy-charts`,
`fancy-scene`, `fancy-screens`).

Bridges whose peer is optional (`fancy-whiteboard`, `fancy-flow`) and
the `SharedWhiteboard` component are reachable **only via subpath
imports** so a consumer that hasn't installed those peers bundles
cleanly:

```ts
// Core — always safe:
import {
  MicroMcpServer,
  attachInProcess,
  registerSheetsBridge,
  useSheetsAdapter,
  useSheetsActivityHighlights,
} from "@particle-academy/agent-integrations";

// Optional peers — subpath imports:
import { registerWhiteboardBridge } from "@particle-academy/agent-integrations/bridges/whiteboard";
import { registerFlowBridge }       from "@particle-academy/agent-integrations/bridges/flow";
import { SharedWhiteboard }         from "@particle-academy/agent-integrations/components/shared-whiteboard";
```

Every bridge has a matching subpath if you'd rather import surgically:

| Bridge              | Subpath                                                |
| ------------------- | ------------------------------------------------------ |
| whiteboard          | `…/bridges/whiteboard`                                 |
| flow                | `…/bridges/flow`                                       |
| sheets              | `…/bridges/sheets`                                     |
| forms               | `…/bridges/forms`                                      |
| code                | `…/bridges/code`                                       |
| charts              | `…/bridges/charts`                                     |
| scene               | `…/bridges/scene`                                      |
| screens             | `…/bridges/screens`                                    |
| sheets adapter hook | `…/sheets-adapter`                                     |
| presence            | `…/presence`                                           |
| undo                | `…/undo`                                               |
| sharing             | `…/sharing`                                            |

## When you don't need an MCP server

If your agent runs in the same JS process as the surfaces it drives (an embedded chat widget, an in-page worker, an SSR-time tool loop), you don't need any of MCP's JSON-RPC framing. Use **`ToolRegistry`** — a plain in-memory tool host that the bridges register against. Agents drive the surface with `host.callTool("sheet_set_cell", { … })` directly.

```ts
import {
  ToolRegistry,
  registerSheetsBridge,
  useSheetsAdapter,
} from "@particle-academy/agent-integrations";

const host = new ToolRegistry();
registerSheetsBridge(host, { adapter });

// in-process agent:
await host.callTool("sheet_set_cell", { address: "B3", value: 42 });
```

Need both? `MicroMcpServer` extends `ToolRegistry`, so the same instance serves direct in-process calls **and** SSE-relayed remote agents at the same time. Bridges accept either — every `register*Bridge(host, …)` signature takes a `ToolHost`.

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

External MCP agents (Claude Code, Cursor, Claude Desktop, custom clients)
reach a browser-hosted `MicroMcpServer` via a relay broker. The relay just
shuttles JSON-RPC frames — it doesn't run tools or hold state.

**Three ways to wire one up:**

- **`docs/agent-hookable-demos.md`** — full end-to-end workflow (browser →
  relay → external agent), including a complete drop-in **Laravel 10+**
  reference implementation (~200 LOC controller + routes + CSRF entry).
- **`docs/relay-server.md`** — the bundled Node relay (`agent-integrations-relay`
  bin, `createNodeRelay()` factory, Dockerfile). Use this when your site is
  not a Laravel/Rails/PHP app and you want a one-command deploy.
- **`docs/relay-protocol.md`** — the on-the-wire JSON envelope, with notes on
  the three transports the protocol supports (Reverb, WebRTC, SSE+POST).

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
