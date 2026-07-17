import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerFilesBridge, assertPathWithinRoot, type FilesBridgeAdapter } from "../files";

function makeAdapter(overrides: Partial<FilesBridgeAdapter> = {}): FilesBridgeAdapter {
  let path = "/root";
  return {
    getPath: () => path,
    setPath: (p) => {
      path = p;
    },
    getSelection: () => [],
    setSelection: vi.fn(),
    getExpanded: () => [],
    setExpanded: vi.fn(),
    listChildren: vi.fn(() => []),
    ...overrides,
  };
}

describe("assertPathWithinRoot", () => {
  it("rejects traversal and out-of-root absolutes; allows contained paths", () => {
    expect(() => assertPathWithinRoot("/root", "../etc")).toThrow();
    expect(() => assertPathWithinRoot("/root", "a/../../b")).toThrow();
    expect(() => assertPathWithinRoot("/root", "/etc/passwd")).toThrow();
    expect(() => assertPathWithinRoot("C:/proj", "C:/Windows/System32")).toThrow();

    expect(() => assertPathWithinRoot("/root", "sub/dir")).not.toThrow();
    expect(() => assertPathWithinRoot("/root", "/root/sub")).not.toThrow();
    expect(() => assertPathWithinRoot("C:/proj", "C:/proj/src")).not.toThrow();
  });
});

describe("registerFilesBridge — root containment", () => {
  it("files_list rejects a traversal path when root is set (adapter never called)", async () => {
    const host = new ToolRegistry();
    const listChildren = vi.fn(() => []);
    registerFilesBridge(host, { adapter: makeAdapter({ listChildren }), root: "/root" });

    const res = await host.callTool("files_list", { path: "../../etc" });
    expect(res.isError).toBe(true);
    expect(listChildren).not.toHaveBeenCalled();
  });

  it("files_list allows a contained path", async () => {
    const host = new ToolRegistry();
    const listChildren = vi.fn(() => []);
    registerFilesBridge(host, { adapter: makeAdapter({ listChildren }), root: "/root" });

    const res = await host.callTool("files_list", { path: "/root/src" });
    expect(res.isError).toBeFalsy();
    expect(listChildren).toHaveBeenCalledWith("/root/src");
  });

  it("clamps snapshot depth", async () => {
    const host = new ToolRegistry();
    const requestSnapshot = vi.fn(() => []);
    registerFilesBridge(host, { adapter: makeAdapter({ requestSnapshot }), root: "/root" });

    await host.callTool("files_request_snapshot", { path: "/root", depth: 9999 });
    const passedDepth = requestSnapshot.mock.calls[0][1];
    expect(passedDepth).toBeLessThanOrEqual(8);
  });
});
