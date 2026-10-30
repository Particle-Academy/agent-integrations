import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { joinInstanceRouter } from "../multi-instance";

/**
 * The shared per-host router behind "one bridge serving N instances". Forms use
 * it first; charts, grids and the other adapter-id bridges can adopt it later.
 */

const FAMILY = { family: "widget", argument: "widget", listTool: "widget_list" };

describe("joinInstanceRouter", () => {
  it("installs once for the first instance and uninstalls after the last leaves", () => {
    const host = new ToolRegistry();
    const uninstall = vi.fn();
    const install = vi.fn(() => uninstall);

    const a = joinInstanceRouter(host, { ...FAMILY, install }, "a", { n: 1 });
    const b = joinInstanceRouter(host, { ...FAMILY, install }, "b", { n: 2 });
    expect(install).toHaveBeenCalledTimes(1);
    expect(a.router).toBe(b.router);
    expect(a.router.ids()).toEqual(["a", "b"]);

    a.leave();
    expect(uninstall).not.toHaveBeenCalled();
    b.leave();
    expect(uninstall).toHaveBeenCalledTimes(1);

    const c = joinInstanceRouter(host, { ...FAMILY, install }, "c", { n: 3 });
    expect(install).toHaveBeenCalledTimes(2);
    expect(c.router).not.toBe(a.router);
  });

  it("resolves: optional with one instance, required with several, unknown ids refused with the list", () => {
    const host = new ToolRegistry();
    const { router } = joinInstanceRouter(host, { ...FAMILY, install: () => () => {} }, "a", "A");
    expect(router.resolve(undefined)).toEqual({ ok: true, id: "a", instance: "A" });
    expect(router.resolve("a")).toEqual({ ok: true, id: "a", instance: "A" });

    const unknown = router.resolve("z");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toMatch(/"z".*"a"/s);

    joinInstanceRouter(host, { ...FAMILY, install: () => () => {} }, "b", "B");
    const missing = router.resolve(undefined);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toContain('"a"');
      expect(missing.error).toContain('"b"');
      expect(missing.error).toContain("widget_list");
      expect(missing.error).toContain('"widget"');
    }
    expect(router.resolve("b")).toEqual({ ok: true, id: "b", instance: "B" });

    const notString = router.resolve(42);
    expect(notString.ok).toBe(false);
  });

  it("a rejoin under the same id replaces the entry; the stale leave is a no-op", () => {
    const host = new ToolRegistry();
    const uninstall = vi.fn();
    const opts = { ...FAMILY, install: () => uninstall };
    const first = joinInstanceRouter(host, opts, "a", "first");
    joinInstanceRouter(host, opts, "a", "second");
    expect(first.router.ids()).toEqual(["a"]);
    first.leave();
    expect(first.router.resolve(undefined)).toEqual({ ok: true, id: "a", instance: "second" });
    expect(uninstall).not.toHaveBeenCalled();
  });

  it("refuses a missing id", () => {
    const host = new ToolRegistry();
    const opts = { ...FAMILY, install: () => () => {} };
    expect(() => joinInstanceRouter(host, opts, "", "x")).toThrow(/non-empty/);
    expect(() => joinInstanceRouter(host, opts, "   ", "x")).toThrow(/non-empty/);
  });

  it("a failed install leaves no router behind", () => {
    const host = new ToolRegistry();
    const bad = () => { throw new Error("name taken"); };
    expect(() => joinInstanceRouter(host, { ...FAMILY, install: bad }, "a", 1)).toThrow("name taken");
    const install = vi.fn(() => () => {});
    const { router } = joinInstanceRouter(host, { ...FAMILY, install }, "b", 2);
    expect(install).toHaveBeenCalledTimes(1);
    expect(router.ids()).toEqual(["b"]);
  });

  it("different families on one host get different routers", () => {
    const host = new ToolRegistry();
    const a = joinInstanceRouter(host, { ...FAMILY, install: () => () => {} }, "a", 1);
    const b = joinInstanceRouter(
      host,
      { family: "chart", argument: "chart", listTool: "chart_list", install: () => () => {} },
      "a",
      2,
    );
    expect(a.router).not.toBe(b.router);
    expect(a.router.resolve(undefined)).toMatchObject({ ok: true, instance: 1 });
    expect(b.router.resolve(undefined)).toMatchObject({ ok: true, instance: 2 });
  });
});
