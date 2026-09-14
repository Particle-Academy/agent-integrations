import {
  type CallToolResult,
  type JsonObject,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcId,
  type RegisteredTool,
  type ServerCapabilities,
  type ServerInfo,
  type ToolDefinition,
  type ToolHandler,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_METHOD_NOT_FOUND,
  MCP_PROTOCOL_VERSION,
} from "./types";
import { ToolRegistry } from "./tool-host";

export type McpServerOptions = {
  info: ServerInfo;
  /** Defaults to { tools: { listChanged: true } } */
  capabilities?: ServerCapabilities;
  /** Free-text instructions surfaced to clients during initialize. */
  instructions?: string;
  /**
   * The protocol revisions this server speaks, NEWEST FIRST.
   *
   * `initialize` echoes the client's requested revision when it is in this
   * list, and answers the first entry otherwise — the spec's rule, which leaves
   * the client to decide whether it can live with the answer.
   *
   * Defaults to `[MCP_PROTOCOL_VERSION]`: one revision, answered whatever the
   * client asks, which is exactly what this server did before the option
   * existed. Only list a revision the tools you register are correct under.
   */
  protocolVersions?: readonly string[];
};

export type Transport = {
  /** Called by the server when it has a message to deliver to the client. */
  send: (message: JsonRpcMessage) => void;
  /** Called by the server when it's torn down so the transport can clean up. */
  close?: () => void;
};

/**
 * MicroMcpServer — protocol-level MCP server, transport-agnostic.
 *
 * Use it like:
 *
 *   const server = new MicroMcpServer({ info: { name: "session", version: "0.1" } });
 *   server.registerTool({ name: "...", inputSchema: { type: "object" } }, async (args) => ({...}));
 *   const transport = new InProcessTransport();
 *   server.attach(transport);
 *   transport.deliver({ ... }); // client → server frames
 *
 * The same server can serve multiple transports (e.g. an in-process agent
 * AND a relayed external client) by attaching each one.
 */
export class MicroMcpServer extends ToolRegistry {
  private transports = new Set<Transport>();
  /**
   * Transports owed a `tools/list_changed` at the end of this tick. Empty when
   * none is scheduled. See {@link scheduleListChangedNotification}.
   */
  private listChangedOwed = new Set<Transport>();

  readonly info: ServerInfo;
  readonly capabilities: ServerCapabilities;
  readonly instructions?: string;
  readonly protocolVersions: readonly string[];

  constructor(options: McpServerOptions) {
    super();
    this.info = options.info;
    this.capabilities = options.capabilities ?? { tools: { listChanged: true } };
    this.instructions = options.instructions;
    if (options.protocolVersions && options.protocolVersions.length === 0) {
      // No answer exists for a client's initialize. Fail here, next to the
      // mistake, rather than in a handshake nobody is watching.
      throw new Error("MicroMcpServer: protocolVersions is empty — a server must speak at least one protocol revision.");
    }
    this.protocolVersions = options.protocolVersions ? [...options.protocolVersions] : [MCP_PROTOCOL_VERSION];
  }

  attach(transport: Transport): () => void {
    this.transports.add(transport);
    return () => this.detach(transport);
  }

  detach(transport: Transport): void {
    if (this.transports.delete(transport)) {
      transport.close?.();
    }
  }

  unregisterTool(name: string): void {
    if (this.tools.delete(name)) {
      this.scheduleListChangedNotification();
    }
  }

  protected onToolsChanged(): void {
    this.scheduleListChangedNotification();
  }

  /**
   * Receive a JSON-RPC frame from a client (called by the transport).
   * The transport is responsible for sending the response back.
   */
  async receive(transport: Transport, message: JsonRpcMessage): Promise<void> {
    if (!("method" in message)) return; // It's a response, not a request — ignore.

    const isNotification = !("id" in message);
    if (isNotification) {
      // Notifications are fire-and-forget. We ignore unknown methods.
      return;
    }

    const request = message as JsonRpcRequest;
    try {
      const result = await this.handle(request, transport);
      transport.send({ jsonrpc: "2.0", id: request.id, result });
    } catch (err) {
      transport.send({
        jsonrpc: "2.0",
        id: request.id,
        error: this.toRpcError(err),
      });
    }
  }

  private async handle(request: JsonRpcRequest, transport: Transport): Promise<any> {
    const { method, params } = request;
    switch (method) {
      case "initialize":
        return {
          protocolVersion: this.negotiate(params?.protocolVersion),
          capabilities: this.capabilities,
          serverInfo: this.info,
          ...(this.instructions ? { instructions: this.instructions } : {}),
        };

      case "tools/list":
        return { tools: this.listTools() };

      case "tools/call": {
        const name = params?.name;
        const args = (params?.arguments ?? {}) as JsonObject;
        if (typeof name !== "string") {
          throw rpcError(JSONRPC_INVALID_PARAMS, "tools/call requires `name`");
        }
        const tool = this.tools.get(name);
        if (!tool) {
          throw rpcError(JSONRPC_METHOD_NOT_FOUND, this.missingToolMessage(name));
        }
        const result = await tool.handler(args, { transport });
        return result satisfies CallToolResult;
      }

      case "ping":
        return {};

      default:
        throw rpcError(JSONRPC_METHOD_NOT_FOUND, `Unsupported method: ${method}`);
    }
  }

  /** The revision to answer `initialize` with: the one asked for if spoken, else the newest. */
  private negotiate(requested: unknown): string {
    return typeof requested === "string" && this.protocolVersions.includes(requested)
      ? requested
      : this.protocolVersions[0];
  }

  /**
   * Tell the transports that SAW the old tool list that it changed.
   *
   * Changes in one tick coalesce into one notification. The recipients are the
   * transports attached at the moment of a change, not at the moment the
   * notification goes out: a transport attached afterwards never had the old
   * list, so "your list is stale" is noise to it — and on stdio, where a host
   * builds the server and attaches stdin/stdout in the same tick, it was the
   * first frame a client received, before it had even sent `initialize`.
   */
  private scheduleListChangedNotification(): void {
    if (this.transports.size === 0) return;
    const scheduled = this.listChangedOwed.size > 0;
    for (const t of this.transports) this.listChangedOwed.add(t);
    if (scheduled) return;
    queueMicrotask(() => {
      const owed = this.listChangedOwed;
      this.listChangedOwed = new Set();
      for (const t of owed) {
        // Detached since the change: it is not listening any more.
        if (this.transports.has(t)) t.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      }
    });
  }

  /** Send an application notification to every client, or one attached transport. */
  notify(message: JsonRpcMessage, transport?: Transport): void {
    if (transport) transport.send(message);
    else this.broadcast(message);
  }

  private broadcast(message: JsonRpcMessage): void {
    for (const t of this.transports) t.send(message);
  }

  private toRpcError(err: unknown): { code: number; message: string; data?: any } {
    if (err && typeof err === "object" && "code" in err && "message" in err) {
      return err as any;
    }
    return {
      code: JSONRPC_INTERNAL_ERROR,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function rpcError(code: number, message: string, data?: any) {
  return { code, message, ...(data !== undefined ? { data } : {}) };
}

/**
 * Helper to build a CallToolResult from a string or structured value.
 */
export function textResult(text: string, structured?: any): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structured !== undefined ? { structuredContent: structured } : {}),
  };
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// Internal helper so the JsonRpcId import isn't dropped by tsup
type _KeepIdImport = JsonRpcId;
