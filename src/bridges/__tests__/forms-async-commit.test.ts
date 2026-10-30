import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerFormBridge, type FormBridgeAdapter, type FormAdapterResult } from "../forms";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import { onActivity, resetActivityRegistry } from "../../presence";
import type { JsonObject } from "../../mcp/types";

/**
 * A form host whose writes are asynchronous and authoritative (a persisted
 * draft, a server that can refuse or report the draft stale) must be able to
 * make the bridge WAIT. Success, and the AgentActivity event that rides on it,
 * may only be reported once the host has accepted the write; a refusal must be
 * THAT tool call's error. Same contract as the screens bridge (0.49.0).
 */

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * The host's committed state lives in `store`. An async setter that is gated
 * only writes `store` when its gate resolves, the way a host that persists
 * first and then updates its controlled state would.
 */
function setup(overrides: Partial<FormBridgeAdapter> = {}) {
  const store: Record<string, unknown> = { email: "old@example.com", name: "Old" };
  const host = new ToolRegistry();
  const adapter: FormBridgeAdapter = {
    id: "signup",
    title: "Sign up",
    getFields: () => [
      { name: "email", type: "email" },
      { name: "name", type: "text" },
    ],
    getValue: (n) => store[n],
    getValues: () => ({ ...store }),
    setValue: (n, v) => { store[n] = v; },
    submit: vi.fn(async () => ({ ok: true, values: { ...store } })),
    ...overrides,
  };
  const bridge = registerFormBridge(host, { adapter });

  const activity: Array<{ action: string; meta?: Record<string, unknown> }> = [];
  onActivity((e) => { activity.push({ action: e.action, meta: e.meta }); });

  const call = async (name: string, args: JsonObject = {}) => {
    const r = await host.callTool(name, args);
    return {
      isError: r.isError === true,
      text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "",
      structured: r.structuredContent as Record<string, unknown> | undefined,
    };
  };
  return { host, call, activity, store, bridge, adapter };
}

