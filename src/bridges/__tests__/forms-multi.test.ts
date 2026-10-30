import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerFormBridge, type FormBridgeAdapter } from "../forms";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import { onActivity, resetActivityRegistry } from "../../presence";
import type { JsonObject } from "../../mcp/types";

/**
 * Several forms on one host (docs/multi-form-hosts.md, option A, chosen by the
 * owner on 2026-10-30). The first registerFormBridge on a host creates the form
 * tools; later ones JOIN them. Every form tool takes a `form` argument, which is
 * optional while exactly one form is mounted, and `form_list` says what is.
 */

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeForm(id: string, fields: string[], overrides: Partial<FormBridgeAdapter> = {}) {
  const store: Record<string, unknown> = Object.fromEntries(fields.map((f) => [f, ""]));
  const adapter: FormBridgeAdapter = {
    id,
    title: `${id} form`,
    screenId: `screen-${id}`,
    getFields: () => fields.map((name) => ({ name, type: "text" as const })),
    getValue: (n) => store[n],
    getValues: () => ({ ...store }),
    setValue: vi.fn((n: string, v: unknown) => { store[n] = v; }),
    submit: vi.fn(async () => ({ ok: true, values: { ...store } })),
    ...overrides,
  };
  return { adapter, store };
}

async function call(host: ToolRegistry, name: string, args: JsonObject = {}) {
  const r = await host.callTool(name, args);
  return {
    isError: r.isError === true,
    text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "",
    structured: r.structuredContent as any,
  };
}

const FORM_TOOLS = [
  "form_describe",
  "form_get_value",
  "form_get_values",
  "form_set_value",
  "form_set_values",
  "form_focus",
  "form_submit",
  "form_list",
];

