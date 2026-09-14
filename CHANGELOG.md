# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Pre-1.0:** breaking changes may land in MINOR releases — read the entry, not
> the version number. This changelog begins at 0.32.0; for earlier history see
> the git log.

## [Unreleased]

## [0.46.0] - 2026-09-13

**What to do — for most consumers, nothing.** The Node relay gains a long-poll
route, a CORS list that works, and a `410` on the one route that still said
`401`. Check these four cases:

1. **You run `agent-integrations-relay` behind Cloudflare** (or any CDN that
   resets long streams): upgrade the relay, and install
   `@particle-academy/fancy-cf-relay` in the browser app so its receive leg
   polls. Agents on `mcp-relay-client` poll already.
2. **Your relay config is invalid** — `--cors` / `CORS_ALLOW_ORIGIN` /
   `corsAllowOrigin` mixing `*` with origins, empty, `null`, or an entry with
   a path. The CLI now exits `2` at startup and `createNodeRelay` throws. Fix the
   value; before, it produced a header no browser accepted.
3. **Your client treats `401` from `GET /{session}/events` as "the page
   closed"**: that answer is now `410`. Handle `410` as the end of the session;
   `401` still means a wrong or missing token.
4. **Your app imports this package's React entries without React in its own
   dependencies**, relying on npm to install the peer: add `react` and
   `react-dom` (^19) yourself. An app rendering React components has them.

### Added

- **Long-poll receive leg on the Node relay: `GET {prefix}/{session}/poll`.**
  Cloudflare's HTTP/3 edge resets long-lived SSE streams, so a Node relay behind
  it had no working receive leg — `/poll` answered `404`, while the PHP relay in
  px-ui-sandbox, `fancy-cf-relay` (browser) and `mcp-relay-client` (agent) all
  speak poll. Same contract as the PHP relay:
  `?token&direction=inbound|outbound&wait=<ms>&subscriber=<id>[&client]` →
  `200 { subscriber, frames: ["<raw frame>", …] }`. `wait` is clamped to
  0–25000 ms (default 20000) and returns early the moment a frame is queued.
  Frames queue between polls; an aborted poll takes nothing; a poller idle for
  60 s is dropped (`pollIdleMs`), and an agent's departure is announced to the
  page with `notifications/peer_left`. An outbound poller is announced once, not
  once per poll. Reply scoping by `client` works as on SSE, and a poll cannot
  adopt a streaming subscriber's id. The first three tests mirror px-ui-sandbox's
  `AgentRelayPollTest.php` case for case.
  - `RelayBroker#poll()` and the `PollResult` type, for custom adapters;
    `relay.poll` on `createNodeRelay()` for piecemeal mounting —
    `app.get("/mcp-relay/:s/poll", relay.poll)`.
  - A gone session answers `410 {"error":"session_gone"}` here too.

### Changed

- **`--cors` / `corsAllowOrigin` take a real origin list.** The option was
  documented as "comma-separated origins (or `*`)" and sent the string verbatim,
  so `--cors "https://particle.academy,https://www.particle.academy"` produced one
  `Access-Control-Allow-Origin` header that no browser matches. Now a listed
  request `Origin` is echoed back, every response carries `Vary: Origin`, and an
  unlisted origin gets no allow-origin header at all. `*` still sends `*`.
  Entries are normalised to what a browser sends (`HTTPS://Example.com:443/` →
  `https://example.com`), `--cors` may be repeated, and an invalid value fails
  at startup (see "What to do" 2). **Do:** nothing, unless your value was
  invalid.

- **Settings precedence is documented and reported: flag, then env var, then
  default.** It was always flag-first — so `CORS_ALLOW_ORIGIN` did nothing
  whenever a start script passed `--cors`, while a deploy README said to set it
  to override the start script. Flag-first is kept (it is what every setting
  does, and what `docker run … --host 127.0.0.1` against the Dockerfile's
  `HOST=0.0.0.0` needs); what changed is that a flag overriding a different env
  var now prints `[relay] WARNING: CORS_ALLOW_ORIGIN=… is ignored: --cors … was
  passed`, and the startup line names the CORS policy's source. An env var set
  to the empty string counts as unset (it used to become an empty header).
  **Do:** nothing; if you see the warning, edit the flag, not the env var.

