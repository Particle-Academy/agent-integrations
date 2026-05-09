/**
 * Minimal MCP (Model Context Protocol) types — covers the subset this
 * package implements: initialize, tools/list, tools/call, plus JSON-RPC.
 *
 * Aligned with the public MCP spec but trimmed to v0.1 needs. See
 * https://spec.modelcontextprotocol.io/ for the full surface.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export type JsonObject = { [key: string]: JsonValue };

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: JsonObject;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: JsonObject;
};

export type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: JsonValue;
};

export type JsonRpcError = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: JsonValue };
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcError;

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

export type ServerCapabilities = {
  tools?: { listChanged?: boolean };
  resources?: { listChanged?: boolean; subscribe?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, never>;
};

export type ServerInfo = {
  name: string;
  version: string;
  title?: string;
};

export type InitializeResult = {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: ServerInfo;
  instructions?: string;
};

export type ToolInputSchema = {
  type: "object";
  properties?: Record<string, JsonValue>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolDefinition = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: ToolInputSchema;
};

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string; mimeType?: string } };

export type CallToolResult = {
  content: ContentBlock[];
  isError?: boolean;
  /** Structured tool output — non-spec but useful for typed bridges. */
  structuredContent?: JsonValue;
};

/** Handler signature for a tool registered on the MicroMcpServer. */
export type ToolHandler = (args: JsonObject) => Promise<CallToolResult> | CallToolResult;

/** Internal record kept by the server. */
export type RegisteredTool = {
  definition: ToolDefinition;
  handler: ToolHandler;
};

export const MCP_PROTOCOL_VERSION = "2025-06-18";
