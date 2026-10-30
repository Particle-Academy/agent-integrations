import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";
import type { AgentTarget } from "../presence/types";
import { emitActivity } from "../presence/registry";
import { commit, hostErrorMessage } from "./host-commit";

/**
 * Field descriptor — what the host says about each form field. Mirrors the
 * subset of HTML / react-fancy input shapes agents care about.
 */
export type FormFieldDescriptor = {
  /** Form-local field name. Matches the key the host uses in its values map. */
  name: string;
  /** Display label. */
  label?: string;
  /** Logical type. Drives validation + agent expectations. */
  type:
    | "text"
    | "textarea"
    | "number"
    | "email"
    | "password"
    | "url"
    | "date"
    | "select"
    | "multi-select"
    | "checkbox"
    | "switch"
    | "radio"
    | "file"
    | "json";
  /** Allowed values for select / radio. */
  options?: Array<{ value: string; label: string }>;
  /** Whether the field must be filled before submit. */
  required?: boolean;
  /** Free-text hint surfaced to the agent. */
  description?: string;
  /** Default value (presented in get_value when nothing set). */
  defaultValue?: unknown;
};

/**
 * Adapter the host wires per form. Matches the controlled-state pattern
 * react-fancy already uses (`value` / `onValueChange`); this adapter just
 * exposes those state slots in a form-shaped way the bridge can call.
 *
 * `setValue` / `setValues` may be sync (`void`) or async (a Promise); see
 * {@link FormAdapterCommit}. Return a Promise when the host's write is
 * authoritative — a persisted draft, or one the host can refuse or report
 * stale — so the agent is told the truth instead of "success" before anything
 * was accepted.
 *
 * This bridge pushes NO undo entries: `agent_undo` cannot revert a form write.
 */
export type FormBridgeAdapter = {
  /** Stable id for the form (used in form_describe + presence target). */
  id: string;
  /** Display title for human-readable logs. */
  title?: string;
  /** Optional fancy-screens screen id this form belongs to. */
  screenId?: string;
  /** Field descriptors. The bridge uses these for schema introspection
   *  (form_describe). Agents call this first to know what to fill. */
  getFields: () => FormFieldDescriptor[];
  /** Read a single field's current value. */
  getValue: (name: string) => unknown;
  /** Read all values as { fieldName: value }. */
  getValues: () => Record<string, unknown>;
  /**
   * Set a single field's value. The host wires this to its setState, or to
   * an authoritative write it awaits. Sync `void` behaves as it always has; a
   * Promise is awaited, and a rejection or `{ ok: false }` is the tool's error.
   */
  setValue: (name: string, value: unknown) => FormAdapterCommit;
  /**
   * Set many at once, ideally as one host commit. Same sync/async contract as
   * `setValue`. When absent, the bridge awaits `setValue` once per field in
   * order and stops at the first refusal (so that path is NOT atomic).
   */
  setValues?: (values: Record<string, unknown>) => FormAdapterCommit;
  /** Programmatically focus a field (host implements DOM focus). Optional. */
  focus?: (name: string) => void;
  /** Submit the form. Returns the values that were submitted (or rejection). */
  submit?: () => Promise<{ ok: boolean; values?: Record<string, unknown>; error?: string }>;
  /**
   * Human confirm gate for `form_submit` (trust-but-verify). When `pendingMode`
   * is on, the bridge calls this before submitting; return false to decline.
   * Wire it to a human control — submitting a form is a human-visible,
   * often-destructive action (checkout, delete, invite).
   */
  confirm?: (request: FormConfirmRequest) => Promise<boolean> | boolean;
};

/**
 * What an async `setValue` / `setValues` may resolve to, to acknowledge (or
 * refuse) a write. `{ ok: false }` is a refusal the agent can act on: `error`
 * is shown to the agent verbatim, so keep it a human-readable sentence (e.g.
 * "Draft changed since you read it; re-read and retry"), never a stack trace or
 * an internal path. `code` (e.g. `"stale"`, `"forbidden"`) is for the host's own
 * use; it is not shown to the agent.
 */
export type FormAdapterResult = { ok: true } | { ok: false; error: string; code?: string };

/**
 * Return type of `setValue` / `setValues`. A sync `void` return keeps the
 * original behaviour. A Promise makes the bridge WAIT: the tool reports
 * success, and emits its AgentActivity event, only after the promise resolves
 * (to `void` or `{ ok: true }`). A rejection or `{ ok: false }` becomes that
 * tool call's error result and emits no activity. If the bridge is disposed
 * while the write is pending, the call settles at once as an error saying the
 * outcome is unknown, and a later settle is ignored.
 */
export type FormAdapterCommit = void | Promise<void | FormAdapterResult>;

/** What a `form_submit` confirm gate is asked to approve. */
export type FormConfirmRequest = {
  action: "submit";
  form: string;
  title?: string;
  values: Record<string, unknown>;
};

