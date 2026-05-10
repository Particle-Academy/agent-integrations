import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    mcp: "src/mcp/index.ts",
    "bridges-whiteboard": "src/bridges/whiteboard.ts",
    "bridges-flow": "src/bridges/flow.ts",
    sharing: "src/sharing/index.ts",
    styles: "src/styles.css",
  },
  format: ["esm", "cjs"],
  dts: { entry: ["src/index.ts", "src/mcp/index.ts", "src/bridges/whiteboard.ts", "src/bridges/flow.ts", "src/sharing/index.ts"] },
  sourcemap: true,
  clean: true,
  external: ["react", "react-dom", "@particle-academy/fancy-whiteboard"],
  treeshake: true,
});
