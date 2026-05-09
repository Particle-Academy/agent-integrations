// Public surface for @particle-academy/agent-integrations.

// MCP core (also available as a deep import: agent-integrations/mcp)
export {
  MicroMcpServer,
  textResult,
  errorResult,
  rpcError,
  type Transport,
  type McpServerOptions,
} from "./mcp/server";
export {
  InProcessTransport,
  attachInProcess,
  RelayTransport,
  attachRelay,
  type RelayChannel,
} from "./mcp/transports";
export type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonValue,
  JsonObject,
  ToolDefinition,
  ToolHandler,
  CallToolResult,
  ContentBlock,
  ServerCapabilities,
  ServerInfo,
  InitializeResult,
} from "./mcp/types";
export { MCP_PROTOCOL_VERSION } from "./mcp/types";

// Bridges
export type { Bridge, BridgeFactory } from "./bridges/types";
export {
  registerWhiteboardBridge,
  type WhiteboardBridgeAdapter,
  type WhiteboardBridgeOptions,
} from "./bridges/whiteboard";

// Components
export { AgentPanel } from "./components/AgentPanel";
export type { AgentPanelProps, AgentActivity } from "./components/AgentPanel";
export { AgentCursor } from "./components/AgentCursor";
export type { AgentCursorProps } from "./components/AgentCursor";
export { AgentActivityHighlight } from "./components/AgentActivityHighlight";
export type { AgentActivityHighlightProps } from "./components/AgentActivityHighlight";
