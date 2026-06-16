import { type CSSProperties, useState } from "react";
import type { SessionDescriptor } from "../../sharing/token";
import { buildShareConfig, buildShareUrl } from "../../sharing/token";

export type ShareControlsProps = {
  /** The active session, or null when not sharing yet. */
  session: SessionDescriptor | null;
  onStart: () => void;
  onStop: () => void;
  /** Optional connection-state badge text. */
  status?: string;
  /** Override the URL base used in the share URL. */
  shareBaseUrl?: string;
  className?: string;
  style?: CSSProperties;
};

type Tab = "prompt" | "url" | "json" | "curl";

/**
 * ShareControls — the host-facing UI for turning sharing on/off and
 * surfacing the resulting connection details (URL / JSON / cURL).
 */
export function ShareControls({
  session,
  onStart,
  onStop,
  status,
  shareBaseUrl,
  className,
  style,
}: ShareControlsProps) {
  const [tab, setTab] = useState<Tab>("prompt");

  if (!session) {
    return (
      <div className={["fai-share fai-share--idle", className ?? ""].filter(Boolean).join(" ")} style={style}>
        <button type="button" className="fai-share__start" onClick={onStart}>
          Start shared session
        </button>
        <p className="fai-share__hint">
          Generates a session id + secret token. Hand the <strong>Agent prompt</strong> to an AI agent, share the URL with humans, or give the JSON config to an MCP-capable client.
        </p>
      </div>
    );
  }

  const url = buildShareUrl(session, shareBaseUrl);
  const config = buildShareConfig(session);
  const curl = buildCurlRecipe(session);
  const prompt = buildAgentPrompt(url);

  return (
    <div className={["fai-share fai-share--active", className ?? ""].filter(Boolean).join(" ")} style={style}>
      <div className="fai-share__header">
        <div>
          <strong>Sharing</strong>
          <span className="fai-share__id">
            session <code>{session.id}</code> · token <code>{session.display}…</code>
          </span>
        </div>
        <div className="fai-share__header-actions">
          {status && <span className="fai-share__status">{status}</span>}
          <button type="button" className="fai-share__stop" onClick={onStop}>
            Stop
          </button>
        </div>
      </div>

      <div className="fai-share__tabs" role="tablist">
        <TabButton tab="prompt" active={tab} setTab={setTab}>Agent prompt</TabButton>
        <TabButton tab="url" active={tab} setTab={setTab}>URL</TabButton>
        <TabButton tab="json" active={tab} setTab={setTab}>JSON</TabButton>
        <TabButton tab="curl" active={tab} setTab={setTab}>cURL recipe</TabButton>
      </div>

      <div className="fai-share__panel">
        {tab === "prompt" && (
          <CopyBox
            label="Paste this straight into an AI agent — it connects over MCP, no browser"
            value={prompt}
            multiline
          />
        )}
        {tab === "url" && <CopyBox label="Open this URL in another tab to join the session" value={url} />}
        {tab === "json" && (
          <CopyBox
            label="Paste into Claude Desktop / Cline MCP server config"
            value={JSON.stringify(config, null, 2)}
          />
        )}
        {tab === "curl" && (
          <CopyBox
            label="Connect from a terminal (verifies the relay is reachable)"
            value={curl}
            multiline
          />
        )}
      </div>
    </div>
  );
}

function TabButton({ tab, active, setTab, children }: { tab: Tab; active: Tab; setTab: (t: Tab) => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={tab === active}
      className={`fai-share__tab${tab === active ? " is-active" : ""}`}
      onClick={() => setTab(tab)}
    >
      {children}
    </button>
  );
}

function CopyBox({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };
  return (
    <div>
      <div className="fai-share__panel-label">{label}</div>
      <div className="fai-share__copy">
        <pre className={`fai-share__pre${multiline ? " is-multi" : ""}`}>{value}</pre>
        <button type="button" className="fai-share__copy-btn" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/**
 * Build a copy-paste natural-language prompt to hand directly to an AI agent.
 * Agents handed a bare URL tend to try to *open it in a browser* — this spells
 * out that the link is a live MCP co-browsing session it should drive over MCP
 * tools (via the zero-install relay client), never visit.
 */
export function buildAgentPrompt(url: string): string {
  return [
    `You're joining a live Human+ co-browsing session on a web app. This is an MCP`,
    `(Model Context Protocol) session — NOT a website to visit. Do NOT open the URL`,
    `in a browser and do NOT use any browser/Playwright tool. You drive the real,`,
    `running app through MCP tools while a human watches and can take over.`,
    ``,
    `Session link (carries the session id + token — treat it as a secret):`,
    `  ${url}`,
    ``,
    `Connect by running the relay client as an MCP server (zero install):`,
    `  npx -y mcp-relay-client "${url}"`,
    ``,
    `That exposes the app's own tools (e.g. page_describe, page_read, nav_visit,`,
    `page_click, page_set_field, page_submit, plus surface tools like whiteboard_*).`,
    `Then:`,
    `  1. Call page_describe first to see the current page and its interactive handles.`,
    `  2. Act only on the STABLE HANDLES the tools return — never guess DOM selectors.`,
    `  3. Navigate with nav_visit, type with page_set_field, click with page_click.`,
    `     Submits and destructive clicks are staged for the human to confirm.`,
    ``,
    `If you can't register an MCP server but can run a shell, drive it directly:`,
    `  curl -O https://raw.githubusercontent.com/Particle-Academy/mcp-relay-client/main/connect.sh`,
    `  bash connect.sh "${url}" tools`,
    `  bash connect.sh "${url}" call page_describe '{}'`,
  ].join("\n");
}

/** Build a copy-paste cURL recipe for connecting an external MCP client. */
function buildCurlRecipe(session: SessionDescriptor): string {
  const base =
    typeof window !== "undefined"
      ? `${window.location.protocol}//${window.location.host}`
      : "http://localhost";
  const inbox = `${base}/agent-relay/${session.id}/inbox?token=${session.token}`;
  const events = `${base}/agent-relay/${session.id}/events?token=${session.token}`;
  return [
    `# 1) In one terminal, subscribe to server-pushed frames (SSE)`,
    `curl -N "${events}"`,
    ``,
    `# 2) In another terminal, send an initialize handshake`,
    `curl -X POST "${inbox}" \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'`,
    ``,
    `# 3) List the tools the bridge exposes`,
    `curl -X POST "${inbox}" \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'`,
    ``,
    `# 4) Add a sticky note`,
    `curl -X POST "${inbox}" \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whiteboard_add_sticky","arguments":{"x":300,"y":300,"text":"hello from curl"}}}'`,
  ].join("\n");
}