- **`react` and `react-dom` are optional peers.** Headless hosts — a stdio MCP
  server importing `/mcp` and `/mcp/stdio`, a Node relay, a bridge on a server —
  no longer get React installed through this package. Measured on clean
  installs: `agent-integrations` alone is 6 packages with 0.45.0 (react,
  react-dom, scheduler among them) and 3 with 0.46.0, and all 27 subpaths
  outside the React list below import (ESM) and require (CJS) with no React
  present. React stays declared with its range, so a UI consumer on the wrong
  React is still told. (`fancy-flow-mcp-js` still receives React today, from
  `@particle-academy/fancy-flow`'s own required peer; with that one also made
  optional, its tree measured 5 packages, no React, and its stdio server
  answered `initialize` and `tools/list`.) A new test fails if
  any entry outside the React ones (root, `/bridges/tui`, `/sheets-adapter`,
  `/connectors`, `/components/shared-whiteboard`, `/presence`, `/heuristics`,
  `/undo`) starts importing React. **Do:** see "What to do" 4.

### Fixed

- **`GET /{session}/events` answers `410 session_gone` for an ended session**,
  as `docs/relay-server.md` promises for every route. 0.43.0 taught the POST
  routes the distinction and left `events` on the boolean check, so an agent
  re-attaching to a closed page was told `401 invalid_token` — the misleading
  answer 0.43.0 existed to remove, on the route a reconnecting client hits
  first. The body stays SSE-shaped: `event: error` / `data: session_gone`.
  `RelayBroker#subscribe()` now returns `reason: "session_gone"` for it too.
- **An SSE stream open when its session ends is closed.** `unregister`,
  `dropSession` and the TTL reaper dropped subscribers without waking them
  (the reaper did wake them), so a stream stayed open, heartbeating, for a
  session that no longer existed. The client now reconnects and learns `410`.
- **Frames fanned out in the same tick are all delivered to a streaming
  subscriber.** The resolver handing a frame to a parked generator stayed set
  until the generator resumed a microtask later, so a second frame in the same
  tick called the already-settled resolver after shifting its frame off the
  queue, and that frame was lost.
- **`allowedOrigins` no longer answers an unlisted origin with
  `Access-Control-Allow-Origin: null`.** Sandboxed iframes and `file://` pages
  send `Origin: null`, so that value admitted exactly them. No header is sent
  instead.
