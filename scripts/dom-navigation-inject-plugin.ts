/**
 * esbuild plugin (used by tsup.config.ts and by the inject-script test) that
 * resolves `virtual:dom-navigation-inject` to the bundled IIFE source of
 * src/dom-navigation/inject.ts, as a string.
 *
 * It uses the esbuild instance tsup already runs (`build.esbuild`), so this
 * adds no dependency. The IIFE is built for the browser with no module format,
 * which is what lets a host evaluate it in an isolated world.
 */
type OnResolveArgs = { path: string };
type PluginBuild = {
  onResolve(o: { filter: RegExp }, cb: (args: OnResolveArgs) => unknown): void;
  onLoad(o: { filter: RegExp; namespace: string }, cb: () => unknown): void;
  esbuild: {
    build(o: Record<string, unknown>): Promise<{ outputFiles?: Array<{ text: string }> }>;
  };
};

const NAMESPACE = "dom-navigation-inject";

export function domNavigationInjectPlugin(entry: string) {
  return {
    name: NAMESPACE,
    setup(build: PluginBuild) {
      build.onResolve({ filter: /^virtual:dom-navigation-inject$/ }, (args) => ({
        path: args.path,
        namespace: NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, async () => {
        const result = await build.esbuild.build({
          entryPoints: [entry],
          bundle: true,
          format: "iife",
          platform: "browser",
          target: "es2020",
          write: false,
          minify: false,
          legalComments: "none",
          sourcemap: false,
        });
        const text = result.outputFiles?.[0]?.text;
        if (!text) throw new Error("dom-navigation inject build produced no output");
        return { contents: text, loader: "text", watchFiles: [entry] };
      });
    },
  };
}
