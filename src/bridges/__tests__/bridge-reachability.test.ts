import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Every bridge must be reachable by a consumer — enforced, not remembered.
 *
 * Shipping a bridge takes four separate edits in four files, and the repo's
 * agent guidance spells them out:
 *
 *   > Skipping any of these four lands the bridge in source but invisible to
 *   > consumers — exactly how `registerSlidesBridge` sat un-shipped until
 *   > v0.6.3.
 *
 * A documented invariant, a known historical failure, and nothing checking it.
 * The bridge's own tests pass either way: they import from `../<name>` by
 * relative path, which resolves regardless of what the PACKAGE exposes. So the
 * suite is green, the source is correct, and the feature does not exist for
 * anyone outside this repo.
 *
 * ## The rule is not "everything in the barrel"
 *
 * The first version of this file asserted that, and it was wrong in a dangerous
 * direction — `whiteboard`, `artboard` and `flow` are kept OUT of the root
 * barrel deliberately, because they import an optional peer eagerly. Putting
 * them back would make `fancy-whiteboard` and `fancy-flow` mandatory for every
 * consumer of the package root, which is the same class of breakage as
 * fancy-flow shipping `@xyflow/react` and making `fancy-screens` impossible to
 * co-install.
 *
 * So the real contract, which is what this file now asserts:
 *
 *   1. Every bridge is reachable by at least one documented route — the root
 *      barrel, or a built subpath.
 *   2. A bridge that imports an OPTIONAL PEER must be reachable by subpath, and
 *      must NOT be in the root barrel. The subpath is its only safe door.
 *   3. A subpath export must actually be built, or the export map points at a
 *      file that does not exist.
 */

const bridgeDir = join(ROOT, "src", "bridges");

