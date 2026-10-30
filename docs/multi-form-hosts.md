# Several forms on one host — design note

**Status: option A is BUILT (0.53.0).** The owner chose A on 2026-10-30. The
proposal below is kept as written against 0.51.0 for the reasoning; "Where it
stands" describes the state before 0.53.0. What was built, and what another
bridge would need to adopt it, is at the end ("As built").

## Where it stood (0.51.0 and 0.52.0)

`registerFormBridge` registers `form_describe`, `form_get_value`,
`form_get_values`, `form_set_value`, `form_set_values`, `form_focus` and
`form_submit`. The names are not scoped to the form. Since 0.51.0 a tool name
held by a different registrant is refused, and each form bridge registers as
`form:<adapter.id>`, so a second form with a different id on the same host
throws. Before 0.51.0 it did not throw, but the second form silently took over
the first one's tools, so two forms on one host have never worked. 0.51.0 made
the existing failure visible.

The same limit applies to every bridge whose registrant id carries an adapter
id: charts, grids, code editors, scenes, catalogs, feature panels and passkey
surfaces. Whatever is chosen for forms should be the pattern for those too.
There is already one precedent for scoping: `registerScreenDocBridge` takes a
`surface` option that prefixes its tool names (`screen_checkout_add`).

Until 0.53.0 the supported answer was **one form bridge per host**.

## Options

### A. One form bridge serving N forms: a `form` argument plus `form_list`

The first `registerFormBridge` on a host creates a per-host form router. Later
calls on the same host **join** it instead of throwing (the same per-host
pattern `ensureUndoToolsRegistered` uses for the undo tools). Each returned
`Bridge.dispose()` removes only its own form. Tools gain a `form` argument, and
a new `form_list` tool returns `{ id, title, screenId }` for each mounted form.

- With exactly one form mounted, `form` is optional, so every existing
  single-form consumer and agent prompt keeps working unchanged.
- With two or more forms, a call without `form` is an error that lists the form
  ids, so an agent that guessed corrects itself on the next call.
- Presence and activity already target `formId:field`, so nothing changes there.
  Closing one form settles only that form's pending writes.

Pros: stable, short `tools/list` (7 + 1 tools however many forms); no
`tools/list_changed` churn when forms mount and unmount; forms come and go as
data, which is how an agent reasons about them ("which form?"); no consumer code
change, because the call that throws today starts working. The router can be a
shared helper, so charts and grids get the same model later.

Cons: the largest change of the three. Tool descriptions become generic (today
`form_describe` names its form in the description). Per-form options such as
`pendingMode` and `agent` must stay per form inside one router. A host that
*relied* on the 0.51.0 throw to detect a double mount loses that signal, though
nothing first-party does.

### B. Instance-scoped tool names via an option

Add `toolPrefix` (or reuse the name `surface`, as screen-doc does):
`registerFormBridge(host, { adapter, surface: "form_billing" })` registers
`form_billing_set_value`, and so on. The default stays `form`, so existing
consumers are unaffected.

Pros: small, mirrors an existing option, fully backward compatible, and each
tool name says which form it drives.

Cons: `tools/list` grows by 7 per form, and some clients cap or truncate long
tool lists. Mounting and unmounting forms churns `tools/list`, and not every
client re-reads it. The agent must infer that `form_billing_*` and
`form_shipping_*` are the same tool family. MCP tool names are limited (64
characters, `[A-Za-z0-9_-]`), so the host must choose a valid prefix or the
bridge must sanitise one. Nothing stops two hosts from choosing different
conventions.

### C. One MCP host per form

Already supported. No change.

Pros: zero work and no new surface; isolation is total.

Cons: the agent needs one connection per form, or the consumer builds its own
router. Cross-form work ("copy billing into shipping") spans connections. Undo
history and presence split per host. This does not scale to dynamic forms. It
is a workaround, not a model.

## Recommendation

