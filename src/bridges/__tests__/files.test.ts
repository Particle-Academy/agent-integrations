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

  it("collapses redundant slashes without a trailing slash changing the verdict", () => {
    // The trailing-slash strip must still behave: a root or path with a trailing
    // slash compares equal to the same without one.
    expect(() => assertPathWithinRoot("/root/", "/root/sub")).not.toThrow();
    expect(() => assertPathWithinRoot("/root", "/root/sub/")).not.toThrow();
    expect(() => assertPathWithinRoot("/root//deep", "/root/deep/x")).not.toThrow();
    expect(() => assertPathWithinRoot("/root", "/rootother/x")).toThrow();
  });

  it("handles a path of many slashes correctly (the CodeQL-flagged regex was here)", () => {
    // CodeQL flagged `/\/+$/` as a polynomial ReDoS. In THIS path it is defused
    // — the preceding `.replace(/[\\/]+/g, "/")` collapses every slash-run to a
    // single `/` before the trailing-strip regex runs, so no repetition ever
    // reaches it. The fix drops the redundant `+` for hygiene and to clear the
    // alert; this asserts the collapse-then-guard still returns the right
    // verdict on a pathological many-slash input.
    expect(() => assertPathWithinRoot("/root", "/" + "/".repeat(10_000) + "etc/passwd")).toThrow();
    expect(() => assertPathWithinRoot("/root", "/root" + "/".repeat(10_000) + "sub")).not.toThrow();
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
    const requestSnapshot = vi.fn((_path: string, _depth?: number) => [] as never[]);
    registerFilesBridge(host, { adapter: makeAdapter({ requestSnapshot }), root: "/root" });

    await host.callTool("files_request_snapshot", { path: "/root", depth: 9999 });
    const passedDepth = requestSnapshot.mock.calls[0]?.[1];
    expect(passedDepth).toBeLessThanOrEqual(8);
  });
});