- **Docs that contradicted the code.** `docs/relay-server.md` gave `--host`'s
  default as `0.0.0.0`; it has been `127.0.0.1` since 0.30.0.
  `docs/relay-protocol.md` (and this changelog's 0.44.0 entry) showed `client`
  on `/sse/{session}` and `/inbound/{session}`, which no relay serves; the routes
  are `/{session}/events` and `/{session}/inbox`. Both docs now cover poll,
  `410` on every route, CORS lists and precedence; the Forge recipe's
  `^0.6.1` range is now `>=0.46.0 <2.0`. The README's "the relay fans tool
  results to all peers" predated 0.44.0's reply scoping.

## [0.45.0] - 2026-09-13

**What to do: nothing, unless you want the new pieces.** Every change below is
additive or only removes a notification nobody could have used. The default
`initialize` answer is byte-for-byte what 0.44.0 sent.

### Added

- **`@particle-academy/agent-integrations/mcp/stdio` — a stdio transport, so a
  headless Node MCP server needs no third-party SDK.** `attachStdio(server)`
  serves newline-delimited JSON-RPC on stdin/stdout, the framing every MCP
  client uses to launch a server as a subprocess; pass `{ input, output }` for
  other streams.

  It exists because `fancy-flow-mcp-js` was built on `@modelcontextprotocol/sdk`
  for want of one, and that dependency was refused. It is its own subpath, and
  NODE ONLY: browser bundles import `/mcp`, which never reaches it.

  - A bad line costs that line, not the session: a line that is not JSON, or is
    JSON but not one JSON-RPC message (a number, `null`, a batch), goes to
    `onError` — stderr by default — and nothing is written to stdout for it.
  - Replies still in flight when stdin ends are delivered before it closes, so
    `printf '<request>\n' | server` gets its answer.
  - Input is decoded as bytes, not chunk by chunk, so a multi-byte character
    split across a chunk boundary survives.

- **`protocolVersions` on `MicroMcpServer`** — the revisions a server speaks,
  newest first. `initialize` now echoes the client's requested revision when it
  is listed and answers the first entry otherwise, which is the spec's rule.
  **Omit it and nothing changes:** the default is `[MCP_PROTOCOL_VERSION]`, one
  revision answered whatever is asked, exactly as before. An empty list throws
  at construction rather than in a handshake.

- **`ToolDefinition` names the spec's optional fields** — `outputSchema`,
  `annotations` (new `ToolAnnotations` type), `execution` (2025-11-25 task
  support), `_meta`, and `$schema` on the input schema. They were always passed
  to `tools/list` verbatim; now they typecheck, and a test pins that they reach
  the client.

- **A test that walks the import graphs of `/mcp` and `/mcp/stdio`** and fails
  if either reaches a package (`/mcp`) or anything but a Node built-in
  (`/mcp/stdio`). The root and most subpaths import React by design; one
  careless re-export would break every headless host that chose the subpath to
  avoid it, and nothing else here would notice, because every other test runs
  with React installed.

### Fixed

- **`notifications/tools/list_changed` is no longer sent to a transport attached
  AFTER the change.** It went to every transport attached when the notification
  flushed at the end of the tick, so a transport attached in the same tick as a
  registration was told a list it never had was stale. On stdio that was the
  first frame a client received — before it had sent `initialize` — whenever a
  host registered tools and attached in one go, which is the natural way to
  write a stdio server. Changes still coalesce to one notification per tick, and
  a transport attached between two changes still hears about the second.

  **What to do:** nothing. A transport attached after a change receives the
  current list from `tools/list`, which it has to call anyway.

## [0.44.0] - 2026-08-26

### Security

- **A relay session token granted READ ACCESS TO EVERY PARTICIPANT'S TRAFFIC,
  not just the ability to act.** If you run the HTTP relay with more than one
  agent attached to a session, take this release.

  Two decisions, each defensible alone: `fanOut` pushed every frame to every
  subscriber on that direction, and the session token is bearer authority with
  no per-agent identity. **Together, a second holder of the token passively
  received the results of everyone else's tool calls without making one** — and
  on a live application page those results carry whatever the bridges expose.

  A share link that grants *action* is something a host can reason about. One
  that grants *surveillance of other participants* is a different offer, and
  nobody chose it — it fell out of the composition.

  It also contradicted our own spec: `relay-protocol.md` has always said "tool-
  call replies go back on the transport that originated the call". The relay
  never implemented that, so this restores documented behaviour rather than
  inventing new behaviour.

  **What to do:** send a `client` query parameter on both your subscription and
  your posts, with the same value:

  ```
  GET  {base}/{session}/events?token=…&direction=outbound&client=worker-7
  POST {base}/{session}/inbox?token=…&client=worker-7
  ```

  *(Corrected in 0.46.0: this example first read `/sse/{session}` and
  `/inbound/{session}`, routes no relay has ever served.)*

  Replies then reach only that client. **Notifications are unchanged** and still
  broadcast — presence, activity and server-pushed state answer nobody and are
  meant for every attached client.

  A client sending no label still gets the old broadcast, because narrowing it
  would break existing clients in silence. But a session where **any** subscriber
  identifies itself switches to scoped routing, and an uncorrelated response then
  reaches nobody rather than everyone.

  **This does not fix the token itself.** Possession is still authority for every
  registered tool: no expiry beyond a 4h idle timeout, no audience binding, no
  per-token tool subset, no way to tell two holders apart. That is a design
  question, and it is now written down rather than merely true.

  Reported by the Prism harness, composing two answers given separately — each
  piece defensible, the composition the defect, and nothing looking at
  compositions.

## [0.43.0] - 2026-08-26

### Added

- **`RelayBroker.check()` — "the session is gone" is now reportable, and
  distinct from "your token is wrong".**

  A relay session ends when the page closes or its TTL elapses, and that is the
  NORMAL end of a lifecycle rather than an error: the browser is the server, it
  owns the tools and the state, and nothing persists across restarts. So it is
  the one outcome every server-side client has to be able to recognise.

  It was not reportable. `validate()` returned a bare boolean for three
  different states — no credentials, session gone, wrong token — and the HTTP
  layer mapped all of them to `401 invalid_token`. **An agent holding a
  perfectly good token against a closed page was told its credentials were
  wrong.** Not a missing signal; an actively misleading one, which sends the
  reader to debug an auth path that was never the problem.

  A gone session now answers **`410 Gone`** with `{"error": "session_gone"}`.
  `410` rather than `404` because the session existed and is now over, which
  separates "this is finished" from "you have the wrong URL".

  Two deliberate limits: a wrong token on a LIVE session is still
  `invalid_token` (answering otherwise would tell an unauthenticated caller
  which sessions exist), and unregistering an already-gone session now SUCCEEDS
  with `{ok: true, alreadyGone: true}` — the caller wanted it gone and it is
  gone, and reporting an auth failure there makes a clean shutdown look broken
  and a retrying client loop.

  **Do you have to do anything?** No. `check()` is additive and `validate()`
  keeps its boolean contract, with a test pinning that. If you consume the HTTP
  relay, you may now receive `410` where you previously received `401`, which is
  the point.

  Documented in [`docs/relay-server.md`](./docs/relay-server.md).

  Requested by the Prism harness while designing a non-Node relay client: a dead
  session must fail clearly "rather than looking like a page with no tools". The
  reality was one notch worse than the shape they were guarding against.

## [0.42.0] - 2026-08-14

Implements the decided co-browse design — **site tools always; page tools while mounted** (#7). The cross-session activity leak, the other half of #6 item 4, shipped separately in 0.40.0.

### Added

- **`contributeBridges` on the `useCoBrowseSession` result** — a page contributes bridges for as long as the returned disposer is uncalled:

  ```tsx
  useEffect(() => contributeBridges((server) =>
    registerArtboardBridge(server, { adapter }).dispose), []);
  ```

  `extraBridges` already existed and was already called, so the plumbing looked done. It could not express this design, because it fires **exactly once while the server is built**: a page mounting afterwards never gets a chance to contribute, and one that unmounts can never withdraw. Both failures are silent — the agent simply never sees those tools, or keeps ones aimed at a surface that is gone. Contributions are therefore a registry applied when a server appears, re-applied if the session is restarted under a still-mounted page, and withdrawn on unmount.

  Safe to call before sharing starts. `extraBridges` is unchanged and still works for bridges that live for the whole session.

- **`BridgeContributions`** — the registry itself, exported for hosts not using the React hook.

### Changed

- **A call to a withdrawn tool now says so.** A dynamic tool surface means an agent calling a tool while the human navigates away is normal traffic, not an edge case, and it previously produced `Unknown tool: x` — indistinguishable from a name that never existed, and the least useful thing to say while a human is watching. A withdrawn tool now reports that the surface it targets is no longer mounted and points at `tools/list`, while a genuinely unknown name still reports `Unknown tool`. Re-registering clears it, so a remounted surface stops apologising.

  **What you must do:** nothing, unless you match on the exact error string for a tool that was withdrawn rather than never registered.

### Notes

- No new notification machinery was needed for withdrawal: bridge disposers already unregister their tools, `ToolRegistry` fires `onToolsChanged`, and `MicroMcpServer` already broadcasts `notifications/tools/list_changed`. Verified before building — note that grepping for `unregisterTool` under-reports this, because bridges use the disposer `registerTool` returns.
- The **sandbox side is not done**: `CoBrowseProvider` still passes no contributions, so nothing exercises this in the showcase yet.

## [0.41.0] - 2026-08-11

### Added

- **`files_create_folder` — the files bridge's first write.** The bridge shipped
  read-only and said so; react-fancy 5.18.0 then gave `FileBrowser` an opt-in
  New Folder button, so a human could create a folder and an agent could not.

  **Opt-in via the adapter:** no `createFolder` on your `FilesBridgeAdapter`, no
  tool. A host that never wired creation cannot have an agent create anything,
  and the advertised tool list stays honest about what is possible.

  **Staged by default.** `pendingMode` defaults to `true`, matching the catalog
  bridge's destructive ops — this writes to a filesystem on the strength of a
  model's output, so the safe mode is the default and turning it off is the
  deliberate act. Wire `confirm` for a human prompt, or let the agent
  acknowledge with `confirm: true`.

  **Names are validated separately from paths.** `assertPathWithinRoot` inspects
  the PARENT; the name is appended afterwards, so `{ parentPath: "/root",
  name: "../.." }` clears the root check and still escapes. Separators, `.` and
  `..` are rejected as names. Exported as `invalidFolderName` if a host wants
  the same rule.

  An adapter rejection surfaces as a tool error rather than success — the host's
  filesystem is the authority, and reporting its refusal as success would tell
  the agent a folder exists that does not.


## [0.40.0] - 2026-08-11

### Fixed

- **Two concurrent relay sessions leaked each other's activity** (#6, item 4).

  `attachSseRelay` subscribes to the in-process activity bus and forwarded every
  event it saw. That bus is global to the page, so running the site co-browse
  relay alongside the agent playground's meant each agent received the other's
  navigations and clicks, and the presence overlay attributed them to whoever
  was nearest.

- **The relay's own connect/disconnect events carried a hardcoded
  `agentId: "agent"`.** Two sessions' connect events were therefore identical,
  and unfilterable — there was nothing to tell them apart by. They now carry the
  session's configured `agent`, falling back to the old literal.

### Added

- **`activityFilter` on `SseRelayOptions` and `useCoBrowseSession`** — a
  predicate deciding which events this relay forwards.

  Omitted, everything is forwarded, which is the historical behaviour and right
  for the single-session case; **consumers with one session do nothing.** A
  throwing predicate drops that one event and keeps the subscription, because a
  host predicate is host code and a session that goes permanently silent looks
  exactly like an agent that has died.

- **`agent` on `SseRelayOptions`**, passed through by `useCoBrowseSession` from
  the identity it already had.

### Notes

- This is the standalone half of #6 item 4. The rest — one merged session with
  one tool surface — needs a decision about whether a mounted playground page
  contributes its bridges permanently or only while mounted, and that does not
  belong inside a bug fix. The leak is the part that is visibly wrong today, and
  it is fixed independently of how that question is answered.


## [0.39.1] — 2026-08-10

### Fixed

- **`artboard_set_piece_content` failed on any piece that had no content yet.**
  The undo snapshot cloned `existing.content` through
  `JSON.parse(JSON.stringify(...))`, and `JSON.stringify(undefined)` returns the
  *value* `undefined` rather than a string — so `JSON.parse` threw
  `"undefined" is not valid JSON` and the tool returned an error.

  Invisible from inside the bridge, because a piece the BRIDGE adds always has
  content (`coerceContent` returns at least `{kind:"node"}`). It only fired on a
  piece the host app built — which is every piece on a board a human made, i.e.
  the normal case for an agent asked to fill something in.

  **What you must do:** nothing. `clone` now passes `undefined` through, so undo
  can also restore a piece to genuinely having no content.

### Added

- **Tests for the ten bridges that had none** — `artboard`, `charts`, `cms`,
  `git`, `map`, `scene`, `screens`, `sheets`, `slides`, `whiteboard`. The suite
  goes 233 → 317.

  `UNTESTED_BRIDGES` is now **empty**. It stays as a mechanism — an entry is a
  reviewable admission that a bridge ships untested, and a further test fails if
  one goes stale — so it cannot quietly become a parking space.

  Beyond the defect above, writing them pinned several contracts that were not
  what they looked like from outside: `git` omits `git_reviews_list` /
  `git_checks` entirely rather than advertising tools that fail; `element_move`
  takes FRACTIONAL slide coordinates and clamps to 0..1; `map_add_marker` takes
  flat `lat`/`lng` but stores a nested `position`; `artboard_add_piece` marks
  agent-added pieces `pending`; and `artboard_set_piece_content` silently
  coerces an unrecognised content shape to `{kind:"node"}` while reporting
  success.

- **A test that every bridge is reachable by a consumer.** Shipping a bridge
  takes four edits in four files, and the guidance already warned what happens
  when one is missed — *"the bridge lands in source but invisible to consumers,
  exactly how `registerSlidesBridge` sat un-shipped until v0.6.3."* Nothing
  checked it. A bridge's own tests import it by relative path, so they pass
  whether or not the **package** exposes it: green suite, correct source, and a
  feature that does not exist outside this repo.

  It also asserts the subtler half — that a module eagerly importing an optional
  peer stays **out** of the root barrel. That was a comment, and comments do not
  fail builds. Re-exporting `SharedWhiteboard` would make `fancy-whiteboard`
  mandatory for everyone importing the package root, the same class of breakage
  as `fancy-flow` shipping `@xyflow/react` and making `fancy-screens` impossible
  to co-install. Verified by adding that export and watching the test go red.

### Notes

- **`ToolRegistry.callTool` does not validate the `required` list.** It is
  advertised in each tool's schema and never enforced, so a call omitting a
  required argument runs anyway — `chart_update_option` with no `partial` merges
  `{}` and reports "Merged chart option"; `scene_add_object` with no `kind`
  mints an object with the id `undefined_<random>`. A schema-respecting MCP
  client will not do this, but a relay, a hand-rolled client or a model emitting
  malformed arguments will, and this package exists to be driven by exactly
  those. Not changed here: enforcing it turns silent no-ops into errors across
  24 bridges, which is a deliberate decision rather than a test-writing side
  effect.

## [0.39.0] — 2026-08-09

### Added

- **`registerGridBridge`** (`./bridges/grid`) — MCP access to a
  `@particle-academy/fancy-grid` surface: `grid_get`, `grid_sort`,
  `grid_filter`, `grid_select_rows` and `grid_edit_cell`.

  The grid state types are **mirrored here, not imported**. fancy-grid keeps
  TanStack Table and Virtual as peers precisely so nothing bundles them, and an
  `import type` would still make fancy-grid a build-time dependency of this
  package. The state is four small JSON shapes; the coupling is not worth it —
  the same call the scene bridge makes about fancy-3d's descriptor.

  Three behaviours worth knowing:

  - **An unknown column is an ERROR**, not a silent no-op. A sort nothing
    applies looks exactly like a grid that is not sorted, so an agent would have
    no way to tell it failed. Same for selecting a row that is not on the page.
  - **`grid_edit_cell` is omitted entirely on a read-only grid** rather than
    registered and failing at call time. An agent should learn what it can do
    from the tool list, not by trying.
  - **`pendingMode` gates `grid_edit_cell` only.** It is the one tool that
    changes stored DATA rather than view state; sorting a grid is not a
    trust-but-verify action, and gating it would train people to click through
    confirmations.

  View state goes through the adapter's single `setState`, because that is how
  the grid is controlled — a bridge mutating pieces separately would drift from
  what the component accepts. Every view change is undoable via `agent_undo`.


## [0.38.0] — 2026-08-09

### Added

- **`AgentPanel` is now a tool-call feed.** `AgentActivity` gains optional
  `args`, `result`, `durationMs` and `status` (`"pending" | "ok" | "error"`),
  and a `kind: "tool"` row carrying any of them renders as
  `tool(args) · 142ms` with `→ result` beneath.

  This is an extension rather than a new `<ToolCallFeed>` because the panel
  already rendered an activity stream with a `"tool"` kind — a sibling
  component would have re-rendered the same rows beside it.

  `status: "pending"` is what makes it a **stream** rather than a log: a row can
  appear the moment a call starts and be replaced when it settles, instead of
  the feed only ever showing finished work. Status is inferred as `error` from
  `kind: "error"` when not given.

  Payloads are truncated to ~80 chars on the row. A feed is scanned, not read,
  and an untruncated result pushes every subsequent row off screen — the full
  value stays available on `detail`.

  Each part carries a handle (`data-fai-args`, `data-fai-result`,
  `data-fai-latency`, plus `data-kind` / `data-status` on the row) so a host can
  restyle or address it.

  **What you must do:** nothing. Every field is optional, and a row without them
  renders exactly as before — pinned by a test.


### Added

- **A shared-substrate parity suite** (`src/bridges/__tests__/substrate-parity.test.ts`)
  asserting that `fancy-cms-ui` and `fancy-screens` really do read and write the
  same node / tree / op types, run against the **published** packages rather
  than by inspection.

  The "one document substrate" claim is easy to state and easy to quietly break:
  each package has its own reducer, and two reducers that agree today can
  disagree on one edge — ordering, cascade, a no-op guard — without anything
  failing, because each package's own suite only ever exercises its own. Both
  are devDependencies, so nothing at runtime depends on them.

  Also covers the other half: `registerDocBridge` driving a document the CMS
  itself created, with `registerCmsBridge` adding two domain ops and nothing
  else — the generic bridge doing the work, which is what "no CMS-specific
  bridge" was supposed to mean.


## [0.37.0] — 2026-08-07

### Changed

- **BREAKING — Node 22 is now declared as the floor.** `engines.node` is `>=22`, where this package previously declared **nothing at all**.

  Declaring nothing was not the same as supporting old Node: a consumer on 18 installed cleanly and found out at runtime.

  **What you must do:** on Node 22 or newer, nothing. Note npm only *warns* on an `engines` mismatch while **pnpm fails the install**, so this surfaces differently depending on your package manager. Node 18 is end-of-life and 20 is maintenance-only.

- **BREAKING — React 18 is no longer supported.** `peerDependencies.react` / `react-dom` are now `^19.0.0`.

  **What you must do:** on React 19, nothing. On React 18, stay on the previous release, or upgrade your app to 19 first.

  React 18 support was a claim nothing tested — every build and test in this package ran against 19, so the 18 half of the old range was never executed. An untested compatibility claim is worse than an absent one, because it reads as support.

### Why

These are the kit 0.5 platform floors, applied across every package at once so a consumer never has to resolve a mix. **No API changed, nothing was removed, nothing was renamed** — only what the package requires.


## [0.36.0] — 2026-08-03

### Added

- **`registerScreenDocBridge`** — an agent bridge over the *contents* of one
  rendered `<Screen doc={…}>` (fancy-screens ≥ 0.6), built on
  `registerDocBridge`. Read the nodes in a screen, patch a prop, retext a label,
  reparent a card — with undo, agent activity and staged writes inherited from
  the substrate.

  This is the other half of `registerScreensBridge`, and the halves are not
  interchangeable: that one moves *between* screens and treats their contents as
  an opaque `config` blob. Until fancy-screens 0.6 there was no way to address
  anything *inside* a screen at all, because `ScreenSchema` nodes had no `id` —
  an agent could emit an entire surface and then touch none of it. That was a
  standing violation of the component contract's stable-handles requirement, on
  the one shipped "agent emits a UI" path.

  Two things it adds over the raw generic bridge, both about a screen being a
  rendered React tree:

  - **Positional ids are reported as positional.** fancy-screens mints one for
    any node the author left anonymous; it looks like a handle and is not one,
    because inserting a sibling above it silently repoints it. Every read here
    says which kind of id it returned, and `screen_addressable` lists only the
    durable ones.
  - **`screen_set_text`** retexts an element by the *element's* id, so an agent
    never has to know that literal text is a reserved `#text` child node.

  Pass `surface` to prefix the tools per screen (`"screen_checkout"`) when more
  than one doc-driven screen is bridged at once.

- **`add` accepts an optional `id`** on every doc-derived bridge (`cms_add`,
  `screen_add`, …), so an agent can name the handle it is about to depend on
  instead of taking a minted one. Adding over an existing id is an error rather
  than a silent overwrite.

  **What you must DO: nothing.** The argument is optional and omitting it
  behaves exactly as before.

### Fixed

- **BREAKING (staged writes): a staged `update` / `remove` / `move` / domain op
  now returns its pending id as `pendingId`, not `id`.**

  These ops report the *node* id they targeted, and that assignment ran after
  the staged result was spread — so it overwrote the pending id with the node
  id. `*_confirm` only accepts a pending id, so three of the four canonical ops
  produced a staged write that could never be confirmed, and the edit was
  silently dropped. Only `add` worked, and only because it does not report a
  separate node id. Every mutation now returns both, under separate keys.

  **What you must DO — only if you use `stagePolicy`:** read `pendingId` where
  you previously read `id` from a staged result. Anything staging only `add`
  keeps working if it reads `pendingId`; `id` on a staged `add` is now the new
  node's id, which is what it always claimed to be. Hosts that never set a
  `stagePolicy` are unaffected — nothing stages by default.

- **A minted node id no longer collides with an existing node.** The counter
  restarts with the bridge, so on a tree loaded from elsewhere `cms-1` could
  already be taken and `add` would overwrite that node. Minting now skips past
  anything present.

## [0.35.0] — 2026-07-31

### Added

- **`useCoBrowseSession` now reports whether an agent is actually there** —
  `agentConnected` / `agentCount`, driven by the relay's peer join/leave frames
  (`SseRelayTransport.onPeersChange` / `peerCount()` are public too).

  The only signal available before this was `relayState`, which describes the
  BROWSER's own channel to the relay and turns `"open"` the instant sharing
  starts. Anything keyed on it therefore announced a driver to a human who had
  not yet handed the link to anybody — and stayed exactly the same when a real
  agent arrived, so it could not report the one event it existed to report.

  **No action needed** — additive fields on an object you already receive.

### Fixed

- **`<CoBrowsePresence>` shows what the agent is doing.** 0.33.0 gave
  `<ShareControls>` the `agentConnected` + `activity` props, but nothing passed
  them, so the site-wide co-browse panel still rendered the paste-this-prompt UI
  (Agent prompt / URL / JSON / cURL) while an agent was connected and driving.
  It now feeds both from the presence stream and opens on the log.

  Its "Agent is driving" badge was keyed on `relayState === "open"` and is now
  keyed on a real peer, so it no longer reads "Agent is driving" over a session
  nobody has joined.

- **The agent cursor no longer appears for an agent that has not acted.**
  `agent_connected` — a lifecycle frame carrying no target — was parking a
  motionless pointer captioned "Agent connected" at the centre of the viewport.
  Short-lived relay clients (one process per MCP call) re-emit it constantly, so
  the cursor could sit there for the whole session having never once moved,
  which reads as a hung agent rather than a present one.

  `<CoBrowseCursorLayer>` now creates and moves the cursor only on real tool
  traffic, and retires it after `idleAfterMs` (default 15s) of silence. Pass
  `idleAfterMs={0}` for the old always-on behaviour. Connect / disconnect frames
  still update the caption of a cursor that is already on screen; they just
  never conjure one, and never extend its life.


## [0.34.0] — 2026-07-31

### Added

- **`registerPasskeyBridge` — the 21st bridge, over passkey (WebAuthn)
  *management*.** Import from `@particle-academy/agent-integrations/bridges/passkeys`
  or the root barrel. Five tools: `passkey_list`, `passkey_status`,
  `passkey_rename`, `passkey_revoke`, `passkey_begin_enrollment`. Pairs with
  `@particle-academy/fancy-passkeys-ui`'s `PasskeyManager` — the adapter takes
  the same callbacks you already passed the component — but imports nothing, so
  it type-checks and builds with that package absent.

  **What it deliberately does not do, and never will:** complete a ceremony.
  There is no `passkey_authenticate`, no `passkey_sign_in`, no `passkey_complete`.
  A WebAuthn ceremony needs a user gesture and a biometric or PIN, both of which
  only the human at the keyboard has; a tool that performed one would be a bypass
  of the exact property that makes a passkey better than a password. A test
  asserts the registered tool names against a closed list, so adding one fails CI.

  Two more things the bridge does rather than documents:

  - **`passkey_list` re-projects every record onto the eight public summary
    fields.** Hosts hand `list()` their ORM model — the obvious thing to do — and
    that model carries the COSE public key, the user handle and the signature
    counter. A whitelist (not a blacklist) means a backend growing a column
    cannot silently start publishing credential material to every agent in the
    session.
  - **`passkey_revoke` only ever STAGES.** It puts the request in front of the
    human and returns; the confirming click comes from the surface. Unlike
    `features_grant`, there is no `confirm: true` argument and no host hook that
    turns staging off — `additionalProperties: false` means the schema will not
    even accept one. Revoking the last passkey is a lockout, and the response
    says when that is the case so the agent can warn the human first.

  `passkey_rename` is immediate and undoable via `agent_undo`. Set
  `confirmRename: true` to route it through a host `confirm` hook as well — worth
  it where the label carries trust, since a rogue credential relabelled
  "Glenn's iPhone" survives a human's audit of the list.

### Note

- `@particle-academy/fancy-passkeys-ui` is **not** listed as a peer or a
  devDependency, because it is not published yet and a dependency on a package
  that 404s is worse than none. The bridge does not import it; the adapter is
  satisfied structurally. The peer entry lands with that package's first release.

## [0.33.0] — 2026-07-30

### Added

- **`<ShareControls>` becomes an activity log once an agent connects.** It kept
  showing the paste-this-prompt UI — Agent prompt / URL / JSON / cURL — long
  after the agent had connected and started driving. Dead weight at exactly the
  moment the human needs the opposite, and it made a **connected agent
  indistinguishable from a broken one**: a stalled session looked identical to a
  working one.

  Two new optional props: `agentConnected` and `activity`. The panel switches to
  the log the FIRST time an agent connects and then leaves the tab alone, so it
  never fights a human who went back to re-copy the URL. Connected-with-nothing-
  yet says so explicitly rather than rendering an empty list.

  `activity` reuses `AgentActivity` from `AgentPanel` rather than introducing a
  second event shape, so a host already collecting presence events passes the
  same array to both.

  **No action needed** — both props are optional and the panel behaves exactly as
  before without them.

### Changed

- Widened the `fancy-auto-common` and `fancy-doc-commons` requirement from `^0.1.0` to `>=0.1 <2.0`, so a
  sibling minor release is an upgrade and not a resolver conflict. **No action
  needed** — widening a range only adds candidates; the version you have today
  still resolves.

  A caret on a `0.x` range locks the MINOR, so this pinned a sibling at
  whatever it happened to be on the day it was written, and each sibling
  release then read as a conflict to the resolver rather than an upgrade.
  Nothing here was using an API the newer minors removed — the range was the
  whole problem.

## [0.32.0] — 2026-07-24

> This release also cuts work already merged to `main` but unreleased since
> 0.31.0: a Human+ **Git bridge** (`registerGitBridge`), a **files-bridge
> ReDoS** hardening, and the CI workflow.

### Added

- **Flow bridge trust surface (`registerFlowBridge`).** The bridge now validates
  what an agent builds, closing the drift between it and `<FlowCanvas>`:
  - **Connection validation** — `flow_connect` enforces port-type compatibility
    using fancy-flow's `createConnectionValidator` (the SAME rule the canvas
    applies), so an agent can no longer create an edge the canvas would refuse.
    New `validateConnections?: boolean | ConnectionValidatorOptions` option
    (default `true`); self-loops are blocked. No-ops when fancy-flow (>= 0.18.0)
    isn't importable — falls back to the previous existence-only check.
  - **Config validation** — `flow_add_node` / `flow_update_node` validate a
    node's config against its kind's `configSchema`. New
    `validateConfig?: "reject" | "warn" | "off"` option (default `"reject"`);
    `flow_update_node` validates the merged config BEFORE applying, so a reject
    leaves the graph untouched.
  - **Staging** — `flow_delete_node` and `flow_run` can be gated on a human
    confirm. New `pendingMode?: boolean` option (default **off** — flow authoring
    is high-frequency, unlike a form submit) plus an optional
    `adapter.confirm(request)` hook and a `FlowConfirmRequest` type.

### Fixed

- **`flow_list_node_kinds` `category` filter now works.** It was a no-op
  placeholder (`const cat = adapter ? undefined : undefined`); the tool now
  actually filters kinds by the requested category.

### Changed

- Raised the `@particle-academy/fancy-flow` peer floor to `>= 0.18.0` (for
  `createConnectionValidator`). It remains an **optional** peer — the bridge
  degrades gracefully when fancy-flow is absent, so this is non-breaking for
  hosts that don't use the flow bridge.

  **What a consumer must DO:** nothing, unless you use `registerFlowBridge` with
  typed ports or config schemas — then ensure fancy-flow is on 0.18.0+ so
  validation activates (otherwise the bridge silently skips it, as before).
