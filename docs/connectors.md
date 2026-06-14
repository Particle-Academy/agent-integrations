# Connector builder — per-client MCP install artifacts

Every app that exposes an MCP server has to ship "Add to Claude / Cursor / VS
Code" affordances and (for Claude Desktop) a `.mcpb` bundle. Each host wants the
server handed to it differently, and each format is subtly wrong the first time.
This module is the single source of truth for those formats — a runtime React
component plus a build-time `.mcpb` helper.

```ts
import {
  ConnectorButtons,                 // React buttons
  buildCursorDeeplink,              // pure builders
  buildVscodeDeeplink,
  buildManualConfigSnippet,
} from "@particle-academy/agent-integrations";

import { writeMcpbBundle } from "@particle-academy/agent-integrations/connectors/build"; // Node only
```

## What each client actually needs

| Client | Mechanism | Notes |
|---|---|---|
| `claude-web` | **copy URL + open** the Connectors page | Claude has **no install deeplink** (web or Desktop). Best a button can do is copy the URL and open `claude.ai/settings/connectors` for a manual "Add custom connector". |
| `claude-desktop` | **download a `.mcpb`** | The only double-click path. Build it with `writeMcpbBundle` (below). |
| `cursor` | **deeplink** | `cursor://anysphere.cursor-deeplink/mcp/install?name=&config=<base64>` — base64 of `{"url":"…"}` for an HTTP server (no `type`/`transport`). |
| `vscode` | **deeplink** | `vscode://mcp/install?<urlencoded-json>` — URL-encoded JSON `{name,url}` (NOT base64; different from Cursor). |
| `manual` | **JSON snippet** | A `claude_desktop_config.json` entry wrapping the URL with `npx -y mcp-remote <url>` (stdio clients can't take an HTTP URL). |

## Runtime — `<ConnectorButtons>`

```tsx
import { ConnectorButtons } from "@particle-academy/agent-integrations";
import "@particle-academy/agent-integrations/styles.css";

<ConnectorButtons
  serverName="Decksmith"
  mcpUrl="https://decksmith.dev/mcp"
  mcpbDownloadUrl="/decksmith.mcpb"   // optional — enables the Claude Desktop button
  onCopy={(target) => toast(`Copied — paste in ${target}`)}
/>
```

The component owns brand glyphs, copy/feedback states, and the manual-config
popover. Customize which buttons render and their labels:

```tsx
<ConnectorButtons
  serverName="Decksmith"
  mcpUrl="https://decksmith.dev/mcp"
  clients={["cursor", "vscode", "manual"]}
  labels={{ cursor: "Open in Cursor" }}
  vscodeInsiders
  claudeConnectorsUrl="https://claude.ai/settings/connectors"
/>
```

`clients` defaults to `["claude-web", "cursor", "vscode", "manual"]`, plus
`"claude-desktop"` when `mcpbDownloadUrl` is set. A `"claude-desktop"` entry with
no bundle URL is skipped.

### Just want the URLs?

The builders are pure and framework-agnostic — render your own buttons:

```ts
import {
  buildCursorDeeplink,
  buildVscodeDeeplink,
  buildManualConfigSnippet,
  CLAUDE_CONNECTORS_URL,
} from "@particle-academy/agent-integrations";

const server = { name: "Decksmith", url: "https://decksmith.dev/mcp" };
buildCursorDeeplink(server);        // cursor://…
buildVscodeDeeplink(server);        // vscode://…
buildManualConfigSnippet(server);   // claude_desktop_config.json JSON
```

## Build — `writeMcpbBundle()`

`.mcpb` (Claude Desktop Extensions) is **stdio-only** — there is no
`type: "http"`. To bundle a remote server you ship a thin `node` proxy whose
`mcp_config` runs `npx -y mcp-remote <url>`. This helper writes the manifest +
the (validator-required) proxy stub and packs them with the official
`@anthropic-ai/mcpb` CLI.

```ts
// scripts/build-mcpb.mjs — run at build time (needs Node 18+)
import { writeMcpbBundle } from "@particle-academy/agent-integrations/connectors/build";

await writeMcpbBundle({
  outFile: "public/decksmith.mcpb",
  manifest: {
    name: "decksmith",
    display_name: "Decksmith",
    version: "0.2.0",
    description: "Agent-driven slide deck builder.",
    author: { name: "Particle Academy", url: "https://decksmith.dev" },
    mcpUrl: "https://decksmith.dev/mcp",
    tools: [{ name: "start_session", description: "Lock onto a deck." }],
  },
});
```

Options: `mcpbBin` (override the default `npx -y @anthropic-ai/mcpb`, e.g. a
locally installed binary), `validate` (default `true`), `keepWorkDir`, `cwd`.

> **Future-proof.** When MCPB grows a real `type: "http"`, drop the proxy and
> point the manifest straight at the URL — your call site here doesn't change.

## Caveats baked in

- The `.mcpb` route needs **Node 18+** on the end user's machine (for `npx` /
  `mcp-remote`) and adds a process hop Claude → node → mcp-remote → server.
- Claude's "one-click install via URL" does not exist; don't promise it.
- OAuth-protected remote servers (Claude Desktop's callback at
  `claude.ai/api/mcp/auth_callback`) aren't handled yet — room left for it.