**A**, built as a small shared per-host router so the charts, grid and other
multi-instance bridges can adopt it later. It is the only option that keeps the
tool list stable while forms come and go, and it needs no consumer change: the
code that throws today starts working. Keep **B** as the escape hatch only if a
client turns out to need flat, self-describing tool names. Document **C** as the
interim answer until A ships.

Suggested acceptance tests for A: two forms on one host both drivable; a call
without `form` while two are mounted is refused with both ids listed; with one
form mounted every existing call shape still succeeds; disposing one form leaves
the other drivable and settles only the disposed form's pending writes; a remount
of the same id re-joins rather than duplicating; `form_list` reflects mounts and
unmounts.

## As built (0.53.0)

- `src/bridges/multi-instance.ts` holds the shared piece, `joinInstanceRouter`.
  It is internal (no entry point). It keeps one router per (host, family) in a
  `WeakMap`, calls the family's `install` once when the first instance joins,
  and calls the disposer `install` returned when the last instance leaves. It
  also resolves the selecting argument by the rules below. If `install` throws
  because a name is held by an unrelated registrant, no router is left behind.
- `registerFormBridge` builds its handlers per form, with that form's adapter,
  `pendingMode`, `agent` and close handling, then joins the `"form"` router. The
  shared tools are registered once, under the single owner `"form-bridge"`.
  Each one resolves `form` and then calls the chosen form's handler, so the
  activity, presence target and outcome-unknown settling stay per form.
- Resolution: with exactly one form mounted `form` is optional. With two or
  more, a call without it is an error listing the ids. An id that is not
  mounted is an error listing the ids, even when only one form is mounted, so a
  call aimed at a form that has closed never lands on another one.
- A registration whose `adapter.id` is already mounted **replaces** it. A
  duplicate cannot be told apart from a remount whose cleanup has not run yet,
  and 0.51.0 already let the same form re-register, so this keeps that
  behaviour. The earlier registration's `dispose()` then leaves the newer one
  in place. A missing or empty `adapter.id` throws.
- Tool descriptions are now generic (the "Cons" above). `form_describe` still
  returns the form's `id` and `title` in its result.

Acceptance tests: `src/bridges/__tests__/forms-multi.test.ts` (the form
behaviour) and `src/bridges/__tests__/multi-instance.test.ts` (the helper).

### Adopting it in another bridge (charts, grids, code, scene, …)

Charts and grids have the same shape as forms did: tools named for the family
(`chart_set_option`, `grid_sort`), a registrant id carrying `adapter.id`, and
handlers that close over one adapter. Adopting the router takes four steps:

1. **Lift the tool definitions out of the factory** into a module-level list,
   and add the selecting argument (`chart`, `grid`) to every tool's schema as
   an optional string.
2. **Build the handlers per instance** inside `register<X>Bridge`, wrapped with
   `wrapToolWithActivity` using that instance's agent and `screenId`, into a
   `name -> handler` record. Today they are registered directly.
3. **Write an `install(router)`** that registers each shared tool under one
   family owner (`"chart-bridge"`). Its handler calls
   `router.resolve(args.<argument>)`, returns the error if resolution fails,
   and otherwise calls `instance.handlers[name](args)`. Add a `<family>_list`
   tool. On a registration failure, withdraw whatever was already registered
   and rethrow, as `installFormTools` does.
4. **Join and leave.** Call `joinInstanceRouter(host, { family, argument,
   listTool, install }, adapter.id, { adapter, handlers })`, and make the
   bridge's `dispose()` call `leave()` and then settle anything that
   instance still has pending.

Per-bridge points to check:

- **Undo** (grid, charts): `pushUndoEntry` closes over the instance's own
  adapter, so it is per instance already. The entry's `bridgeId`
  (`grid:<id>`) should keep naming the instance.
- **Descriptions** that name the instance today become generic. The
  `<family>_list` result carries the names instead.
- **Census:** `tool-name-census.test.ts` builds each bridge with a proxy
  adapter whose `id` is not a string. Coerce the id with `String(...)` as
  `registerFormBridge` does, or the census throws.
- Bridges that already scope their names (screen-doc's `surface`) or are
  inherently singletons (navigation, screens, tui) should not adopt it.
