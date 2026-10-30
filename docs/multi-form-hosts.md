# Several forms on one host — design note

**Status: proposal, not implemented. The choice is the owner's.** Written
2026-10-30 against 0.51.0, prompted by a consumer asking for the supported model.

## Where it stands

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

Today's supported answer is **one form bridge per host**.

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
