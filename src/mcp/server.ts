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
  private notifyListChangedScheduled = false;

  readonly info: ServerInfo;
  readonly capabilities: ServerCapabilities;
  readonly instructions?: string;

  constructor(options: McpServerOptions) {
    super();
    this.info = options.info;
    this.capabilities = options.capabilities ?? { tools: { listChanged: true } };
    this.instructions = options.instructions;
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
          protocolVersion: MCP_PROTOCOL_VERSION,
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
          throw rpcError(JSONRPC_METHOD_NOT_FOUND, `Unknown tool: ${name}`);
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

  private scheduleListChangedNotification(): void {
    if (this.notifyListChangedScheduled) return;
    this.notifyListChangedScheduled = true;
    queueMicrotask(() => {
      this.notifyListChangedScheduled = false;
      this.broadcast({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
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
