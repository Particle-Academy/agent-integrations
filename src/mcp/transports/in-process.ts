import type { JsonRpcMessage } from "../types";
import type { MicroMcpServer, Transport } from "../server";

/**
 * InProcessTransport — direct function-call wiring between an in-page MCP
 * client (e.g. an embedded chat agent) and a MicroMcpServer running in
 * the same JS context. No serialization, no network.
 *
 * Usage:
 *
 *   const t = new InProcessTransport();
 *   server.attach(t);
 *   t.onServerMessage((msg) => { ... });   // client subscribes
 *   t.send({ jsonrpc: "2.0", id: 1, method: "tools/list" }); // client → server
 */
export class InProcessTransport implements Transport {
  private server?: MicroMcpServer;
  private listeners = new Set<(msg: JsonRpcMessage) => void>();

  /** Bind to a server. Called from the client's setup, not directly. */
  bindServer(server: MicroMcpServer): void {
    this.server = server;
  }

  /** Server → client (delivered to subscribed listeners). */
  send(message: JsonRpcMessage): void {
    for (const l of this.listeners) l(message);
  }

  /** Client → server. Awaitable so callers can flush. */
  async deliver(message: JsonRpcMessage): Promise<void> {
    if (!this.server) throw new Error("InProcessTransport has no bound server");
    await this.server.receive(this, message);
  }

  /** Subscribe to messages the server pushes to this client. */
  onServerMessage(listener: (msg: JsonRpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
  }
}

/**
 * Convenience: create a server-attached in-process transport in one call.
 */
export function attachInProcess(server: MicroMcpServer): InProcessTransport {
  const transport = new InProcessTransport();
  transport.bindServer(server);
  server.attach(transport);
  return transport;
}
