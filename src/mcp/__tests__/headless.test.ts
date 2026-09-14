// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The MCP entry points stay headless.
 *
 * `./mcp` and `./mcp/stdio` are what a headless server imports — a Node process
 * with no DOM and, often, no React installed. The package root and most other
 * subpaths import React by design, so one careless re-export from a component
 * module would make `import "@particle-academy/agent-integrations/mcp"` fail
 * with "Cannot find package 'react'" in exactly the hosts that chose the subpath
 * to avoid it. Nothing else would notice: every other test here runs in a tree
 * that has React.
 *
 * This walks the real relative-import graph from each entry, so it sees a
 * dependency however deep it is introduced.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = resolve(SRC, "..");

/** Every module reachable from `entry` through relative imports, with its bare imports. */
function graph(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    const source = readFileSync(file, "utf8");
    const specifiers = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)]
      .map((m) => m[1] ?? m[2]!)
      // Type-only imports are walked too. That is stricter than the runtime
      // graph, and a false alarm here is loud where a miss would be silent.
      .filter((s, i, all) => all.indexOf(s) === i);

    const bare: string[] = [];
    for (const spec of specifiers) {
      if (!spec.startsWith(".")) {
        bare.push(spec);
        continue;
      }
      const base = resolve(dirname(file), spec);
      const hit = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(existsSync);
      if (!hit) throw new Error(`${file} imports ${spec}, which resolves to nothing — the walk would silently stop here`);
      queue.push(hit);
    }
    seen.set(file, bare);
  }

  return seen;
}

function bareImports(entry: string): string[] {
  return [...new Set([...graph(entry).values()].flat())].sort();
}

describe("headless MCP entry points", () => {
  it("the walk actually reaches the server, so an empty result is not vacuous", () => {
    const files = [...graph(join(SRC, "mcp", "index.ts")).keys()].map((f) => f.slice(SRC.length + 1).replace(/\\/g, "/"));

    expect(files).toEqual(expect.arrayContaining(["mcp/index.ts", "mcp/server.ts", "mcp/tool-host.ts", "mcp/types.ts"]));
  });

  it("./mcp imports no package at all — safe for a browser bundle AND a bare Node process", () => {
    expect(bareImports(join(SRC, "mcp", "index.ts"))).toEqual([]);
  });

  it("./mcp/stdio imports nothing but Node built-ins", () => {
    const bare = bareImports(join(SRC, "mcp", "stdio.ts"));

    expect(bare.length, "stdio imports nothing — the walk is not reading it").toBeGreaterThan(0);
    expect(bare.filter((s) => !s.startsWith("node:"))).toEqual([]);
  });

  it("./mcp does not import the Node-only stdio transport", () => {
    // Browser bundles import ./mcp. Pulling node:* in through it would break them.
    const files = [...graph(join(SRC, "mcp", "index.ts")).keys()].map((f) => f.slice(SRC.length + 1).replace(/\\/g, "/"));

    expect(files).not.toContain("mcp/stdio.ts");
  });
});

describe("./mcp/stdio is wired, not merely written", () => {
  // A module that exists in src/ but has no export and no build entry is
  // unreachable for every consumer, and every test here would still pass.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    exports: Record<string, { import: { types: string; default: string }; require: { types: string; default: string } }>;
  };
  const tsup = readFileSync(join(ROOT, "tsup.config.ts"), "utf8");

  it("is a package export for both module systems", () => {
    const entry = pkg.exports["./mcp/stdio"];

    expect(entry, "package.json has no ./mcp/stdio export").toBeDefined();
    expect(entry!.import.default).toBe("./dist/mcp-stdio.js");
    expect(entry!.require.default).toBe("./dist/mcp-stdio.cjs");
    expect(entry!.import.types).toBe("./dist/mcp/stdio.d.ts");
    expect(entry!.require.types).toBe("./dist/mcp/stdio.d.cts");
  });

  it("is a build entry, with declarations", () => {
    expect(tsup).toContain(`"mcp-stdio": "src/mcp/stdio.ts"`);
    expect(tsup.match(/"src\/mcp\/stdio\.ts"/g)?.length, "declared as a JS entry but not a dts entry, or vice versa").toBe(2);
  });
});
