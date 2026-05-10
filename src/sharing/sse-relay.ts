import type { JsonRpcMessage } from "../mcp/types";
import type { Transport } from "../mcp/server";
import type { MicroMcpServer } from "../mcp/server";
import { constantTimeEqual } from "./token";

/**
 * SseRelayTransport — bridges the in-page MicroMcpServer to a host-app
 * relay broker over Server-Sent Events (inbound) + POST (outbound).
 *
 * Wire model:
 *   - Browser opens an EventSource at `${baseUrl}/${sessionId}/events?token=…`.
 *     Each `event: mcp` carries one JSON-RPC frame from a remote client.
 *   - Browser POSTs JSON-RPC frames to `${baseUrl}/${sessionId}/outbox?token=…`
 *     when the local server has a response/notification to send.
 *
 * The host provides the relay endpoint (any HTTP server). See the demo
 * `WhiteboardShareController` for the reference implementation.
 *
 * Token authentication is the host's job — this transport just carries the
 * token in the query string. For lower-trust deployments, layer signing on
 * top by wrapping `send` / `deliverFromRemote`.
 */
export type SseRelayOptions = {
  baseUrl: string;
  sessionId: string;
  token: string;
  /** Override fetch (testing / non-browser). Defaults to global fetch. */
  fetch?: typeof fetch;
};

export class SseRelayTransport implements Transport {
  private server?: MicroMcpServer;
  private es?: EventSource;
  private opts: SseRelayOptions;
  private sendQueue: JsonRpcMessage[] = [];
  private connected = false;
  private listeners = new Set<(state: RelayState) => void>();
  private state: RelayState = "idle";
  private expectedToken: string;

  constructor(options: SseRelayOptions) {
    this.opts = options;
    this.expectedToken = options.token;
  }

  bindServer(server: MicroMcpServer): void {
    this.server = server;
  }

  /** Open the SSE channel. Idempotent. */
  start(): void {
    if (this.connected || typeof window === "undefined") return;
    const url = `${this.opts.baseUrl}/${encodeURIComponent(this.opts.sessionId)}/events?token=${encodeURIComponent(this.opts.token)}`;
    this.setState("connecting");
    const es = new EventSource(url, { withCredentials: false });
    this.es = es;

    es.addEventListener("open", () => {
      this.connected = true;
      this.setState("open");
      // Flush queued outbound frames (tool list_changed notifications, etc.)
      const queued = this.sendQueue.splice(0);
      for (const msg of queued) this.postOut(msg);
    });

    es.addEventListener("mcp", (ev: MessageEvent) => {
      const raw = ev.data;
      this.handleInbound(raw);
    });

    es.addEventListener("error", () => {
      this.setState("error");
      // EventSource auto-reconnects; no need to dispose.
    });
  }

  send(message: JsonRpcMessage): void {
    if (!this.connected) {
      this.sendQueue.push(message);
      return;
    }
    this.postOut(message);
  }

  close(): void {
    this.es?.close();
    this.es = undefined;
    this.connected = false;
    this.setState("closed");
  }

  onStateChange(listener: (state: RelayState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /**
   * For relays that wrap each frame with auth metadata: hosts can call this
   * directly when a frame arrives via a non-SSE path. The transport will
   * dispatch it to the bound server.
   */
  async deliverFromRemote(payload: JsonRpcMessage | string, token?: string): Promise<void> {
    if (token !== undefined && !constantTimeEqual(token, this.expectedToken)) return;
    if (!this.server) throw new Error("SseRelayTransport has no bound server");
    const message: JsonRpcMessage = typeof payload === "string" ? JSON.parse(payload) : payload;
    await this.server.receive(this, message);
  }

  private async postOut(message: JsonRpcMessage): Promise<void> {
    const url = `${this.opts.baseUrl}/${encodeURIComponent(this.opts.sessionId)}/outbox?token=${encodeURIComponent(this.opts.token)}`;
    const f = this.opts.fetch ?? fetch;
    try {
      await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify(message),
      });
    } catch {
      // Drop — relay errors are surfaced via state change separately.
    }
  }

  private async handleInbound(raw: string): Promise<void> {
    if (!this.server) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    await this.server.receive(this, message);
  }

  private setState(state: RelayState): void {
    this.state = state;
    for (const l of this.listeners) l(state);
  }
}

export type RelayState = "idle" | "connecting" | "open" | "closed" | "error";

export function attachSseRelay(server: MicroMcpServer, options: SseRelayOptions): SseRelayTransport {
  const transport = new SseRelayTransport(options);
  transport.bindServer(server);
  server.attach(transport);
  transport.start();

  // Forward in-process agent activity events out over the relay so external
  // subscribers can render presence indicators in real time. Uses a dynamic
  // import so the relay doesn't hard-depend on the presence module if it's
  // tree-shaken out.
  import("../presence/registry").then(({ onActivity }) => {
    const off = onActivity((event) => {
      transport.send({
        jsonrpc: "2.0",
        method: "notifications/agent_activity",
        params: event as any,
      });
    });
    // Tear down the subscription when the transport closes.
    const origClose = transport.close.bind(transport);
    transport.close = () => {
      off();
      origClose();
    };
  }).catch(() => {
    // Presence module unavailable — silently no-op (relay still works).
  });

  return transport;
}