export type FormBridgeOptions = {
  adapter: FormBridgeAdapter;
  /** Identity tagged into activity events. */
  agent?: { id: string; name?: string; color?: string };
  /**
   * Stage `form_submit` for human confirmation via `adapter.confirm` instead of
   * submitting immediately. **Default: ON** (matches the navigation bridge and
   * the Human+ trust-but-verify contract). Set false only when auto-submit is
   * safe. If on without an `adapter.confirm`, submit proceeds (nothing to gate).
   */
  pendingMode?: boolean;
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };

/**
 * registerFormBridge — wires schema-driven MCP access to a single form.
 *
 * ONE form bridge per host. The tool names (`form_set_value`, …) are not
 * scoped to the form id, so since 0.51.0 a second form bridge with a different
 * adapter id on the same host throws (the duplicate-registrant refusal); a
 * remount of the SAME form re-registers fine. For several forms, give each its
 * own host for now — see `docs/multi-form-hosts.md`.
 */
export function registerFormBridge(
  host: ToolHost,
  options: FormBridgeOptions,
): Bridge {
  const { adapter } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const pendingMode = options.pendingMode ?? true;
  const disposers: Array<() => void> = [];
  // The bridge id is also its registrant identity on the host: the same bridge
  // may re-register (a remount), a different one claiming a name is refused.
  const bridgeId = `form:${adapter.id}`;

  // agent_undo / agent_redo / agent_history are registered whenever any bridge
  // mounts, so undo availability doesn't hinge on which bridges are co-present.
  ensureUndoToolsRegistered(host, { defaultAgentId: agent.id });
  const formId = adapter.id;

  // Close handling. A host may dispose the bridge (the form unmounts) while a
  // write or a human confirm is still pending; its promise may then never
  // settle. Every awaited host call is raced against dispose, so the tool call
  // settles at once instead of hanging, and a late settle is ignored.
  let disposed = false;
  const onDispose = new Set<() => void>();
  const CLOSED: unique symbol = Symbol("form-closed");
  const untilClosed = <T>(p: Promise<T>): Promise<T | typeof CLOSED> => {
    if (disposed) {
      p.catch(() => {}); // a late rejection must never be unhandled
      return Promise.resolve(CLOSED);
    }
    return new Promise<T | typeof CLOSED>((resolve, reject) => {
      const close = () => resolve(CLOSED);
      onDispose.add(close);
      p.then(
        (v) => { onDispose.delete(close); resolve(v); },
        (e) => { onDispose.delete(close); reject(e); },
      );
    });
  };
  const closedUnknown = (what: string) =>
    errorResult(
      `Form "${formId}" was closed before the host confirmed ${what}, so whether it was applied is unknown. ` +
        "Do not assume it was. If the form is open again, read it back (form_get_values) before retrying.",
    );

  const target =(args: any): AgentTarget => ({
    kind: "form",
    screenId: adapter.screenId,
    elementId: typeof args?.field === "string" ? `${formId}:${args.field}` : formId,
    label: typeof args?.field === "string"
      ? `${adapter.title ?? formId} → ${args.field}`
      : adapter.title ?? formId,
  });

  const reg = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: JsonObject) => Promise<any> | any,
    isMutation: boolean,
  ) => {
    const wrapped = async (args: JsonObject) => {
      try {
        return await handler(args);
      } catch (e) {
        return errorResult(hostErrorMessage(e, `${name} failed.`));
      }
    };
    const final = isMutation
      ? wrapToolWithActivity(wrapped, {
          toolName: name,
          agent: { id: agent.id, name: agent.name, color: agent.color },
          kind: "form",
          screenId: adapter.screenId,
          resolveTarget: ({ args }) => target(args),
        })
      : wrapped;
    disposers.push(
      host.registerTool(
        {
          name,
          description,
          inputSchema: { type: "object", properties: properties as any, required, additionalProperties: false },
        },
        final as any,
        { owner: bridgeId },
      ),
    );
  };

  // ───────────── Read tools ─────────────

  reg(
    "form_describe",
    `Describe the form "${formId}" — fields, types, options, required flags. Call this first to know what's fillable.`,
    {},
    [],
    () => {
      const fields = adapter.getFields();
      const text = fields
        .map((f) => `${f.name}${f.required ? "*" : ""} (${f.type})${f.label ? ` — ${f.label}` : ""}`)
        .join("\n");
      return textResult(text || "(no fields)", { id: formId, title: adapter.title, fields });
    },
    false,
  );

  reg(
    "form_get_value",
    "Read a single field's current value.",
    { field: { type: "string" } },
    ["field"],
    (args) => {
      const name = String(args.field ?? "");
      if (!adapter.getFields().find((f) => f.name === name)) {
        return errorResult(`Unknown field: ${name}`);
      }
      const value = adapter.getValue(name);
      return textResult(JSON.stringify(value), { field: name, value });
    },
    false,
  );

  reg(
    "form_get_values",
    "Read every field's current value as a JSON object.",
    {},
    [],
    () => {
      const values = adapter.getValues();
      return textResult(JSON.stringify(values, null, 2), values);
    },
    false,
  );

  // ───────────── Mutation tools ─────────────

  reg(
    "form_set_value",
    "Set one field's value. The host's controlled state updates and the human sees the field change.",
    {
      field: { type: "string" },
      value: { description: "Value to set. Type depends on the field's `type`." },
    },
    ["field", "value"],
    async (args) => {
      const name = String(args.field ?? "");
      const fieldDef = adapter.getFields().find((f) => f.name === name);
      if (!fieldDef) return errorResult(`Unknown field: ${name}`);
      const done = await untilClosed(
        commit(() => adapter.setValue(name, args.value), `Host refused the write to "${name}".`),
      );
      if (done === CLOSED) return closedUnknown(`the write to "${name}"`);
      if (!done.ok) return errorResult(done.error);
      return textResult(`${name} ← ${JSON.stringify(args.value)}`, { field: name, value: args.value });
    },
    true,
  );

  reg(
    "form_set_values",
    "Set multiple fields atomically. Pass a `values` object keyed by field name.",
    { values: { type: "object" } },
    ["values"],
    async (args) => {
      const values = (args.values && typeof args.values === "object") ? args.values as Record<string, unknown> : {};
      const fields = adapter.getFields();
      const known = new Set(fields.map((f) => f.name));
      const unknownKeys = Object.keys(values).filter((k) => !known.has(k));
      if (unknownKeys.length) return errorResult(`Unknown fields: ${unknownKeys.join(", ")}`);
      const setValues = adapter.setValues;
      if (setValues) {
        const done = await untilClosed(commit(() => setValues(values), "Host refused the write."));
        if (done === CLOSED) return closedUnknown("the write");
        if (!done.ok) return errorResult(done.error);
      } else {
        // No batch setter: one host commit per field, in order, stopping at the
        // first refusal. Earlier fields stay committed, so say exactly which.
        const keys = Object.keys(values);
        const committed: string[] = [];
        for (const [i, k] of keys.entries()) {
          const done = await untilClosed(
            commit(() => adapter.setValue(k, values[k]), `Host refused the write to "${k}".`),
          );
          if (done === CLOSED) {
            return {
              ...closedUnknown(`the write to "${k}"`),
              structuredContent: { committed, pending: k, notAttempted: keys.slice(i + 1) },
            };
          }
          if (!done.ok) {
            const state = { committed, failed: k, notAttempted: keys.slice(i + 1) };
            if (committed.length) {
              // Those writes DID commit; every committed mutation is observable,
              // and wrapToolWithActivity skips error results, so emit it here.
              emitActivity({
                agentId: agent.id,
                agentName: agent.name,
                agentColor: agent.color,
                target: target({}),
                action: "form_set_values",
                timestamp: Date.now(),
                meta: state,
              });
            }
            return {
              ...errorResult(
                `"${k}" was refused: ${done.error} ` +
                  (committed.length
                    ? `Already committed and NOT rolled back: ${committed.join(", ")}. `
                    : "Nothing was committed. ") +
                  (state.notAttempted.length ? `Not attempted: ${state.notAttempted.join(", ")}.` : ""),
              ),
              structuredContent: state,
            };
          }
          committed.push(k);
        }
      }
      return textResult(`Set ${Object.keys(values).length} field(s)`, { values });
    },
    true,
  );

  reg(
    "form_focus",
    "Move browser focus to a field (host-implemented). Useful before streaming text into it.",
    { field: { type: "string" } },
    ["field"],
    (args) => {
      const name = String(args.field ?? "");
      if (!adapter.focus) return errorResult("Host did not provide a focus implementation.");
      if (!adapter.getFields().find((f) => f.name === name)) {
        return errorResult(`Unknown field: ${name}`);
      }
      adapter.focus(name);
      return textResult(`Focused ${name}`, { field: name });
    },
    true,
  );

  reg(
    "form_submit",
    "Submit the form. Host returns ok + values (or an error). In pendingMode this is staged for the human to confirm first.",
    {},
    [],
    async () => {
      if (!adapter.submit) return errorResult("Host did not provide a submit implementation.");
      // Trust-but-verify: a form submit is a human-visible / often-destructive
      // action, so gate it on a human confirm when one is wired.
      if (pendingMode && adapter.confirm) {
        const confirm = adapter.confirm;
        const ok = await untilClosed(Promise.resolve().then(() => confirm({
          action: "submit",
          form: formId,
          title: adapter.title,
          values: adapter.getValues(),
        })));
        // The form went away while the human was deciding: never submit a
        // form that is no longer on screen, whatever the late answer is.
        if (ok === CLOSED) {
          return errorResult(`Form "${formId}" was closed before the submit was confirmed. Nothing was submitted.`);
        }
        if (!ok) return errorResult("Declined by user");
      }
      const submit = adapter.submit;
      const result = await untilClosed(Promise.resolve().then(() => submit()));
      if (result === CLOSED) return closedUnknown("the submit");
      if (!result.ok) return errorResult(hostErrorMessage(result.error, "Submit failed"));
      return textResult("Submitted", { values: result.values });
    },
    true,
  );

  return {
    id: bridgeId,
    title: adapter.title ?? formId,
    dispose: () => {
      disposed = true;
      for (const d of disposers) d();
      // Settle every call still waiting on the host; see untilClosed.
      for (const close of [...onDispose]) close();
      onDispose.clear();
    },
  };
}
