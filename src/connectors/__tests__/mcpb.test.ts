import { describe, it, expect } from "vitest";
import {
  buildMcpbManifest,
  buildMcpbProxyStub,
  MCPB_MANIFEST_VERSION,
} from "../mcpb";

const input = {
  name: "decksmith",
  display_name: "Decksmith",
  version: "0.2.0",
  description: "Agent-driven slide deck builder.",
  author: { name: "Particle Academy", url: "https://decksmith.dev" },
  mcpUrl: "https://decksmith.dev/mcp",
  tools: [{ name: "start_session", description: "Lock onto a doc." }],
};

describe("buildMcpbManifest", () => {
  it("emits a node server proxying via npx -y mcp-remote <url>", () => {
    const m = buildMcpbManifest(input) as any;
    expect(m.manifest_version).toBe(MCPB_MANIFEST_VERSION);
    expect(m.server.type).toBe("node");
    expect(m.server.entry_point).toBe("server/proxy.js");
    expect(m.server.mcp_config).toEqual({
      command: "npx",
      args: ["-y", "mcp-remote", input.mcpUrl],
    });
    // No http server type exists in MCPB — must be the node proxy shape.
    expect(m.server.type).not.toBe("http");
  });

  it("carries display metadata + tools, defaults license to MIT", () => {
    const m = buildMcpbManifest(input) as any;
    expect(m.display_name).toBe("Decksmith");
    expect(m.tools).toEqual(input.tools);
    expect(m.license).toBe("MIT");
    expect(m.compatibility.runtimes.node).toMatch(/>=18/);
  });

  it("defaults display_name to name and honors a custom entry point", () => {
    const m = buildMcpbManifest({
      ...input,
      display_name: undefined,
      entryPoint: "bin/run.js",
    }) as any;
    expect(m.display_name).toBe("decksmith");
    expect(m.server.entry_point).toBe("bin/run.js");
  });
});

describe("buildMcpbProxyStub", () => {
  it("spawns mcp-remote against the safely-quoted url", () => {
    const stub = buildMcpbProxyStub("https://decksmith.dev/mcp");
    expect(stub).toContain('const url = "https://decksmith.dev/mcp";');
    expect(stub).toContain('spawn("npx", ["-y", "mcp-remote", url]');
    expect(stub.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("escapes a malicious url instead of breaking out of the literal", () => {
    const stub = buildMcpbProxyStub('https://x"; process.exit(1);//');
    // JSON.stringify keeps it a single safe string literal.
    expect(stub).toContain(
      'const url = "https://x\\"; process.exit(1);//";',
    );
  });
});
