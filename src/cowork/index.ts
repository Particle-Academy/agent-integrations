/**
 * `@particle-academy/agent-integrations/cowork` — the client side of co-work
 * sessions (CC-fancy-0037): people and agents sharing live UI through intents,
 * never the DOM. Pairs with the servers `particle-academy/fancy-cowork` (PHP)
 * and `@particle-academy/fancy-cowork` (Node); neither is a dependency.
 *
 * This entry is HEADLESS (no React): the engine, the transports and the
 * framework-free `createCoworkSession`, so a Node process can join a session
 * too. The React pieces, `useCoworkSession` and `<CoworkPresence>`, are on the
 * package root.
 *
 * No chat: the only message-shaped thing is the opaque `app` intent, delivered
 * to `onAppMessage` and never persisted, rendered or interpreted here.
 */
export {
  createCoworkSession,
  type CoworkSession,
  type CoworkSessionOptions,
  type CoworkSnapshot,
  type CoworkPeer,
  type CoworkCursor,
  type CoworkViewControl,
  type CoworkBlock,
  type CoworkRefusal,
  type CoworkAppMessage,
  type SendOptions as CoworkSendOptions,
} from "./session";
export { bindCoworkDom, type BindCoworkDomOptions } from "./dom-binding";
export { createInputBlocker, BLOCKED_EVENTS, CONTROL_ATTRIBUTE, type InputBlocker, type InputBlockerOptions } from "./input-block";
export {
  createMemoryTransport,
  createWhisperTransport,
  createServerTransport,
  readFrame,
  readSync,
  peerFromMember,
  type CoworkSyncState,
  type CoworkSyncParticipant,
  type PeerTransport,
  type CoworkFrame,
  type ReceivedFrame,
  type PeerInfo,
  type PresenceEvent,
  type PresenceChannelLike,
  type MemoryHub,
  type WhisperTransportOptions,
  type ServerTransportOptions,
} from "./transport";
export {
  ALLOW,
  REASONS,
  DEFAULTS,
  DEFAULT_CONFIG,
  DEFAULT_MIDDLEWARE,
  createSessionState,
  evaluateIntent,
  evaluateJoin,
  evaluateActivate,
  evaluateConsent,
  evaluateEnd,
  evaluateLeave,
  evaluateFollow,
  resolveConfig,
  resolveStack,
  validIntent,
  holderOf,
  globMatch,
  routeOf,
  isSameOriginPath,
  jsonBytes,
  refuse,
  type EngineHost,
  type Middleware,
  type MiddlewareEntry,
  type DefaultMiddlewareName,
  type PipelineContext,
  type Result,
  type IntentInput,
  type OpInput,
  type NewSessionInput,
} from "./engine";
export * from "./types";
