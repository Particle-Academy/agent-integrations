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
export { ToolRegistry, type ToolHost } from "./mcp/tool-host";
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
export {
  registerFlowBridge,
  type FlowBridgeAdapter,
  type FlowBridgeOptions,
} from "./bridges/flow";
export {
  registerFormBridge,
  type FormBridgeAdapter,
  type FormBridgeOptions,
  type FormFieldDescriptor,
} from "./bridges/forms";
export {
  registerSheetsBridge,
  type SheetsBridgeAdapter,
  type SheetsBridgeOptions,
} from "./bridges/sheets";
export {
  useSheetsAdapter,
  useSheetsActivityHighlights,
  type WorkbookLike,
  type UseSheetsAdapterResult,
  type SheetsAdapterOptions,
  type SheetsCellHighlight,
  type SheetsCellHighlightMap,
  type SheetsHighlightOptions,
} from "./sheets-adapter";
export {
  registerCodeBridge,
  type CodeBridgeAdapter,
  type CodeBridgeOptions,
} from "./bridges/code";
export {
  registerChartsBridge,
  type ChartsBridgeAdapter,
  type ChartsBridgeOptions,
} from "./bridges/charts";
export {
  registerSceneBridge,
  type SceneBridgeAdapter,
  type SceneBridgeOptions,
  type SceneObject,
  type SceneObjectKind,
  type SceneCamera,
  type SceneState,
} from "./bridges/scene";
export {
  registerScreensBridge,
  type ScreensBridgeAdapter,
  type ScreensBridgeOptions,
  type ScreenSnapshot,
} from "./bridges/screens";

// Components
export { AgentPanel } from "./components/AgentPanel";
export type { AgentPanelProps, AgentActivity } from "./components/AgentPanel";
export { AgentCursor } from "./components/AgentCursor";
export type { AgentCursorProps } from "./components/AgentCursor";
export { AgentActivityHighlight } from "./components/AgentActivityHighlight";
export type { AgentActivityHighlightProps } from "./components/AgentActivityHighlight";
export { BridgedForm, type BridgedFormProps } from "./components/BridgedForm";
export {
  ScreensActivityBridge,
  type ScreensActivityBridgeProps,
} from "./components/ScreensActivityBridge";
export { ShareControls } from "./components/ShareControls";
export type { ShareControlsProps } from "./components/ShareControls";
export { SharedWhiteboard } from "./components/SharedWhiteboard";
export type { SharedWhiteboardProps } from "./components/SharedWhiteboard";

// Presence — cross-package "what is the agent doing right now" layer
export {
  emitActivity,
  onActivity,
  readActivityHistory,
  resetActivityRegistry,
  wrapToolWithActivity,
  useAgentActivity,
  useAgentActivityForScreen,
  type AgentActivityEvent,
  type AgentActivityListener,
  type AgentTarget,
  type AgentTargetKind,
  type ActivityFilter,
  type ActivityAgent,
  type ActivityResolverContext,
  type ActivityTargetResolver,
  type ToolHandler as ActivityWrappedHandler,
} from "./presence";

// Undo/redo — per-agent stacks with reverse-action closures
export {
  pushUndoEntry,
  undoOne,
  redoOne,
  readHistory as readUndoHistory,
  clearStack as clearUndoStack,
  resetAllUndoStacks,
  registerUndoTools,
  ensureUndoToolsRegistered,
  useUndoStack,
  type UndoEntry,
  type UndoToolsOptions,
} from "./undo";

// Sharing — token utilities + SSE relay transport
export {
  createSessionDescriptor,
  describeSession,
  buildShareUrl,
  buildShareConfig,
  readSessionFromUrl,
  SseRelayTransport,
  attachSseRelay,
  type SessionDescriptor,
  type SseRelayOptions,
  type RelayState,
} from "./sharing";
