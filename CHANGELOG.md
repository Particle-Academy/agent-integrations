# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Pre-1.0:** breaking changes may land in MINOR releases — read the entry, not
> the version number. This changelog begins at 0.32.0; for earlier history see
> the git log.

## [Unreleased]

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
