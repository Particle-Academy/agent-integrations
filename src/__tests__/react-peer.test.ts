// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * React is an OPTIONAL peer, because half of this package never touches it.
 *
 * `/mcp`, `/mcp/stdio`, `/relay-server`, the bridges and the rest are imported
 * by headless Node hosts — `@particle-academy/fancy-flow-mcp-js` is a stdio MCP
 * server — and a REQUIRED peer makes npm install React into every one of them.
 * Nothing breaks, which is why it went unnoticed: the host just carries
 * `react` and `react-dom` it will never load.
 *
 * Optional is only honest while two things stay true, and this file holds both:
 *
 *   1. React is still DECLARED, with its range, so a UI consumer on an
 *      incompatible React is still told. `optional` changes whether npm installs
 *      a missing React, not whether it checks a present one.
 *   2. The entries that import React are exactly the ones listed below. A new
 *      React import in a headless entry fails here, instead of failing with
 *      "Cannot find package 'react'" in a host that installed this package
 *      precisely because it does not need React.
 *
 * The walk reads source, type-only imports included, so it is stricter than the
 * runtime graph: a false alarm is loud, a miss would be silent.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(SRC, "..");

/** Build entries (tsup names) that import React. Everything else must not. */
const REACT_ENTRIES = [
  "index",
  "bridges-tui",
  "sheets-adapter",
  "connectors",
  "components-shared-whiteboard",
  "presence",
  "heuristics",
  "undo",
].sort();

type Pkg = {
  exports: Record<string, string | { import: { default: string } }>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Pkg;
const tsup = readFileSync(join(ROOT, "tsup.config.ts"), "utf8");

/** `name: "src/…"` pairs from tsup's `entry` block. */
function tsupEntries(): Array<[string, string]> {
  const block = tsup.slice(tsup.indexOf("entry:"), tsup.indexOf("format:"));
  return [...block.matchAll(/["']?([\w-]+)["']?\s*:\s*"(src\/[^"]+)"/g)]
    .map((m) => [m[1]!, m[2]!] as [string, string])
    .filter(([, file]) => !file.endsWith(".css"));
}

/** Every bare specifier reachable from `entry` through relative imports. */
function bareImports(entry: string): string[] {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(file, "utf8");
    const specifiers = [
      ...source.matchAll(
        /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s+["']([^"']+)["']/g,
      ),
    ].map((m) => m[1] ?? m[2] ?? m[3]!);

    for (const spec of specifiers) {
      if (!spec.startsWith(".")) {
        bare.add(spec);
        continue;
      }
      if (spec.endsWith(".css")) continue;
      const base = resolve(dirname(file), spec);
      const hit = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find(existsSync);
      if (!hit) throw new Error(`${file} imports ${spec}, which resolves to nothing — the walk would silently stop here`);
      queue.push(hit);
    }
  }

  return [...bare];
}

const importsReact = (specifiers: string[]) => specifiers.some((s) => /^react(-dom)?(\/|$)/.test(s));

describe("react and react-dom are optional peers", () => {
  it("are declared optional", () => {
    expect(pkg.peerDependenciesMeta?.react?.optional).toBe(true);
    expect(pkg.peerDependenciesMeta?.["react-dom"]?.optional).toBe(true);
  });

  it("are still declared, with a range, so a UI consumer on the wrong React is still told", () => {
    expect(pkg.peerDependencies.react).toMatch(/19/);
    expect(pkg.peerDependencies["react-dom"]).toMatch(/19/);
  });
});

describe("which entries import React", () => {
  it("the walk reads real files, so an empty result is not vacuous", () => {
    expect(importsReact(bareImports(join(SRC, "index.ts")))).toBe(true);
    expect(tsupEntries().length).toBeGreaterThan(20);
  });

  it("is exactly the declared list — no headless entry has started importing React", () => {
    const actual = tsupEntries()
      .filter(([, file]) => importsReact(bareImports(join(ROOT, file))))
      .map(([name]) => name)
      .sort();

    expect(actual).toEqual(REACT_ENTRIES);
  });

  it("covers every package export — nothing a consumer can import escapes the check", () => {
    const built = new Set(tsupEntries().map(([name]) => `./dist/${name}.js`));
    const exported = Object.values(pkg.exports)
      .filter((spec): spec is { import: { default: string } } => typeof spec !== "string")
      .map((spec) => spec.import.default);

    expect(exported.filter((file) => !built.has(file))).toEqual([]);
  });
});
