// Node-only build helper: generate + pack a `.mcpb` bundle for a remote MCP
// server. Imported from `@particle-academy/agent-integrations/connectors/build`
// at BUILD time (a CI step / a `scripts/build-mcpb.mjs`), never from browser
// code — it touches fs + shells out to the official mcpb CLI.

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildMcpbManifest,
  buildMcpbProxyStub,
  DEFAULT_MCPB_ENTRY_POINT,
  type McpbManifestInput,
} from "./mcpb";

export type { McpbManifestInput, McpbTool } from "./mcpb";

export interface WriteMcpbBundleOptions {
  /** Where to write the packed `.mcpb` (absolute or cwd-relative). */
  outFile: string;
  /** The manifest inputs (server name, version, mcpUrl, tools, …). */
  manifest: McpbManifestInput;
  /**
   * The mcpb CLI to shell out to. Default: `["npx", "-y", "@anthropic-ai/mcpb"]`.
   * Pass a locally-installed binary path (string) or argv (array) to avoid the
   * npx network fetch.
   */
  mcpbBin?: string | string[];
  /** Run `mcpb validate` before packing. Default true. */
  validate?: boolean;
  /** Keep the temp work dir instead of removing it (debugging). Default false. */
  keepWorkDir?: boolean;
  /** Working directory the CLI runs in. Default `process.cwd()`. */
  cwd?: string;
}

export interface WriteMcpbBundleResult {
  /** Absolute path to the written `.mcpb`. */
  outFile: string;
  /** Size of the written bundle in bytes. */
  bytes: number;
  /** The manifest object that was packed. */
  manifest: Record<string, unknown>;
  /** The work dir used (returned even after cleanup, for logging). */
  workDir: string;
}

/**
 * Generate a `manifest.json` + `server/proxy.js` for a remote MCP server, then
 * validate and pack them into a `.mcpb` using the official `@anthropic-ai/mcpb`
 * CLI. Returns the output path + size.
 *
 * ```ts
 * import { writeMcpbBundle } from "@particle-academy/agent-integrations/connectors/build";
 *
 * await writeMcpbBundle({
 *   outFile: "public/decksmith.mcpb",
 *   manifest: {
 *     name: "decksmith",
 *     display_name: "Decksmith",
 *     version: "0.2.0",
 *     description: "Agent-driven slide deck builder.",
 *     author: { name: "Particle Academy", url: "https://decksmith.dev" },
 *     mcpUrl: "https://decksmith.dev/mcp",
 *     tools: [{ name: "start_session", description: "…" }],
 *   },
 * });
 * ```
 */
export async function writeMcpbBundle(
  opts: WriteMcpbBundleOptions,
): Promise<WriteMcpbBundleResult> {
  const cwd = opts.cwd ?? process.cwd();
  const outFile = path.resolve(cwd, opts.outFile);
  const validate = opts.validate ?? true;
  const entryPoint = opts.manifest.entryPoint ?? DEFAULT_MCPB_ENTRY_POINT;

  const manifest = buildMcpbManifest(opts.manifest);
  const proxy = buildMcpbProxyStub(opts.manifest.mcpUrl);

  const workDir = await mkdtemp(path.join(tmpdir(), "fai-mcpb-"));
  try {
    // Lay out the bundle source: manifest.json + the entry-point stub.
    await writeFile(
      path.join(workDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
    const entryAbs = path.join(workDir, entryPoint);
    await mkdir(path.dirname(entryAbs), { recursive: true });
    await writeFile(entryAbs, proxy, "utf8");

    // Ensure the output dir exists.
    await mkdir(path.dirname(outFile), { recursive: true });

    const bin = normalizeBin(opts.mcpbBin);
    if (validate) {
      await run(bin, ["validate", "manifest.json"], workDir);
    }
    await run(bin, ["pack", workDir, outFile], cwd);

    const bytes = (await stat(outFile)).size;
    return { outFile, bytes, manifest, workDir };
  } finally {
    if (!opts.keepWorkDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function normalizeBin(bin: string | string[] | undefined): string[] {
  if (!bin) return ["npx", "-y", "@anthropic-ai/mcpb"];
  return Array.isArray(bin) ? bin : [bin];
}

/** Spawn `[cmd, ...args]`, inheriting stdio, rejecting on a non-zero exit. */
function run(bin: string[], args: string[], cwd: string): Promise<void> {
  const [cmd, ...binArgs] = bin;
  const argv = [...binArgs, ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32", // npx resolves via .cmd on Windows
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`${cmd} ${argv.join(" ")} exited with code ${code ?? "null"}`),
        );
    });
  });
}