describe("several forms on one host", () => {
  beforeEach(() => {
    resetAllUndoStacks();
    resetActivityRegistry();
  });

  it("a second form JOINS instead of throwing, and both are drivable", async () => {
    const host = new ToolRegistry();
    const billing = makeForm("billing", ["street"]);
    const shipping = makeForm("shipping", ["street"]);
    registerFormBridge(host, { adapter: billing.adapter });
    expect(() => registerFormBridge(host, { adapter: shipping.adapter })).not.toThrow();

    expect((await call(host, "form_set_value", { form: "billing", field: "street", value: "1 Bill St" })).isError).toBe(false);
    expect((await call(host, "form_set_value", { form: "shipping", field: "street", value: "2 Ship Rd" })).isError).toBe(false);

    expect(billing.store.street).toBe("1 Bill St");
    expect(shipping.store.street).toBe("2 Ship Rd");
  });

  it("keeps one stable tool list however many forms are mounted", () => {
    const host = new ToolRegistry();
    registerFormBridge(host, { adapter: makeForm("a", ["x"]).adapter });
    const one = host.listTools().map((t) => t.name).sort();
    registerFormBridge(host, { adapter: makeForm("b", ["x"]).adapter });
    registerFormBridge(host, { adapter: makeForm("c", ["x"]).adapter });
    expect(host.listTools().map((t) => t.name).sort()).toEqual(one);
    for (const name of FORM_TOOLS) expect(host.getTool(name), name).not.toBeNull();
  });

  it("every form tool declares an optional string `form` argument", () => {
    const host = new ToolRegistry();
    registerFormBridge(host, { adapter: makeForm("a", ["x"]).adapter });
    for (const name of FORM_TOOLS.filter((n) => n !== "form_list")) {
      const schema = host.getTool(name)!.definition.inputSchema as any;
      expect(schema.properties.form, name).toMatchObject({ type: "string" });
      expect(schema.required ?? [], name).not.toContain("form");
    }
  });

  it("form_list lists every mounted form with its id, title, screen and fields", async () => {
    const host = new ToolRegistry();
    registerFormBridge(host, { adapter: makeForm("billing", ["street", "zip"]).adapter });
    registerFormBridge(host, { adapter: makeForm("shipping", ["street"]).adapter });

    const r = await call(host, "form_list");
    expect(r.isError).toBe(false);
    expect(r.structured.forms).toEqual([
      {
        id: "billing",
        title: "billing form",
        screenId: "screen-billing",
        fields: [{ name: "street", type: "text" }, { name: "zip", type: "text" }],
      },
      {
        id: "shipping",
        title: "shipping form",
        screenId: "screen-shipping",
        fields: [{ name: "street", type: "text" }],
      },
    ]);
    expect(r.text).toContain("billing");
    expect(r.text).toContain("shipping");
  });

  it("routes every tool by `form` to the right adapter", async () => {
    const host = new ToolRegistry();
    const billing = makeForm("billing", ["street"]);
    const shipping = makeForm("shipping", ["street"], { focus: vi.fn() });
    billing.store.street = "B";
    shipping.store.street = "S";
    registerFormBridge(host, { adapter: billing.adapter, pendingMode: false });
    registerFormBridge(host, { adapter: shipping.adapter, pendingMode: false });

    expect((await call(host, "form_describe", { form: "shipping" })).structured.id).toBe("shipping");
    expect((await call(host, "form_get_value", { form: "billing", field: "street" })).structured.value).toBe("B");
    expect((await call(host, "form_get_values", { form: "shipping" })).structured).toEqual({ street: "S" });

    await call(host, "form_set_values", { form: "shipping", values: { street: "S2" } });
    expect(shipping.store.street).toBe("S2");
    expect(billing.store.street).toBe("B");

    await call(host, "form_focus", { form: "shipping", field: "street" });
    expect(shipping.adapter.focus).toHaveBeenCalledWith("street");

    await call(host, "form_submit", { form: "billing" });
    expect(billing.adapter.submit).toHaveBeenCalledTimes(1);
    expect(shipping.adapter.submit).not.toHaveBeenCalled();
  });

  it("refuses a call without `form` while two are mounted, listing both ids, and writes nothing", async () => {
    const host = new ToolRegistry();
    const billing = makeForm("billing", ["street"]);
    const shipping = makeForm("shipping", ["street"]);
    registerFormBridge(host, { adapter: billing.adapter });
    registerFormBridge(host, { adapter: shipping.adapter });

    const r = await call(host, "form_set_value", { field: "street", value: "?" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("billing");
    expect(r.text).toContain("shipping");
    expect(r.text).toContain("form_list");
    expect(billing.adapter.setValue).not.toHaveBeenCalled();
    expect(shipping.adapter.setValue).not.toHaveBeenCalled();
  });

  it("refuses an unknown `form`, listing the mounted ids — even when only one is mounted", async () => {
    const host = new ToolRegistry();
    const billing = makeForm("billing", ["street"]);
    registerFormBridge(host, { adapter: billing.adapter });

    const r = await call(host, "form_set_value", { form: "shipping", field: "street", value: "?" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"shipping"');
    expect(r.text).toContain('"billing"');
    expect(billing.adapter.setValue).not.toHaveBeenCalled();
  });

  it("with one form mounted, every existing call shape works without `form`", async () => {
    const host = new ToolRegistry();
    const signup = makeForm("signup", ["email"], { focus: vi.fn() });
    registerFormBridge(host, { adapter: signup.adapter, pendingMode: false });

    expect((await call(host, "form_describe")).structured.id).toBe("signup");
    expect((await call(host, "form_set_value", { field: "email", value: "a@example.com" })).isError).toBe(false);
    expect((await call(host, "form_get_value", { field: "email" })).structured.value).toBe("a@example.com");
    expect((await call(host, "form_set_values", { values: { email: "b@example.com" } })).isError).toBe(false);
    expect((await call(host, "form_get_values")).structured).toEqual({ email: "b@example.com" });
    expect((await call(host, "form_focus", { field: "email" })).isError).toBe(false);
    expect((await call(host, "form_submit")).isError).toBe(false);
    expect(signup.adapter.submit).toHaveBeenCalled();
  });

  it("a second form with a missing id is a clear error, and the first keeps working", async () => {
    const host = new ToolRegistry();
    const billing = makeForm("billing", ["street"]);
    registerFormBridge(host, { adapter: billing.adapter });
    expect(() => registerFormBridge(host, { adapter: makeForm("", ["x"]).adapter })).toThrow(/adapter\.id/);
    expect(() =>
      registerFormBridge(host, { adapter: { ...makeForm("x", ["x"]).adapter, id: undefined as never } }),
    ).toThrow(/adapter\.id/);
    expect((await call(host, "form_set_value", { field: "street", value: "ok" })).isError).toBe(false);
    expect((await call(host, "form_list")).structured.forms.map((f: any) => f.id)).toEqual(["billing"]);
  });

  it("a remount of the same id re-joins rather than duplicating, and the stale disposer cannot remove it", async () => {
    const host = new ToolRegistry();
    const first = makeForm("signup", ["email"]);
    const second = makeForm("signup", ["email"]);
    const old = registerFormBridge(host, { adapter: first.adapter });
    registerFormBridge(host, { adapter: second.adapter });

    expect((await call(host, "form_list")).structured.forms.map((f: any) => f.id)).toEqual(["signup"]);
    await call(host, "form_set_value", { field: "email", value: "new" });
    expect(second.store.email).toBe("new");
    expect(first.store.email).toBe("");

    old.dispose(); // the earlier mount's cleanup, arriving late
    expect((await call(host, "form_set_value", { field: "email", value: "newer" })).isError).toBe(false);
    expect(second.store.email).toBe("newer");
  });

  it("disposing one form leaves the other drivable, and form_list reflects mounts and unmounts", async () => {
    const host = new ToolRegistry();
    const billing = makeForm("billing", ["street"]);
    const shipping = makeForm("shipping", ["street"]);
    const b = registerFormBridge(host, { adapter: billing.adapter });
    registerFormBridge(host, { adapter: shipping.adapter });

    b.dispose();
    expect((await call(host, "form_list")).structured.forms.map((f: any) => f.id)).toEqual(["shipping"]);
    // One form is left, so `form` is optional again.
    expect((await call(host, "form_set_value", { field: "street", value: "S" })).isError).toBe(false);
    expect(shipping.store.street).toBe("S");
    // The disposed form is no longer routable.
    const gone = await call(host, "form_set_value", { form: "billing", field: "street", value: "B" });
    expect(gone.isError).toBe(true);
    expect(billing.adapter.setValue).not.toHaveBeenCalled();

    registerFormBridge(host, { adapter: makeForm("gift", ["note"]).adapter });
    expect((await call(host, "form_list")).structured.forms.map((f: any) => f.id)).toEqual(["shipping", "gift"]);
  });

  it("disposing the last form withdraws every form tool; a new form brings them back", async () => {
    const host = new ToolRegistry();
    const a = registerFormBridge(host, { adapter: makeForm("a", ["x"]).adapter });
    const b = registerFormBridge(host, { adapter: makeForm("b", ["x"]).adapter });
    a.dispose();
    for (const name of FORM_TOOLS) expect(host.getTool(name), name).not.toBeNull();
    b.dispose();
    for (const name of FORM_TOOLS) expect(host.getTool(name), name).toBeNull();
    await expect(host.callTool("form_set_value", { field: "x", value: 1 })).rejects.toThrow(/withdrawn/);

    b.dispose(); // idempotent: a second dispose changes nothing
    const c = makeForm("c", ["x"]);
    registerFormBridge(host, { adapter: c.adapter });
    expect((await call(host, "form_set_value", { field: "x", value: 1 })).isError).toBe(false);
    expect(c.store.x).toBe(1);
  });

  it("disposing one form settles only ITS pending write as outcome-unknown", async () => {
    const host = new ToolRegistry();
    const gateA = deferred<void>();
    const gateB = deferred<void>();
    const a = makeForm("a", ["x"]);
    const b = makeForm("b", ["x"]);
    a.adapter.setValue = (n, v) => gateA.promise.then(() => { a.store[n] = v; });
    b.adapter.setValue = (n, v) => gateB.promise.then(() => { b.store[n] = v; });
    const bridgeA = registerFormBridge(host, { adapter: a.adapter });
    registerFormBridge(host, { adapter: b.adapter });

    let bSettled = false;
    const pendingA = call(host, "form_set_value", { form: "a", field: "x", value: 1 });
    const pendingB = call(host, "form_set_value", { form: "b", field: "x", value: 2 }).then((r) => { bSettled = true; return r; });
    await flush();

    bridgeA.dispose();
    const ra = await pendingA;
    expect(ra.isError).toBe(true);
    expect(ra.text).toMatch(/closed/i);
    expect(ra.text).toMatch(/unknown/i);
    expect(ra.text).toContain('"a"');

    await flush();
    expect(bSettled).toBe(false); // b is still open: its write is still waiting on its host
    gateB.resolve();
    const rb = await pendingB;
    expect(rb.isError).toBe(false);
    expect(b.store.x).toBe(2);
  });

  it("async commit and refusal are per form", async () => {
    const host = new ToolRegistry();
    const a = makeForm("a", ["x"]);
    const b = makeForm("b", ["x"]);
    a.adapter.setValue = async () => ({ ok: false, error: "Draft a is stale; re-read and retry." });
    b.adapter.setValue = async (n, v) => { b.store[n] = v; return { ok: true }; };
    registerFormBridge(host, { adapter: a.adapter });
    registerFormBridge(host, { adapter: b.adapter });

    const activity: string[] = [];
    onActivity((e) => { activity.push(e.target.elementId ?? ""); });

    const ra = await call(host, "form_set_value", { form: "a", field: "x", value: 1 });
    expect(ra.isError).toBe(true);
    expect(ra.text).toContain("Draft a is stale");

    const rb = await call(host, "form_set_value", { form: "b", field: "x", value: 2 });
    expect(rb.isError).toBe(false);
    expect(b.store.x).toBe(2);
    expect(activity).toEqual(["b:x"]); // the refusal emitted nothing; the commit named its own form
  });

  it("pendingMode and the confirm gate stay per form", async () => {
    const host = new ToolRegistry();
    const gated = makeForm("gated", ["x"], { confirm: vi.fn(async () => false) });
    const open = makeForm("open", ["x"], { confirm: vi.fn(async () => false) });
    registerFormBridge(host, { adapter: gated.adapter }); // pendingMode defaults on
    registerFormBridge(host, { adapter: open.adapter, pendingMode: false });

    const rg = await call(host, "form_submit", { form: "gated" });
    expect(rg.text).toContain("Declined");
    expect(gated.adapter.confirm).toHaveBeenCalledWith(expect.objectContaining({ form: "gated" }));
    expect(gated.adapter.submit).not.toHaveBeenCalled();

    const ro = await call(host, "form_submit", { form: "open" });
    expect(ro.isError).toBe(false);
    expect(open.adapter.confirm).not.toHaveBeenCalled();
    expect(open.adapter.submit).toHaveBeenCalled();
  });

  it("activity carries each form's own agent, screen and target", async () => {
    const host = new ToolRegistry();
    registerFormBridge(host, {
      adapter: makeForm("billing", ["street"]).adapter,
      agent: { id: "agent-billing", name: "Billing agent" },
    });
    registerFormBridge(host, {
      adapter: makeForm("shipping", ["street"]).adapter,
      agent: { id: "agent-shipping", name: "Shipping agent" },
    });

    const events: Array<{ agentId: string; screenId?: string; elementId?: string; label?: string }> = [];
    onActivity((e) => {
      events.push({ agentId: e.agentId, screenId: e.target.screenId, elementId: e.target.elementId, label: e.target.label });
    });

    await call(host, "form_set_value", { form: "shipping", field: "street", value: "S" });
    await call(host, "form_set_value", { form: "billing", field: "street", value: "B" });

    expect(events).toEqual([
      { agentId: "agent-shipping", screenId: "screen-shipping", elementId: "shipping:street", label: "shipping form → street" },
      { agentId: "agent-billing", screenId: "screen-billing", elementId: "billing:street", label: "billing form → street" },
    ]);
  });

  it("an UNRELATED registrant still cannot take a form tool name", async () => {
    const host = new ToolRegistry();
    registerFormBridge(host, { adapter: makeForm("a", ["x"]).adapter });
    expect(() =>
      host.registerTool(
        { name: "form_set_value", description: "imposter", inputSchema: { type: "object" } },
        async () => ({ content: [] }),
        { owner: "someone-else" },
      ),
    ).toThrow(/already registered/);
    expect(() =>
      host.registerTool(
        { name: "form_list", description: "imposter", inputSchema: { type: "object" } },
        async () => ({ content: [] }),
      ),
    ).toThrow(/already registered/);
  });

  it("refuses to mount when an unrelated registrant already holds a form tool name, and leaves nothing half-installed", async () => {
    const host = new ToolRegistry();
    const imposter = host.registerTool(
      { name: "form_submit", description: "imposter", inputSchema: { type: "object" } },
      async () => ({ content: [] }),
      { owner: "someone-else" },
    );
    expect(() => registerFormBridge(host, { adapter: makeForm("a", ["x"]).adapter })).toThrow(/already registered/);
    expect(host.getTool("form_set_value")).toBeNull();
    expect(host.getTool("form_list")).toBeNull();
    expect(host.getTool("form_submit")!.definition.description).toBe("imposter");

    // No phantom form was left behind: once the imposter leaves, a fresh mount
    // installs the tools and is the ONLY form (so `form` stays optional).
    imposter();
    const b = makeForm("b", ["x"]);
    registerFormBridge(host, { adapter: b.adapter });
    expect((await call(host, "form_list")).structured.forms.map((f: any) => f.id)).toEqual(["b"]);
    expect((await call(host, "form_set_value", { field: "x", value: 1 })).isError).toBe(false);
    expect(b.store.x).toBe(1);
  });

  it("forms on DIFFERENT hosts stay independent", async () => {
    const h1 = new ToolRegistry();
    const h2 = new ToolRegistry();
    const a = makeForm("a", ["x"]);
    const b = makeForm("b", ["x"]);
    registerFormBridge(h1, { adapter: a.adapter });
    registerFormBridge(h2, { adapter: b.adapter });
    // Each host has one form, so `form` is optional on each.
    await call(h1, "form_set_value", { field: "x", value: 1 });
    await call(h2, "form_set_value", { field: "x", value: 2 });
    expect(a.store.x).toBe(1);
    expect(b.store.x).toBe(2);
  });
});
