import type { JsonRpcMessage } from "../types";
import type { MicroMcpServer, Transport } from "../server";

/**
 * RelayTransport — wraps any duplex JSON-frame channel (e.g. a Reverb
 * websocket private channel, a WebRTC data channel) so external agents
 * can talk to a browser-side MicroMcpServer.
 *
 * The host app owns the actual channel. This class only handles framing
 * (JSON.stringify / JSON.parse) and the server contract.
 *
 * Channel contract:
 *   - host calls `transport.deliverFromRemote(payload)` with each frame
 *     it receives from the remote agent
 *   - host implements `sendToRemote(frame)` so the transport can deliver
 *     server → client frames outward
 *
 * See docs/relay-protocol.md for the wire format.
 */
export type RelayChannel = {
  sendToRemote: (frame: JsonRpcMessage) => void;
  /** Optional: notify the channel that the server is gone. */
  onClose?: () => void;
};

export class RelayTransport implements Transport {
  private server?: MicroMcpServer;
  constructor(private channel: RelayChannel) {}

  bindServer(server: MicroMcpServer): void {
    this.server = server;
  }

  send(message: JsonRpcMessage): void {
    this.channel.sendToRemote(message);
  }

  /**
   * Host calls this with each frame received from the remote agent. Accepts
   * either a parsed object or a raw JSON string.
   */
  async deliverFromRemote(payload: JsonRpcMessage | string): Promise<void> {
    if (!this.server) throw new Error("RelayTransport has no bound server");
    const message = typeof payload === "string"
      ? (JSON.parse(payload) as JsonRpcMessage)
      : payload;
    await this.server.receive(this, message);
  }

  close(): void {
    this.channel.onClose?.();
  }
}

/**
 * Convenience wiring. Returns the bound transport.
 */
export function attachRelay(server: MicroMcpServer, channel: RelayChannel): RelayTransport {
  const transport = new RelayTransport(channel);
  transport.bindServer(server);
  server.attach(transport);
  return transport;
}
