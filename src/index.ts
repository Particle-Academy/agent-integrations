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
  ToolCallContext,
  CallToolResult,
  ContentBlock,
  ServerCapabilities,
  ServerInfo,
  InitializeResult,
} from "./mcp/types";
export {
  MemoryHumanPlusEventStore,
  type HumanPlusEvent,
  type NewHumanPlusEvent,
  type HumanPlusEventStore,
  type HumanPlusEventQuery,
  type HumanPlusEventPage,
  type HumanPlusDisposition,
} from "./human-plus/events";
export { registerTuiBridge, type TuiBridgeOptions, type TuiSurfaceRegistryLike } from "./bridges/tui";
export { MCP_PROTOCOL_VERSION } from "./mcp/types";

// Bridges
//
// Bridges that depend on optional peer packages (fancy-whiteboard, fancy-flow)
// are NOT re-exported from the root barrel. Eager re-exports break bundlers
// (Vite/rolldown) when the optional peer isn't installed. Reach them via the
// subpath imports instead:
//
//   import { registerWhiteboardBridge } from "@particle-academy/agent-integrations/bridges/whiteboard";
//   import { registerArtboardBridge }   from "@particle-academy/agent-integrations/bridges/artboard";
//   import { registerFlowBridge }       from "@particle-academy/agent-integrations/bridges/flow";
//
// The root barrel stays core-only: MCP, presence, undo, sharing, sheets,
// forms, code, charts, scene, screens — none of which depend on optional
// peers.
export type { Bridge, BridgeFactory } from "./bridges/types";
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
export {
  registerSlidesBridge,
  type SlidesBridgeAdapter,
  type SlidesBridgeOptions,
} from "./bridges/slides";
export {
  registerMapBridge,
  type MapBridgeAdapter,
  type MapBridgeOptions,
} from "./bridges/map";
export {
  registerFilesBridge,
  type FilesBridgeAdapter,
  type FilesBridgeOptions,
} from "./bridges/files";
export {
  registerTerminalBridge,
  type TerminalRef,
  type TerminalBridgeAdapter,
  type TerminalBridgeOptions,
  type TerminalBridge,
  type TerminalShell,
} from "./bridges/terminal";
export {
  registerNavigationBridge,
  type NavigationBridgeAdapter,
  type NavigationBridgeOptions,
  type PageAction,
  type PageSnapshot,
  type NavigationConfirmRequest,
} from "./bridges/navigation";
export {
  registerCatalogBridge,
  type CatalogBridgeAdapter,
  type CatalogBridgeOptions,
  type CatalogProduct,
  type CatalogPrice,
  type CatalogCheckoutArgs,
} from "./bridges/catalog";
export {
  registerFeaturesBridge,
  type FeaturesBridgeAdapter,
  type FeaturesBridgeOptions,
  type FeatureGrant,
  type FeatureDefinition,
} from "./bridges/features";
export {
  registerDocBridge,
  type DocAdapter,
  type DocBridgeOptions,
  type DocOpTool,
} from "./bridges/doc";
export {
  registerCmsBridge,
  cmsReducer,
  type CmsOp,
  type CmsBridgeOptions,
} from "./bridges/cms";

// Co-browsing (site-wide session)
export {
  useCoBrowseSession,
  type UseCoBrowseSessionOptions,
  type CoBrowseSession,
  type CoBrowseUserEvent,
} from "./sharing/use-co-browse-session";

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
export { ShareControls, buildAgentPrompt } from "./components/ShareControls";
export type { ShareControlsProps } from "./components/ShareControls";
export { CoBrowsePresence, type CoBrowsePresenceProps } from "./components/CoBrowsePresence";
export { CoBrowseCursorLayer, type CoBrowseCursorLayerProps } from "./components/CoBrowseCursorLayer";
export { SimulateUsersButton, type SimulateUsersButtonProps } from "./components/SimulateUsersButton";
// SharedWhiteboard is NOT re-exported from the root barrel — it imports
// fancy-whiteboard eagerly. Reach it via the subpath instead:
//   import { SharedWhiteboard } from "@particle-academy/agent-integrations/components/shared-whiteboard";

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

// Heuristics sink — turns in-page agent activity into fancy-heuristics rows.
// Subscribes to the shared fancy-auto-common activity bus and POSTs each event
// to the heuristics `/collect` endpoint as actor:"agent" (also available as the
// subpath import: agent-integrations/heuristics).
export {
  attachHeuristicsSink,
  mapActivityToEvent as mapActivityToHeuristicsEvent,
  type AttachHeuristicsSinkOptions,
  type HeuristicsEvent,
  type CollectBatch,
} from "./heuristics/sink";

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

// Connector builder — per-client MCP "install" affordances for a remote server.
// Pure builders + the <ConnectorButtons> component (no optional peers, so safe
// in the root barrel). The Node-only `.mcpb` pack helper lives at the subpath
// `@particle-academy/agent-integrations/connectors/build`.
export {
  ConnectorButtons,
  CLAUDE_CONNECTORS_URL,
  CONNECTOR_TARGETS,
  CONNECTOR_GLYPHS,
  buildCursorDeeplink,
  buildVscodeDeeplink,
  buildManualConfig,
  buildManualConfigSnippet,
  slugifyServerName,
  encodeBase64Json,
  connectorHref,
  buildMcpbManifest,
  buildMcpbProxyStub,
  MCPB_MANIFEST_VERSION,
  MCPB_MIN_NODE,
  DEFAULT_MCPB_ENTRY_POINT,
  ClaudeMark,
  CursorMark,
  VscodeMark,
  DesktopMark,
  WrenchMark,
  type ConnectorButtonsProps,
  type ConnectorClient,
  type ConnectorServer,
  type ConnectorMechanism,
  type ConnectorTargetMeta,
  type ManualMcpConfig,
  type McpbManifestInput,
  type McpbTool,
} from "./connectors";
