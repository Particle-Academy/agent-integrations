/**
 * Server-side relay broker for the SSE+POST tunnel documented in
 * docs/relay-protocol.md. Hostable in any Node-compatible runtime.
 *
 * Two consumption shapes:
 *
 *   1. `createNodeRelay({ pathPrefix })` — returns Node http handlers
 *      ready to mount onto Express / native http / Hono node-adapter.
 *
 *   2. `new RelayBroker()` — the pure broker logic with no HTTP
 *      opinions. Use this if you're writing your own adapter (Workers,
 *      Bun, custom edge runtimes).
 *
 * No browser code in this module. Importing it from the browser will
 * pull in node:* built-ins and fail. Use the root barrel or
 * `agent-integrations/sharing` for the client side.
 */

export { RelayBroker, type RelayBrokerOptions, type Direction, type Store, type Session, type Subscriber } from "./core";
export { createNodeRelay, type NodeRelay, type NodeRelayOptions, type NodeHandler } from "./node";
