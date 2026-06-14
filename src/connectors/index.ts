// Runtime surface for the connector builder — the React buttons plus the pure,
// framework-agnostic install-artifact builders. SAFE for the root barrel: no
// optional peer deps, no Node-only APIs.
//
// The `.mcpb` BUILD helper (`writeMcpbBundle`) is intentionally NOT here — it's
// Node-only. Import it from `@particle-academy/agent-integrations/connectors/build`.

export {
  ConnectorButtons,
  type ConnectorButtonsProps,
} from "./ConnectorButtons";

export {
  CLAUDE_CONNECTORS_URL,
  CONNECTOR_TARGETS,
  buildCursorDeeplink,
  buildVscodeDeeplink,
  buildManualConfig,
  buildManualConfigSnippet,
  slugifyServerName,
  encodeBase64Json,
  connectorHref,
  type ConnectorClient,
  type ConnectorServer,
  type ConnectorMechanism,
  type ConnectorTargetMeta,
  type ManualMcpConfig,
} from "./targets";

export {
  ClaudeMark,
  CursorMark,
  VscodeMark,
  DesktopMark,
  WrenchMark,
  CONNECTOR_GLYPHS,
} from "./glyphs";

// The MCPB manifest/proxy *generators* are pure (no fs), so they're safe to
// re-export here too — handy if a consumer wants the manifest object without
// packing. The packing helper lives in ./build.
export {
  buildMcpbManifest,
  buildMcpbProxyStub,
  MCPB_MANIFEST_VERSION,
  MCPB_MIN_NODE,
  DEFAULT_MCPB_ENTRY_POINT,
  type McpbManifestInput,
  type McpbTool,
} from "./mcpb";
