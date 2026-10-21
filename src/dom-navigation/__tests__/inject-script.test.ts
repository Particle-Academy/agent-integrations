// @vitest-environment node
//
// Node environment on purpose: esbuild refuses to run under jsdom (its
// TextEncoder output is a jsdom Uint8Array, which fails esbuild's own
// invariant). The DOM half of this file builds its own JSDOM window instead.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "tsup";
import { JSDOM } from "jsdom";
import { domNavigationInjectPlugin } from "../../../scripts/dom-navigation-inject-plugin";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * The shipped mechanism, not a stand-in: build `./dom-navigation/script` the way
 * tsup.config.ts does (same entry, same plugin), import the built module, and
 * evaluate the string it exports where a host would — a context with no module
 * system at all.
 */
let outDir = "";
let SCRIPT = "";

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), "dom-nav-script-"));
  await build({
    config: false,
    entry: { "dom-navigation-script": join(ROOT, "src/dom-navigation/script.ts") },
    format: ["esm"],
    outDir,
    dts: false,
    sourcemap: false,
    silent: true,
    esbuildPlugins: [domNavigationInjectPlugin(join(ROOT, "src/dom-navigation/inject.ts"))],
  });
  const mod = await import(pathToFileURL(join(outDir, "dom-navigation-script.js")).href);
  SCRIPT = mod.DOM_NAVIGATION_SCRIPT;
}, 60_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe("DOM_NAVIGATION_SCRIPT (the injectable IIFE)", () => {
  it("is a self-contained script: no import, export, require or module references", () => {
    expect(typeof SCRIPT).toBe("string");
    expect(SCRIPT.length).toBeGreaterThan(500);
    expect(SCRIPT).not.toMatch(/^\s*(import|export)\s/m);
    expect(SCRIPT).not.toMatch(/\brequire\(/);
    expect(SCRIPT).not.toMatch(/\bmodule\.exports\b/);
  });

  it("evaluates in a bare context with no DOM and no module system, and installs its global", () => {
    const ctx = vm.createContext({});
    vm.runInContext(SCRIPT, ctx);
    const g = vm.runInContext("globalThis.__fancyDomNavigation", ctx);
    expect(typeof g.call).toBe("function");
    expect(g.protocol).toBe(1);
  });

  it("is idempotent: re-injecting keeps the existing instance (and its handle registry)", () => {
    const ctx = vm.createContext({});
    vm.runInContext(SCRIPT, ctx);
    const first = vm.runInContext("globalThis.__fancyDomNavigation", ctx);
    vm.runInContext(SCRIPT, ctx);
    expect(vm.runInContext("globalThis.__fancyDomNavigation", ctx)).toBe(first);
  });

  it("drives a real document once injected: describe, set a field, click", () => {
    const dom = new JSDOM(
      `<!doctype html><title>Injected</title><main><h1>Hi</h1>
        <input name="email"><input type="password" name="pw" value="hunter2">
        <button id="go">Go</button></main>`,
      { runScripts: "outside-only", url: "https://example.test/path?q=1" },
    );
    const w = dom.window as unknown as Window & typeof globalThis & { eval: (s: string) => unknown };
    w.HTMLElement.prototype.getClientRects = () => ({ length: 1 }) as unknown as DOMRectList;
    let clicked = 0;
    w.document.getElementById("go")!.addEventListener("click", () => clicked++);

    w.eval(SCRIPT);
    const snap = w.eval(`__fancyDomNavigation.call("describe", [])`) as {
      url: string;
      title: string;
      actions: Array<{ handle: string; value?: unknown }>;
    };
    expect(snap.url).toBe("/path?q=1");
    expect(snap.title).toBe("Injected");
    expect(snap.actions.map((a) => a.handle)).toEqual(["email", "pw", "go"]);
    expect(JSON.stringify(snap)).not.toContain("hunter2");

    expect(w.eval(`__fancyDomNavigation.call("setField", ["email", "ada@example.com"])`)).toEqual({ ok: true });
    expect((w.document.querySelector("[name=email]") as HTMLInputElement).value).toBe("ada@example.com");
    expect(w.eval(`__fancyDomNavigation.call("click", ["go"])`)).toEqual({ ok: true });
    expect(clicked).toBe(1);
  });
});
