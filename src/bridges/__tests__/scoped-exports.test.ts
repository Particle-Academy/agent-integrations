// @vitest-environment node
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  name: string;
  exports: Record<string, unknown>;
};

// Discover registration modules rather than keeping a list that can omit the
// next bridge. Shared types/helpers without a registration function are private.
const bridges = readdirSync(join(ROOT, "src/bridges"))
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
  .flatMap((file) => {
    const source = ts.createSourceFile(file, readFileSync(join(ROOT, "src/bridges", file), "utf8"), ts.ScriptTarget.Latest);
    const registrations = source.statements.filter(ts.isFunctionDeclaration)
      .filter((node) => node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
      .map((node) => node.name?.text)
      .filter((name): name is string => name !== undefined && /^register\w*Bridge$/.test(name));
    return registrations.length ? [{ name: file.slice(0, -3), registrations }] : [];
  })
  .sort((a, b) => a.name.localeCompare(b.name));

describe("built bridge package exports", () => {
  it("exports every discovered bridge through a scoped package entry", () => {
    expect(bridges.length).toBeGreaterThan(20);
    expect(bridges.some((bridge) => bridge.name === "screen-doc")).toBe(true);
    expect(Object.keys(pkg.exports).filter((key) => key.startsWith("./bridges/")).sort())
      .toEqual(bridges.map((bridge) => `./bridges/${bridge.name}`).sort());
  });

  it.each(["import", "require"] as const)("loads every built scoped bridge with %s", (mode) => {
    const script = `
      const { createRequire } = await import('node:module');
      const require = createRequire(process.cwd() + '/package.json');
      for (const bridge of ${JSON.stringify(bridges)}) {
        const specifier = ${JSON.stringify(pkg.name)} + '/bridges/' + bridge.name;
        const entry = ${mode === "import" ? "await import(specifier)" : "require(specifier)"};
        for (const registration of bridge.registrations) {
          if (typeof entry[registration] !== 'function') throw new Error(specifier + ' does not export ' + registration);
        }
      }
      const root = ${mode === "import" ? `await import(${JSON.stringify(pkg.name)})` : `require(${JSON.stringify(pkg.name)})`};
      const content = ${mode === "import" ? `await import(${JSON.stringify(`${pkg.name}/bridges/screen-doc`)})` : `require(${JSON.stringify(`${pkg.name}/bridges/screen-doc`)})`};
      const { MicroMcpServer } = ${mode === "import" ? `await import(${JSON.stringify(`${pkg.name}/mcp`)})` : `require(${JSON.stringify(`${pkg.name}/mcp`)})`};
      for (const entry of [root, content]) {
        const host = new MicroMcpServer({ info: { name: 'compatibility', version: '1' } });
        let tree = { nodes: { label: { id: 'label', type: '#text', parent: null, order: 'a0', props: { value: 'before' } } } };
        const bridge = entry.registerScreenDocBridge(host, { surface: 'screen_compat', adapter: { get: () => tree, set: next => { tree = next; } } });
        const result = await host.callTool('screen_compat_set_text', { id: 'label', text: 'after' });
        if (result.isError || tree.nodes.label.props.value !== 'after') throw new Error('The root/scoped screen-content contract changed');
        bridge.dispose();
        if (host.getTool('screen_compat_set_text') !== null) throw new Error('The screen-content bridge did not dispose');
      }
    `;
    // A real Node consumer resolves the package exports map and built dist.
    // Vitest's TS/source resolver must not make a missing export look usable.
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: ROOT, encoding: "utf8", timeout: 30_000,
    });
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
  });

  it("type-checks ESM and CJS consumers against the built declarations", () => {
    const imports = bridges.map((bridge, i) => `import type * as Bridge${i} from ${JSON.stringify(`${pkg.name}/bridges/${bridge.name}`)}; export type Export${i} = typeof Bridge${i};`).join("\n");
    const content = `${imports}
      import type { DocAdapter, ScreenDocBridgeOptions, ScreenDocNode, ScreenDocOp } from '${pkg.name}/bridges/screen-doc';
      import type { ScreenDocBridgeOptions as RootOptions } from '${pkg.name}';
      export type Adapter = DocAdapter<ScreenDocNode>;
      export type Operation = ScreenDocOp;
      export type Options = ScreenDocBridgeOptions;
      export type CompatibleRootOptions = RootOptions;
    `;
    const virtualFiles = [join(ROOT, "bridge-consumer.mts"), join(ROOT, "bridge-consumer.cts")]
      .map((file) => file.split("\\").join("/"));
    const options: ts.CompilerOptions = {
      noEmit: true, strict: true, skipLibCheck: true, types: [],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => virtualFiles.includes(file.split("\\").join("/"))
      ? ts.createSourceFile(file, content, languageVersion)
      : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
    const program = ts.createProgram(virtualFiles, options, host);
    const diagnostics = virtualFiles.flatMap((file) => {
      const source = program.getSourceFile(file);
      expect(source, `The ${file} consumer must actually be compiled`).toBeDefined();
      return [...program.getSyntacticDiagnostics(source!), ...program.getSemanticDiagnostics(source!)];
    });
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
  });
});