const index = readFileSync(join(ROOT, "src", "index.ts"), "utf8");
const tsup = readFileSync(join(ROOT, "tsup.config.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  exports?: Record<string, unknown>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const OPTIONAL_PEERS = Object.entries(pkg.peerDependenciesMeta ?? {})
  .filter(([, meta]) => meta?.optional)
  .map(([name]) => name);

interface BridgeFacts {
  name: string;
  /** Optional peers this module imports directly. */
  peers: string[];
  inBarrel: boolean;
  inTsup: boolean;
  inExports: boolean;
}

/** A module under `src/bridges/` is a BRIDGE only if it registers one. */
function isBridgeModule(source: string): boolean {
  return /export\s+function\s+register\w*Bridge\b/.test(source);
}

/**
 * Which optional peers does this module import **eagerly**?
 *
 * Only an eager value import forces the peer on a consumer. The other two forms
 * are free and are used deliberately throughout:
 *
 *   import type { Deck } from "…/fancy-slides"      erased at build time
 *   await import("…/fancy-slides")                  loaded only if a tool runs
 *   import { reduceWorkbook } from "…/fancy-sheets" EAGER — this is the one
 *
 * A naive "does the file mention the package" check flags `sheets` and `slides`,
 * which are correctly in the root barrel precisely because they went to the
 * trouble of using the first two forms. An earlier version of this file did
 * exactly that and would have pushed someone to "fix" working code.
 */
function eagerPeerImports(rawSource: string, peers: string[]): string[] {
  const eager = new Set<string>();

  // Comments first. `slides.ts` explains in prose that consumers "import it
  // from fancy-slides", and the lazy `[\s\S]*?` below happily spanned from the
  // word "import" in that sentence to a real `from "…"` two lines later — so
  // the file was reported as eagerly importing a package it deliberately does
  // not. Scanning code that still contains English is asking for that.
  const source = rawSource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  // Side-effect import: `import "pkg"` — always eager.
  for (const m of source.matchAll(/import\s+["']([^"']+)["']/g)) {
    if (peers.includes(m[1]!)) eager.add(m[1]!);
  }

  for (const m of source.matchAll(/import\s+(type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']/g)) {
    const [, typeKeyword, clause, specifier] = m;
    if (!peers.includes(specifier!)) continue;
    if (typeKeyword) continue; // `import type { … }` — erased

    // `import { type A, type B } from "pkg"` is also fully erased. Treat the
    // clause as type-only when every named binding carries its own `type`.
    const named = clause!.match(/\{([\s\S]*)\}/)?.[1];
    if (named) {
      const bindings = named.split(",").map((s) => s.trim()).filter(Boolean);
      if (bindings.length > 0 && bindings.every((b) => b.startsWith("type "))) continue;
    }

    eager.add(specifier!);
  }

  return [...eager];
}

/**
 * Bridges that do not yet have their own test file.
 *
 * This list may only ever SHRINK. It is not permission — it is a record of a
 * gap found on 2026-08-10, kept explicit so a NEW bridge cannot land untested
 * while the old ones are still outstanding. Deleting an entry is the fix;
 * adding one needs a very good reason.
 */
const UNTESTED_BRIDGES = [
  "artboard",
  "charts",
  "cms",
  "git",
  "map",
  "scene",
  "screens",
  "sheets",
  "slides",
  "whiteboard",
];

const bridges: BridgeFacts[] = readdirSync(bridgeDir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
  .map((f) => ({ name: f.replace(/\.ts$/, ""), source: readFileSync(join(bridgeDir, f), "utf8") }))
  .filter((m) => isBridgeModule(m.source))
  .map((m) => ({
    name: m.name,
    peers: eagerPeerImports(m.source, OPTIONAL_PEERS),
    // Matched on the import specifier, not a bare substring: a comment naming
    // the subpath must not read as an export.
    inBarrel: new RegExp(`from\\s+["']\\./bridges/${m.name}["']`).test(index),
    inTsup: tsup.includes(`bridges-${m.name}`),
    inExports: Object.keys(pkg.exports ?? {}).includes(`./bridges/${m.name}`),
  }));

const withPeers = bridges.filter((b) => b.peers.length > 0);

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every module anywhere under `src/` that eagerly imports an optional peer. */
function eagerPeerModules(): Array<{ file: string; peer: string }> {
  const found: Array<{ file: string; peer: string }> = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith(".test.ts")) continue;

      const peers = eagerPeerImports(readFileSync(full, "utf8"), OPTIONAL_PEERS);
      for (const peer of peers) {
        found.push({ file: full.slice(ROOT.length + 1).split("\\").join("/"), peer });
      }
    }
  };

  walk(join(ROOT, "src"));
  return found;
}

describe("bridge reachability", () => {
  it("found bridges to check, and did not mistake a shared module for one", () => {
    // Without this, every `it.each` below silently becomes zero assertions if
    // the detection regex stops matching — a green run over nothing, which is
    // the exact failure this file exists to prevent.
    expect(bridges.length).toBeGreaterThan(15);
    expect(bridges.map((b) => b.name)).not.toContain("types");
  });

  it("no bridge eagerly imports an optional peer", () => {
    // Every bridge takes the peer as `import type` (erased) or `await import()`
    // (loaded only if a tool runs, and only by a consumer who installed it).
    // That is why sheets, slides, catalog and friends can sit in the root
    // barrel at all, and it is worth asserting rather than assuming — the cost
    // of getting it wrong lands on consumers who never use the surface.
    expect(withPeers.map((b) => `${b.name} -> ${b.peers.join(", ")}`)).toEqual([]);
  });

  it.each(bridges)("$name is reachable by at least one route", ({ name, inBarrel, inExports }) => {
    expect(
      inBarrel || inExports,
      `${name} is in neither the root barrel nor package exports — it exists only inside this repo`,
    ).toBe(true);
  });

  it("the eager-peer detector actually finds something", () => {
    // Without this the rule below passes vacuously: a detector that matches
    // nothing reports no offenders, which is indistinguishable from compliance.
    // `SharedWhiteboard` is the known subject — if it stops being found, the
    // detector broke, not the codebase.
    const eager = eagerPeerModules();

    expect(eager.length).toBeGreaterThan(0);
    expect(eager.map((e) => e.file)).toContain(
      "src/components/SharedWhiteboard/SharedWhiteboard.tsx",
    );
  });

  it("a module that DOES eagerly import an optional peer stays out of the root barrel", () => {
    // The rule has one real subject today — `SharedWhiteboard`, which imports
    // fancy-whiteboard eagerly and is deliberately reachable only by subpath:
    //
    //   > SharedWhiteboard is NOT re-exported from the root barrel — it imports
    //   > fancy-whiteboard eagerly.
    //
    // That is a comment. Comments do not fail builds. Re-exporting it would
    // make fancy-whiteboard mandatory for everyone importing the package root,
    // which is the same class of breakage as fancy-flow shipping @xyflow/react
    // and making fancy-screens impossible to co-install.
    const offenders = eagerPeerModules().filter(({ file }) => {
      const module = file.replace(/^src\//, "./").replace(/\.tsx?$/, "");
      const dir = module.replace(/\/[^/]+$/, "");
      return (
        new RegExp(`from\\s+["']${escape(module)}["']`).test(index) ||
        new RegExp(`from\\s+["']${escape(dir)}["']`).test(index)
      );
    });

    expect(
      offenders.map((o) => `${o.file} -> ${o.peer}`),
      "re-exported from the root barrel while eagerly importing an optional peer",
    ).toEqual([]);
  });

  it.each(bridges.filter((b) => b.inExports))(
    "$name is built, so its export map does not point at a missing file",
    ({ name, inTsup }) => {
      expect(inTsup, `"./bridges/${name}" is exported but has no tsup entry`).toBe(true);
    },
  );

  it.each(bridges.filter((b) => !UNTESTED_BRIDGES.includes(b.name)))(
    "$name has its own test file",
    ({ name }) => {
      // The other half of the same problem: reachable, and unverified.
      expect(readdirSync(join(bridgeDir, "__tests__"))).toContain(`${name}.test.ts`);
    },
  );

  it("the untested-bridge list is accurate and only shrinks", () => {
    // A stale allowlist is worse than none: it would keep excusing a bridge
    // that has since been tested, and quietly re-open the hole if that test
    // were later deleted.
    const tests = readdirSync(join(bridgeDir, "__tests__"));
    const wrongly = UNTESTED_BRIDGES.filter((n) => tests.includes(`${n}.test.ts`));

    expect(wrongly, `these now have tests — delete them from UNTESTED_BRIDGES: ${wrongly.join(", ")}`).toEqual([]);

    const known = new Set(bridges.map((b) => b.name));
    const ghosts = UNTESTED_BRIDGES.filter((n) => !known.has(n));
    expect(ghosts, `these are not bridges any more: ${ghosts.join(", ")}`).toEqual([]);
  });
});
