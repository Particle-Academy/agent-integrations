// Per-client MCP "install" affordances — the single source of truth for the
// subtly-different way each MCP host wants a remote server handed to it.
//
// These are PURE, framework-agnostic builders (no React, no DOM): a host can
// call them to render its own buttons, and <ConnectorButtons> is a thin UI
// over them. Every quirk below is a real one rediscovered the hard way:
//
//   - Claude has NO install deeplink (web or Desktop). The best a button can do
//     is copy the URL and open the Connectors page for a manual paste; a
//     `.mcpb` bundle is the only "double-click" path (Desktop only).
//   - Cursor's deeplink wants base64-encoded JSON; for an HTTP server the
//     payload is just `{"url":"..."}` — no `type`, no `transport`.
//   - VS Code wants URL-ENCODED JSON (not base64), a different scheme handler.
//   - The manual path is a `claude_desktop_config.json` snippet that wraps the
//     remote URL with `npx -y mcp-remote` (MCPB/stdio can't take an HTTP URL).

/** The MCP hosts we know how to generate an install affordance for. */
export type ConnectorClient =
  | "claude-web"
  | "claude-desktop"
  | "cursor"
  | "vscode"
  | "manual";

/** A remote MCP server to generate install artifacts for. */
export interface ConnectorServer {
  /** Human-readable server name, e.g. `"Decksmith"`. */
  name: string;
  /** The remote MCP endpoint, e.g. `"https://decksmith.dev/mcp"`. */
  url: string;
}

/**
 * Claude's Connectors page — the manual "Add custom connector" flow.
 *
 * Claude exposes no install deeplink, so a button can only copy the URL and
 * open this page for a paste. Override per-app if Claude moves it (it has
 * historically lived at both `/settings/connectors` and `/customize/connectors`).
 */
export const CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors";

/** Base64-encode a JSON value, working in both the browser and Node. */
export function encodeBase64Json(value: unknown): string {
  const json = JSON.stringify(value);
  if (typeof btoa === "function") {
    // utf8-safe: collapse multibyte → latin1 before btoa. For ASCII (URLs) this
    // is a no-op and matches a plain `btoa(JSON.stringify(...))`.
    return btoa(unescape(encodeURIComponent(json)));
  }
  // Node without a global btoa.
  return Buffer.from(json, "utf8").toString("base64");
}

/**
 * Cursor install deeplink for a remote (HTTP) MCP server.
 *
 * `cursor://anysphere.cursor-deeplink/mcp/install?name=<name>&config=<base64>`,
 * where `config` is base64 of `{"url":"<mcpUrl>"}` — the HTTP shape, with no
 * `type`/`transport` keys (those are for the stdio examples in the docs). The
 * base64 is intentionally NOT percent-encoded, matching Cursor's own install
 * links. Docs: https://cursor.com/docs/context/mcp/install-links
 */
export function buildCursorDeeplink(server: ConnectorServer): string {
  const config = encodeBase64Json({ url: server.url });
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(
    server.name,
  )}&config=${config}`;
}

/**
 * VS Code install deeplink for a remote (HTTP) MCP server.
 *
 * `vscode://mcp/install?<urlencoded-json>` — URL-ENCODED JSON (not base64), the
 * opposite encoding from Cursor and an easy one to mix up. The payload is
 * `{ "name", "url" }`; for VS Code Insiders pass `{ insiders: true }`.
 */
export function buildVscodeDeeplink(
  server: ConnectorServer,
  opts: { insiders?: boolean } = {},
): string {
  const scheme = opts.insiders ? "vscode-insiders" : "vscode";
  const payload = encodeURIComponent(
    JSON.stringify({ name: server.name, url: server.url }),
  );
  return `${scheme}://mcp/install?${payload}`;
}

/** A normalized server key for a config file (`My App` → `my-app`). */
export function slugifyServerName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "mcp-server";
}

/** The `claude_desktop_config.json` object for a manual install. */
export interface ManualMcpConfig {
  mcpServers: Record<string, { command: string; args: string[] }>;
}

/**
 * The `claude_desktop_config.json` (or any stdio MCP client config) entry for a
 * remote server, wrapping it with `npx -y mcp-remote <url>` — the standard
 * stdio→HTTP bridge, since stdio clients can't take an HTTP URL directly.
 * Requires Node 18+ on the user's machine.
 */
export function buildManualConfig(server: ConnectorServer): ManualMcpConfig {
  return {
    mcpServers: {
      [slugifyServerName(server.name)]: {
        command: "npx",
        args: ["-y", "mcp-remote", server.url],
      },
    },
  };
}

/** Pretty-printed JSON snippet of {@link buildManualConfig}, for a copy box. */
export function buildManualConfigSnippet(server: ConnectorServer): string {
  return JSON.stringify(buildManualConfig(server), null, 2);
}

/** How a given client's button behaves — drives the default UI. */
export type ConnectorMechanism =
  | "copy-open" // copy URL + open a web page (claude-web)
  | "download" // download a .mcpb bundle (claude-desktop)
  | "deeplink" // navigate to a custom-scheme URL (cursor / vscode)
  | "snippet"; // reveal a copy-paste JSON snippet (manual)

/** Display metadata for a client, so consumers don't redraw the marks. */
export interface ConnectorTargetMeta {
  id: ConnectorClient;
  /** Default button label. */
  label: string;
  mechanism: ConnectorMechanism;
  /** One-line tooltip explaining what the button does. */
  hint: string;
}

export const CONNECTOR_TARGETS: Record<ConnectorClient, ConnectorTargetMeta> = {
  "claude-web": {
    id: "claude-web",
    label: "Add to Claude",
    mechanism: "copy-open",
    hint: "Copy the MCP URL and open Claude's Connectors page — click 'Add custom connector' and paste.",
  },
  "claude-desktop": {
    id: "claude-desktop",
    label: "Claude Desktop",
    mechanism: "download",
    hint: "Download a .mcpb bundle and double-click it to install in Claude Desktop.",
  },
  cursor: {
    id: "cursor",
    label: "Add to Cursor",
    mechanism: "deeplink",
    hint: "Open Cursor with this MCP server pre-filled — confirm to install.",
  },
  vscode: {
    id: "vscode",
    label: "Add to VS Code",
    mechanism: "deeplink",
    hint: "Open VS Code with this MCP server pre-filled — confirm to install.",
  },
  manual: {
    id: "manual",
    label: "Manual setup",
    mechanism: "snippet",
    hint: "Show a config snippet to paste into any stdio MCP client.",
  },
};

/**
 * Resolve the navigable href for a deeplink client (cursor / vscode), or null
 * for clients whose mechanism isn't a plain navigation.
 */
export function connectorHref(
  client: ConnectorClient,
  server: ConnectorServer,
  opts: { insiders?: boolean } = {},
): string | null {
  switch (client) {
    case "cursor":
      return buildCursorDeeplink(server);
    case "vscode":
      return buildVscodeDeeplink(server, opts);
    default:
      return null;
  }
}
