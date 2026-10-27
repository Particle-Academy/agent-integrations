import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerScreensBridge, type ScreensBridgeAdapter, type ScreensAdapterResult } from "../screens";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import { onActivity, resetActivityRegistry } from "../../presence";
import type { JsonObject } from "../../mcp/types";

/**
 * A host whose commit is asynchronous and authoritative (persisted state, a
 * possible refusal or conflict) must be able to make the bridge WAIT for it.
 * Success, and the AgentActivity event that rides on success, may only be
 * reported once the host has actually committed.
 */

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(overrides: Partial<ScreensBridgeAdapter> = {}) {
  const screens = [{ id: "home", active: true }, { id: "other", active: false }];
  const host = new ToolRegistry();
  const adapter: ScreensBridgeAdapter = {
    listScreens: () => screens,
    getActive: () => "home",
    setActive: () => {},
    createScreen: () => {},
    destroyScreen: () => {},
    updateScreenContent: () => {},
    ...overrides,
  };
  registerScreensBridge(host, { adapter });

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
  return { host, call, activity };
}

describe("screens bridge — acknowledge after host commit", () => {
  beforeEach(() => {
    resetAllUndoStacks();
    resetActivityRegistry();
  });

  it("does not report success, or emit activity, until an async setActive resolves", async () => {
    const d = deferred<void>();
    const { call, activity } = setup({ setActive: () => d.promise });

    let settled = false;
    const pending = call("screens_navigate", { screen: "other" }).then((r) => { settled = true; return r; });
    await flush();

    expect(settled).toBe(false);
    expect(activity).toHaveLength(0);

    d.resolve();
    const r = await pending;
    expect(r.isError).toBe(false);
    expect(activity.map((a) => a.action)).toEqual(["screens_navigate"]);
  });

  it("accepts an explicit { ok: true } acknowledgement", async () => {
    const { call, activity } = setup({ setActive: async (): Promise<ScreensAdapterResult> => ({ ok: true }) });

    const r = await call("screens_navigate", { screen: "other" });
    expect(r.isError).toBe(false);
    expect(activity).toHaveLength(1);
  });

  it("turns a rejected setActive into an error with the host's message and no activity", async () => {
    const { call, activity } = setup({
      setActive: async () => { throw new Error("Screen is locked by another editor"); },
    });

    const r = await call("screens_navigate", { screen: "other" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Screen is locked by another editor");
    expect(activity).toHaveLength(0);
  });

  it("turns an { ok: false } refusal into an error carrying the host's error and no activity", async () => {
    const { call, activity } = setup({
      setActive: async () => ({ ok: false, error: "Version conflict: reload and retry", code: "conflict" }),
    });

    const r = await call("screens_navigate", { screen: "other" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Version conflict: reload and retry");
    expect(activity).toHaveLength(0);
  });

  it("never leaks a stack trace from a host rejection", async () => {
    const err = new Error("Persist failed");
    err.stack = "Error: Persist failed\n    at saveScreen (/srv/app/secret/path.js:10:5)";
    const { call } = setup({ destroyScreen: async () => { throw err; } });

    const r = await call("screens_destroy", { id: "other" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Persist failed");
    expect(r.text).not.toContain("secret/path.js");
    expect(r.text).not.toMatch(/\n\s+at /);
  });

  it("does not render a non-Error rejection as [object Object]", async () => {
    const { call } = setup({ destroyScreen: () => Promise.reject({ status: 500 }) });

    const r = await call("screens_destroy", { id: "other" });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("[object Object]");
    expect(r.text.length).toBeGreaterThan(0);
  });

  it("reports a refused destroy, update_content and set_layout as errors with no activity", async () => {
    const refuse = async (): Promise<ScreensAdapterResult> => ({ ok: false, error: "Read-only workspace" });
    const { call, activity } = setup({ destroyScreen: refuse, updateScreenContent: refuse });

    for (const [tool, args] of [
      ["screens_destroy", { id: "other" }],
      ["screens_update_content", { id: "other", partial: { a: 1 } }],
      ["screens_set_layout", { id: "other", layout: "split-h" }],
    ] as const) {
      const r = await call(tool, args as JsonObject);
      expect(r.isError, tool).toBe(true);
      expect(r.text, tool).toContain("Read-only workspace");
    }
    expect(activity).toHaveLength(0);
  });

  it("waits for an async destroy before reporting success", async () => {
    const d = deferred<void>();
    const { call, activity } = setup({ destroyScreen: () => d.promise });

    let settled = false;
    const pending = call("screens_destroy", { id: "other" }).then((r) => { settled = true; return r; });
    await flush();
    expect(settled).toBe(false);
    expect(activity).toHaveLength(0);

    d.resolve();
    expect((await pending).isError).toBe(false);
    expect(activity.map((a) => a.action)).toEqual(["screens_destroy"]);
  });

  it("waits for an async update before reporting success", async () => {
    const d = deferred<void>();
    const { call } = setup({ updateScreenContent: () => d.promise });

    let settled = false;
    const pending = call("screens_update_content", { id: "other", partial: { a: 1 } }).then((r) => { settled = true; return r; });
    await flush();
    expect(settled).toBe(false);
    d.resolve();
    expect((await pending).isError).toBe(false);
  });

  describe("screens_create (create, then activate)", () => {
    it("does not activate when createScreen fails, and emits no activity", async () => {
      const setActive = vi.fn();
      const { call, activity } = setup({
        createScreen: async () => ({ ok: false, error: "Unknown kind: chart" }),
        setActive,
      });

      const r = await call("screens_create", { id: "fresh", kind: "chart" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Unknown kind: chart");
      expect(setActive).not.toHaveBeenCalled();
      expect(activity).toHaveLength(0);
    });

    it("does not activate when createScreen rejects", async () => {
      const setActive = vi.fn();
      const { call } = setup({
        createScreen: async () => { throw new Error("Duplicate id"); },
        setActive,
      });

      const r = await call("screens_create", { id: "fresh", kind: "page" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Duplicate id");
      expect(setActive).not.toHaveBeenCalled();
    });

    it("waits for createScreen to commit before activating", async () => {
      const d = deferred<void>();
      const setActive = vi.fn();
      const { call } = setup({ createScreen: () => d.promise, setActive });

      const pending = call("screens_create", { id: "fresh", kind: "page" });
      await flush();
      expect(setActive).not.toHaveBeenCalled();

      d.resolve();
      expect((await pending).isError).toBe(false);
      expect(setActive).toHaveBeenCalledWith("fresh");
    });

    it("reports created-but-not-activated as an error stating the true state, and still records the committed create", async () => {
      const { call, activity } = setup({
        createScreen: async () => ({ ok: true }),
        setActive: async () => ({ ok: false, error: "Navigation blocked by unsaved changes" }),
      });

      const r = await call("screens_create", { id: "fresh", kind: "page" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('Screen "fresh" was created but not activated');
      expect(r.text).toContain("Navigation blocked by unsaved changes");
      expect(r.text).toContain("screens_navigate");
      expect(r.structured).toMatchObject({ id: "fresh", kind: "page", created: true, activated: false });

      // The create DID commit, so presence must still see it — one event, and
      // it says the activation did not happen.
      expect(activity).toHaveLength(1);
      expect(activity[0]!.action).toBe("screens_create");
      expect(activity[0]!.meta).toMatchObject({ id: "fresh", created: true, activated: false });
    });
  });

  describe("sync void adapters behave exactly as before", () => {
    it("navigates, creates, updates and destroys synchronously with one activity each", async () => {
      const state = { active: "home" as string, created: [] as string[], updated: [] as string[], destroyed: [] as string[] };
      const { call, activity } = setup({
        setActive: (id) => { state.active = id; },
        createScreen: (spec) => { state.created.push(spec.id); },
        updateScreenContent: (id) => { state.updated.push(id); },
        destroyScreen: (id) => { state.destroyed.push(id); },
      });

      expect((await call("screens_create", { id: "fresh", kind: "page" })).text).toBe('Created page screen "fresh"');
      expect((await call("screens_navigate", { screen: "other" })).text).toBe("Navigated to other");
      expect((await call("screens_update_content", { id: "other", partial: { a: 1 } })).text).toBe("Updated content of other");
      expect((await call("screens_destroy", { id: "other" })).text).toBe("Destroyed screen other");

      expect(state).toEqual({ active: "other", created: ["fresh"], updated: ["other"], destroyed: ["other"] });
      expect(activity.map((a) => a.action)).toEqual([
        "screens_create", "screens_navigate", "screens_update_content", "screens_destroy",
      ]);
    });

    it("still surfaces a synchronous throw as an error with no activity", async () => {
      const { call, activity } = setup({ setActive: () => { throw new Error("sync boom"); } });

      const r = await call("screens_navigate", { screen: "other" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("sync boom");
      expect(activity).toHaveLength(0);
    });
  });
});
