# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Pre-1.0:** breaking changes may land in MINOR releases — read the entry, not
> the version number. This changelog begins at 0.32.0; for earlier history see
> the git log.

## [Unreleased]

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