describe("form bridge — acknowledge after the host commits", () => {
  beforeEach(() => {
    resetAllUndoStacks();
    resetActivityRegistry();
  });

  describe("form_set_value", () => {
    it("gated success: the result arrives only after the gate releases, then reads see the new value", async () => {
      const gate = deferred<void>();
      const ctx = setup();
      const { call, activity, store } = ctx;
      ctx.adapter.setValue = (n, v) => gate.promise.then(() => { store[n] = v; });

      let settled = false;
      const pending = call("form_set_value", { field: "email", value: "new@example.com" })
        .then((r) => { settled = true; return r; });
      await flush();

      expect(settled).toBe(false);
      expect(activity).toHaveLength(0);
      expect((await call("form_get_value", { field: "email" })).structured?.value).toBe("old@example.com");

      gate.resolve();
      const r = await pending;
      expect(r.isError).toBe(false);
      expect(r.structured).toEqual({ field: "email", value: "new@example.com" });
      expect(activity.map((a) => a.action)).toEqual(["form_set_value"]);
      expect((await call("form_get_value", { field: "email" })).structured?.value).toBe("new@example.com");
    });

    it("gated refusal: a rejection is THIS call's error with the host's message, state unchanged, no activity", async () => {
      const gate = deferred<void>();
      const ctx = setup();
      const { call, activity, store } = ctx;
      ctx.adapter.setValue = (n, v) => gate.promise.then(() => { store[n] = v; });

      let settled = false;
      const pending = call("form_set_value", { field: "email", value: "new@example.com" })
        .then((r) => { settled = true; return r; });
      await flush();
      expect(settled).toBe(false);

      gate.reject(new Error("Draft is locked by another editor"));
      const r = await pending;
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Draft is locked by another editor");
      expect(activity).toHaveLength(0);
      expect(store.email).toBe("old@example.com");
      expect((await call("form_get_value", { field: "email" })).structured?.value).toBe("old@example.com");
    });

    it("an { ok: false } refusal (e.g. a stale draft) is an error carrying the host's error, no activity", async () => {
      const { call, activity, store } = setup({
        setValue: async (): Promise<FormAdapterResult> =>
          ({ ok: false, error: "Draft changed since you read it; re-read and retry", code: "stale" }),
      });

      const r = await call("form_set_value", { field: "email", value: "new@example.com" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Draft changed since you read it; re-read and retry");
      expect(activity).toHaveLength(0);
      expect(store.email).toBe("old@example.com");
    });

    it("accepts an explicit { ok: true } acknowledgement", async () => {
      const { call, activity } = setup({ setValue: async (): Promise<FormAdapterResult> => ({ ok: true }) });

      const r = await call("form_set_value", { field: "email", value: "x@example.com" });
      expect(r.isError).toBe(false);
      expect(activity).toHaveLength(1);
    });

    it("never leaks a stack trace, and never renders a non-Error rejection as [object Object]", async () => {
      const err = new Error("Persist failed");
      err.stack = "Error: Persist failed\n    at saveDraft (/srv/app/secret/path.js:10:5)";
      const a = setup({ setValue: async () => { throw err; } });
      const r1 = await a.call("form_set_value", { field: "email", value: "x" });
      expect(r1.isError).toBe(true);
      expect(r1.text).toContain("Persist failed");
      expect(r1.text).not.toContain("secret/path.js");

      resetActivityRegistry();
      const b = setup({ setValue: () => Promise.reject({ status: 500 }) });
      const r2 = await b.call("form_set_value", { field: "email", value: "x" });
      expect(r2.isError).toBe(true);
      expect(r2.text).not.toContain("[object Object]");
      expect(r2.text.length).toBeGreaterThan(0);
    });
  });

  describe("form_set_values", () => {
    it("waits for an async setValues and reports a refusal as the call's error", async () => {
      const gate = deferred<void>();
      const ctx = setup();
      const { call, activity, store } = ctx;
      ctx.adapter.setValues = (vals) => gate.promise.then(() => { Object.assign(store, vals); });

      let settled = false;
      const pending = call("form_set_values", { values: { email: "a@example.com", name: "A" } })
        .then((r) => { settled = true; return r; });
      await flush();
      expect(settled).toBe(false);
      expect(activity).toHaveLength(0);

      gate.resolve();
      expect((await pending).isError).toBe(false);
      expect(activity.map((a) => a.action)).toEqual(["form_set_values"]);
      expect(store).toMatchObject({ email: "a@example.com", name: "A" });

      ctx.adapter.setValues = async () => ({ ok: false, error: "Read-only draft" });
      const refused = await call("form_set_values", { values: { email: "b@example.com" } });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("Read-only draft");
      expect(activity).toHaveLength(1);
      expect(store.email).toBe("a@example.com");
    });

    it("without setValues, awaits each setValue in turn and states exactly what committed when one is refused", async () => {
      const calls: string[] = [];
      const ctx = setup();
      const { call, activity, store } = ctx;
      ctx.adapter.setValue = async (n, v) => {
        calls.push(n);
        if (n === "name") return { ok: false, error: "Name is managed by your organisation" };
        store[n] = v;
      };

      const r = await call("form_set_values", { values: { email: "a@example.com", name: "A" } });
      expect(calls).toEqual(["email", "name"]);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Name is managed by your organisation");
      expect(r.text).toContain("email");
      expect(r.structured).toMatchObject({ committed: ["email"], failed: "name", notAttempted: [] });
      // email DID commit, so presence must still see one event for it.
      expect(activity).toHaveLength(1);
      expect(activity[0]!.meta).toMatchObject({ committed: ["email"] });
      expect(store).toMatchObject({ email: "a@example.com", name: "Old" });
    });
  });

  describe("close / dispose during a pending write", () => {
    it("settles the pending call as an error stating the outcome is unknown, and emits no activity even if the host later accepts", async () => {
      const gate = deferred<void>();
      const ctx = setup();
      const { call, activity, store, bridge } = ctx;
      ctx.adapter.setValue = (n, v) => gate.promise.then(() => { store[n] = v; });

      const pending = call("form_set_value", { field: "email", value: "new@example.com" });
      await flush();
      bridge.dispose();

      const r = await pending;
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/closed/i);
      expect(r.text).toMatch(/unknown/i);

      gate.resolve();
      await flush();
      expect(activity).toHaveLength(0);
    });

    it("a late host rejection after dispose is swallowed, not an unhandled rejection", async () => {
      const gate = deferred<void>();
      const { call, bridge } = setup({ setValue: () => gate.promise });

      const pending = call("form_set_value", { field: "email", value: "x" });
      await flush();
      bridge.dispose();
      expect((await pending).isError).toBe(true);

      gate.reject(new Error("too late"));
      await flush();
      // vitest fails the run on an unhandled rejection; reaching here is the assertion.
    });

    it("does not submit when the form closes while the human confirm is pending", async () => {
      const confirmGate = deferred<boolean>();
      const ctx = setup({ confirm: () => confirmGate.promise });
      const { call, activity, bridge, adapter } = ctx;

      const pending = call("form_submit");
      await flush();
      bridge.dispose();

      const r = await pending;
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/closed/i);

      confirmGate.resolve(true);
      await flush();
      expect(adapter.submit).not.toHaveBeenCalled();
      expect(activity).toHaveLength(0);
    });

    it("a submit pending at close settles as unknown, and its late rejection is swallowed", async () => {
      const submitGate = deferred<{ ok: boolean }>();
      const { call, activity, bridge } = setup({ submit: () => submitGate.promise, confirm: async () => true });

      const pending = call("form_submit");
      await flush();
      bridge.dispose();
      const r = await pending;
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/unknown/i);

      submitGate.reject(new Error("server gone"));
      await flush();
      expect(activity).toHaveLength(0);
    });

    it("a confirm that rejects while the form is open is the tool's error, and nothing is submitted", async () => {
      const { call, adapter } = setup({ confirm: async () => { throw new Error("Approval service unavailable"); } });
      const r = await call("form_submit");
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Approval service unavailable");
      expect(adapter.submit).not.toHaveBeenCalled();
    });

    it("a write started after dispose is not reachable (tools are withdrawn)", async () => {
      const { call, bridge } = setup();
      bridge.dispose();
      await expect(call("form_set_value", { field: "email", value: "x" })).rejects.toThrow(/withdrawn/);
    });
  });

  describe("sync setters behave exactly as before", () => {
    it("sets synchronously, returns the same text, and emits one activity each", async () => {
      const { call, activity, store } = setup();

      const one = await call("form_set_value", { field: "email", value: "s@example.com" });
      expect(one.isError).toBe(false);
      expect(one.text).toBe('email ← "s@example.com"');
      expect(one.structured).toEqual({ field: "email", value: "s@example.com" });

      const many = await call("form_set_values", { values: { name: "S" } });
      expect(many.text).toBe("Set 1 field(s)");
      expect(many.structured).toEqual({ values: { name: "S" } });

      expect(store).toMatchObject({ email: "s@example.com", name: "S" });
      expect(activity.map((a) => a.action)).toEqual(["form_set_value", "form_set_values"]);
    });

    it("still surfaces a synchronous throw as an error with no activity", async () => {
      const { call, activity } = setup({ setValue: () => { throw new Error("sync boom"); } });

      const r = await call("form_set_value", { field: "email", value: "x" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("sync boom");
      expect(activity).toHaveLength(0);
    });

    it("still refuses an unknown field without calling the setter", async () => {
      const setValue = vi.fn();
      const { call, activity } = setup({ setValue });
      const r = await call("form_set_value", { field: "nope", value: 1 });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Unknown field: nope");
      expect(setValue).not.toHaveBeenCalled();
      expect(activity).toHaveLength(0);
    });
  });
});
