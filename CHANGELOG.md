# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Pre-1.0:** breaking changes may land in MINOR releases — read the entry, not
> the version number. This changelog begins at 0.32.0; for earlier history see
> the git log.

## [Unreleased]

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
