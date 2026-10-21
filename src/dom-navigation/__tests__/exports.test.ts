import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { exports: Record<string, unknown> };
const tsup = readFileSync(join(ROOT, "tsup.config.ts"), "utf8");

/**
 * A host process (Genie's Electron main) needs all three of these WITHOUT the
 * root barrel, which is the React UI. `registerNavigationBridge` was reachable
 * only through that barrel.
 */
describe("headless subpaths for driving a page from a host process", () => {
  for (const [subpath, entry, src] of [
    ["./dom-navigation", "dom-navigation", "src/dom-navigation/index.ts"],
    ["./dom-navigation/script", "dom-navigation-script", "src/dom-navigation/script.ts"],
    ["./bridges/navigation", "bridges-navigation", "src/bridges/navigation.ts"],
  ] as const) {
    it(`${subpath} is exported and built`, () => {
      expect(pkg.exports[subpath]).toBeTruthy();
      expect(tsup).toContain(`"${entry}": "${src}"`);
      expect(JSON.stringify(pkg.exports[subpath])).toContain(`./dist/${entry}.js`);
    });
  }

  it("none of them import React", () => {
    for (const file of ["src/dom-navigation/agent.ts", "src/dom-navigation/remote.ts", "src/bridges/navigation.ts"]) {
      expect(readFileSync(join(ROOT, file), "utf8")).not.toMatch(/from\s+["']react/);
    }
  });
});
