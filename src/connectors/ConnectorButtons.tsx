import { type CSSProperties, type ReactNode, useId, useState } from "react";
import {
  CLAUDE_CONNECTORS_URL,
  CONNECTOR_TARGETS,
  type ConnectorClient,
  type ConnectorServer,
  buildManualConfigSnippet,
  connectorHref,
} from "./targets";
import { CONNECTOR_GLYPHS } from "./glyphs";

export interface ConnectorButtonsProps {
  /** Human-readable server name, e.g. `"Decksmith"`. */
  serverName: string;
  /** The remote MCP endpoint, e.g. `"https://decksmith.dev/mcp"`. */
  mcpUrl: string;
  /**
   * Which client buttons to render, in order. Defaults to
   * `["claude-web", "cursor", "vscode", "manual"]` — plus `"claude-desktop"`
   * when {@link mcpbDownloadUrl} is set. A `"claude-desktop"` entry with no
   * `mcpbDownloadUrl` is skipped (there's nothing to download).
   */
  clients?: ConnectorClient[];
  /** URL of a prebuilt `.mcpb` bundle; enables the Claude Desktop button. */
  mcpbDownloadUrl?: string;
  /** Override Claude's Connectors page (it has moved before). */
  claudeConnectorsUrl?: string;
  /** Target VS Code Insiders instead of stable. */
  vscodeInsiders?: boolean;
  /** Fired when a value is copied to the clipboard (URL or snippet). */
  onCopy?: (target: ConnectorClient) => void;
  /** Fired when any button is activated (after its side effect). */
  onAction?: (target: ConnectorClient) => void;
  /** Per-client label override. */
  labels?: Partial<Record<ConnectorClient, ReactNode>>;
  className?: string;
  style?: CSSProperties;
}

const DEFAULT_CLIENTS: ConnectorClient[] = [
  "claude-web",
  "cursor",
  "vscode",
  "manual",
];

/**
 * Per-client "Add to <host>" buttons for a remote MCP server, each with the
 * right (and subtly different) install behavior baked in — see {@link
 * ./targets}. Brand glyphs, copy/feedback states, and the manual-config popover
 * are owned here so a consumer just passes a name + URL.
 *
 * Needs the package stylesheet for its default look:
 * `import "@particle-academy/agent-integrations/styles.css"`.
 */
export function ConnectorButtons({
  serverName,
  mcpUrl,
  clients,
  mcpbDownloadUrl,
  claudeConnectorsUrl = CLAUDE_CONNECTORS_URL,
  vscodeInsiders,
  onCopy,
  onAction,
  labels,
  className,
  style,
}: ConnectorButtonsProps) {
  const server: ConnectorServer = { name: serverName, url: mcpUrl };
  const [copied, setCopied] = useState<ConnectorClient | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const manualId = useId();

  const list = (clients ?? defaultClients(mcpbDownloadUrl)).filter((c) =>
    c === "claude-desktop" ? !!mcpbDownloadUrl : true,
  );

  const flashCopied = (target: ConnectorClient) => {
    setCopied(target);
    window.setTimeout(() => setCopied((c) => (c === target ? null : c)), 2000);
  };

  const copy = async (value: string, target: ConnectorClient) => {
    try {
      await navigator.clipboard?.writeText(value);
      flashCopied(target);
      onCopy?.(target);
    } catch {
      /* clipboard blocked — the popover/URL is still visible */
    }
  };

  const labelFor = (c: ConnectorClient): ReactNode =>
    labels?.[c] ?? CONNECTOR_TARGETS[c].label;

  return (
    <div
      className={["fai-connect", className].filter(Boolean).join(" ")}
      style={style}
    >
      {list.map((client) => {
        const meta = CONNECTOR_TARGETS[client];
        const Glyph = CONNECTOR_GLYPHS[client];
        const base = `fai-connect__btn fai-connect__btn--${client}`;

        // Deeplink clients (cursor / vscode) are plain navigations.
        const href = connectorHref(client, server, { insiders: vscodeInsiders });
        if (href) {
          return (
            <a
              key={client}
              href={href}
              className={base}
              title={meta.hint}
              onClick={() => onAction?.(client)}
            >
              <Glyph className="fai-connect__glyph" />
              {labelFor(client)}
            </a>
          );
        }

        if (client === "claude-desktop") {
          return (
            <a
              key={client}
              href={mcpbDownloadUrl}
              download
              className={base}
              title={meta.hint}
              onClick={() => onAction?.(client)}
            >
              <Glyph className="fai-connect__glyph" />
              {labelFor(client)}
            </a>
          );
        }

        if (client === "claude-web") {
          return (
            <button
              key={client}
              type="button"
              className={base}
              title={meta.hint}
              onClick={() => {
                void copy(mcpUrl, client);
                window.open(
                  claudeConnectorsUrl,
                  "_blank",
                  "noopener,noreferrer",
                );
                onAction?.(client);
              }}
            >
              <Glyph className="fai-connect__glyph" />
              {copied === client ? "Copied — paste in Claude" : labelFor(client)}
            </button>
          );
        }

        // manual
        return (
          <div key={client} className="fai-connect__manual-wrap">
            <button
              type="button"
              className={base}
              title={meta.hint}
              aria-expanded={manualOpen}
              aria-controls={manualId}
              onClick={() => {
                setManualOpen((o) => !o);
                onAction?.(client);
              }}
            >
              <Glyph className="fai-connect__glyph" />
              {labelFor(client)}
            </button>
            {manualOpen && (
              <ManualPopover
                id={manualId}
                snippet={buildManualConfigSnippet(server)}
                copied={copied === client}
                onCopy={() => copy(buildManualConfigSnippet(server), client)}
                onClose={() => setManualOpen(false)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function defaultClients(mcpbDownloadUrl?: string): ConnectorClient[] {
  return mcpbDownloadUrl
    ? ["claude-web", "claude-desktop", "cursor", "vscode", "manual"]
    : DEFAULT_CLIENTS;
}

function ManualPopover({
  id,
  snippet,
  copied,
  onCopy,
  onClose,
}: {
  id: string;
  snippet: string;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}) {
  return (
    <div id={id} className="fai-connect__popover" role="dialog">
      <div className="fai-connect__popover-head">
        <span>Add to any stdio MCP client</span>
        <button
          type="button"
          className="fai-connect__popover-close"
          aria-label="Close"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="fai-connect__popover-hint">
        Paste into <code>claude_desktop_config.json</code> (or any stdio MCP
        client config). Needs Node 18+.
      </p>
      <pre className="fai-connect__snippet">{snippet}</pre>
      <button type="button" className="fai-connect__copy-btn" onClick={onCopy}>
        {copied ? "Copied" : "Copy snippet"}
      </button>
    </div>
  );
}
