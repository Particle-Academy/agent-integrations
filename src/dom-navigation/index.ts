/**
 * `@particle-academy/agent-integrations/dom-navigation`
 *
 * Framework-free DOM co-browsing, in two halves:
 *
 * - IN THE PAGE: {@link createDomNavigationAgent} — the walker (stable handles,
 *   ARIA names, sensitive-field masking, React-safe field writes, rects). Use it
 *   directly when your code runs in the page; inject `DOM_NAVIGATION_SCRIPT`
 *   (from `./dom-navigation/script`) when it does not.
 * - IN THE HOST: {@link createRemoteNavigationAdapter} — a NavigationBridgeAdapter
 *   over a transport, for `registerNavigationBridge(server, { adapter })`.
 *
 * No React, no optional peers.
 */
export {
  createDomNavigationAgent,
  walk,
  readPage,
  setNativeValue,
  isVisible,
  isSensitive,
  roleOf,
  accessibleName,
  isDestructive,
  attributeHandle,
  isOffLimits,
  offLimitsPurpose,
  OFF_LIMITS_PURPOSES,
  type OffLimitsPurpose,
  INTERACTIVE,
  DOM_NAVIGATION_METHODS,
  OFF_LIMITS_ATTRIBUTE,
  OFF_LIMITS_ERROR,
  type DomNavigationAgent,
  type DomNavigationAgentOptions,
  type GuardedAction,
  type OffLimitsOptions,
  type DomNavigationMethod,
  type ActionResult,
  type HandleRect,
} from "./agent";
export {
  createRemoteNavigationAdapter,
  domNavigationCallScript,
  DOM_NAVIGATION_GLOBAL,
  DOM_NAVIGATION_PROTOCOL,
  type DomNavigationTransport,
  type RemoteNavigationAdapterOptions,
} from "./remote";
export type {
  NavigationBridgeAdapter,
  NavigationConfirmRequest,
  NavigationGuardAction,
  OffLimitsArea,
  PageAction,
  PageReadout,
  PageSnapshot,
} from "../bridges/navigation";
