import { type ReactNode, useEffect, useMemo, useRef } from "react";
import type { MicroMcpServer } from "../../mcp/server";
import { registerFormBridge, type FormBridgeAdapter, type FormFieldDescriptor } from "../../bridges/forms";

export type BridgedFormProps = {
  /** Stable id for this form. Used by agents in `form_*` tool calls. */
  id: string;
  /** Human title (also surfaced as the bridge title). */
  title?: string;
  /** Optional fancy-screens screen id this form lives in. */
  screenId?: string;
  /** Field descriptors — drives the agent-facing schema. */
  fields: FormFieldDescriptor[];
  /** Controlled values. */
  values: Record<string, unknown>;
  /** Setter — hosts pass their setState. */
  onChange: (next: Record<string, unknown>) => void;
  /** Optional submit handler. */
  onSubmit?: () => Promise<{ ok: boolean; values?: Record<string, unknown>; error?: string }>;
  /** The MicroMcpServer the bridge registers against. Pass null/undefined
   *  to render without a bridge (useful for stories / non-shared use). */
  server?: MicroMcpServer | null;
  /** Identity used in activity events. */
  agent?: { id: string; name?: string; color?: string };
  children: ReactNode;
};

/**
 * BridgedForm — wraps a react-fancy form (or any controlled inputs)
 * with a `registerFormBridge` lifecycle. Children render the actual form
 * using `values` + `onChange`; this component only manages the bridge.
 *
 * Hosts use it like:
 *
 *   <BridgedForm id="signup" fields={...} values={values} onChange={setValues} server={server}>
 *     <Field><Input value={values.email} onValueChange={(v) => onChange({ ...values, email: v })} /></Field>
 *     ...
 *   </BridgedForm>
 *
 * Agents can then call form_describe, form_set_value, form_submit, etc.
 */
export function BridgedForm({
  id,
  title,
  screenId,
  fields,
  values,
  onChange,
  onSubmit,
  server,
  agent,
  children,
}: BridgedFormProps) {
  // Refs so the adapter sees fresh values without re-installing the bridge.
  const valuesRef = useRef(values);
  const onChangeRef = useRef(onChange);
  const fieldsRef = useRef(fields);
  const submitRef = useRef(onSubmit);
  useEffect(() => { valuesRef.current = values; }, [values]);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { fieldsRef.current = fields; }, [fields]);
  useEffect(() => { submitRef.current = onSubmit; }, [onSubmit]);

  const focusElement = (name: string) => {
    if (typeof document === "undefined") return;
    const el = document.querySelector(`[data-form-id="${id}"] [name="${name}"]`) as HTMLElement | null;
    el?.focus();
  };

  const adapter = useMemo<FormBridgeAdapter>(() => ({
    id,
    title,
    screenId,
    getFields: () => fieldsRef.current,
    getValue: (name) => valuesRef.current[name],
    getValues: () => ({ ...valuesRef.current }),
    setValue: (name, v) => onChangeRef.current({ ...valuesRef.current, [name]: v }),
    setValues: (next) => onChangeRef.current({ ...valuesRef.current, ...next }),
    focus: focusElement,
    submit: async () => {
      if (!submitRef.current) {
        return { ok: true, values: { ...valuesRef.current } };
      }
      return submitRef.current();
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [id, title, screenId]);

  useEffect(() => {
    if (!server) return;
    const bridge = registerFormBridge(server, { adapter, agent });
    return () => bridge.dispose();
  }, [server, adapter, agent]);

  return <div data-form-id={id}>{children}</div>;
}
