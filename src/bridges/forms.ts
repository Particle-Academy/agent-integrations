import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";
import type { AgentTarget } from "../presence/types";

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
  /** Set a single field's value. The host wires this to its setState. */
  setValue: (name: string, value: unknown) => void;
  /** Set many at once. Defaults to calling setValue in a loop. */
  setValues?: (values: Record<string, unknown>) => void;
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
 * Hosts can register multiple bridges (one per form on the screen) by
 * giving each adapter a distinct `id`.
 */
export function registerFormBridge(
  host: ToolHost,
  options: FormBridgeOptions,
): Bridge {
  const { adapter } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const pendingMode = options.pendingMode ?? true;
  const disposers: Array<() => void> = [];

  // agent_undo / agent_redo / agent_history are registered whenever any bridge
  // mounts, so undo availability doesn't hinge on which bridges are co-present.
  ensureUndoToolsRegistered(host, { defaultAgentId: agent.id });
  const formId = adapter.id;

  const target = (args: any): AgentTarget => ({
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
        return errorResult(e instanceof Error ? e.message : String(e));
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
    (args) => {
      const name = String(args.field ?? "");
      const fieldDef = adapter.getFields().find((f) => f.name === name);
      if (!fieldDef) return errorResult(`Unknown field: ${name}`);
      adapter.setValue(name, args.value);
      return textResult(`${name} ← ${JSON.stringify(args.value)}`, { field: name, value: args.value });
    },
    true,
  );

  reg(
    "form_set_values",
    "Set multiple fields atomically. Pass a `values` object keyed by field name.",
    { values: { type: "object" } },
    ["values"],
    (args) => {
      const values = (args.values && typeof args.values === "object") ? args.values as Record<string, unknown> : {};
      const fields = adapter.getFields();
      const known = new Set(fields.map((f) => f.name));
      const unknownKeys = Object.keys(values).filter((k) => !known.has(k));
      if (unknownKeys.length) return errorResult(`Unknown fields: ${unknownKeys.join(", ")}`);
      if (adapter.setValues) {
        adapter.setValues(values);
      } else {
        for (const [k, v] of Object.entries(values)) adapter.setValue(k, v);
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
        const ok = await adapter.confirm({
          action: "submit",
          form: formId,
          title: adapter.title,
          values: adapter.getValues(),
        });
        if (!ok) return errorResult("Declined by user");
      }
      const result = await adapter.submit();
      if (!result.ok) return errorResult(result.error ?? "Submit failed");
      return textResult("Submitted", { values: result.values });
    },
    true,
  );

  return {
    id: `form:${formId}`,
    title: adapter.title ?? formId,
    dispose: () => {
      for (const d of disposers) d();
    },
  };
}
