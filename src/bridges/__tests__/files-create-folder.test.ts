import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerFilesBridge, type FilesBridgeAdapter } from "../files";

/**
 * `files_create_folder` — the bridge's first WRITE.
 *
 * The bridge shipped read-only and said so: "no write ops (rename/delete/upload)
 * — those arrive later behind a pendingMode-gated iteration". react-fancy 5.18.0
 * gave `FileBrowser` an opt-in New Folder button, so a human can create one and
 * an agent could not. This closes that half.
 *
 * Three properties matter more than the happy path, because this writes to a
 * filesystem on the strength of a model's output:
 *
 * 1. **Capability opt-in.** No `createFolder` on the adapter, no tool. A host
 *    that never wired creation cannot have an agent create anything, and the
 *    tool list tells the truth about what is possible.
 * 2. **Containment.** The path goes through the same root guard as every read,
 *    and the NAME is checked separately — a separator or `..` in a name is a
 *    traversal attempt wearing a different hat, and `assertPathWithinRoot`
 *    inspects the parent path, not the leaf being appended to it.
 * 3. **Staged by default.** `pendingMode` defaults ON, matching the catalog
 *    bridge's destructive ops. An agent proposes; a human confirms.
 */
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

const tools = (host: ToolRegistry) => host.listTools().map((t) => t.name);

describe("the capability opt-in", () => {
  it("registers NO tool when the adapter cannot create folders", () => {
    const host = new ToolRegistry();
    registerFilesBridge(host, { adapter: makeAdapter() });

    expect(tools(host)).not.toContain("files_create_folder");
  });

  it("registers it once the adapter can", () => {
    const host = new ToolRegistry();
    registerFilesBridge(host, { adapter: makeAdapter({ createFolder: vi.fn() }) });

    expect(tools(host)).toContain("files_create_folder");
  });
});

describe("containment", () => {
  it("rejects a parent outside the root, without calling the adapter", async () => {
    const host = new ToolRegistry();
    const createFolder = vi.fn();
    registerFilesBridge(host, {
      adapter: makeAdapter({ createFolder }),
      root: "/root",
      pendingMode: false,
    });

    const res = await host.callTool("files_create_folder", { parentPath: "../../etc", name: "evil" });
    expect(res.isError).toBe(true);
    expect(createFolder).not.toHaveBeenCalled();
  });

  it.each([
    ["a separator", "a/b"],
    ["a backslash", "a\\b"],
    ["dot-dot", ".."],
    ["a single dot", "."],
    ["empty", "   "],
  ])("rejects %s as a NAME, without calling the adapter", async (_label, name) => {
    // The root guard checks the PARENT path. A name is appended to it, so
    // `{ parentPath: "/root", name: "../.." }` passes that check and still
    // escapes — the leaf needs its own rule.
    const host = new ToolRegistry();
    const createFolder = vi.fn();
    registerFilesBridge(host, {
      adapter: makeAdapter({ createFolder }),
      root: "/root",
      pendingMode: false,
    });

    const res = await host.callTool("files_create_folder", { parentPath: "/root", name });
    expect(res.isError).toBe(true);
    expect(createFolder).not.toHaveBeenCalled();
  });
});

describe("staged by default", () => {
  it("does NOT create without confirmation", async () => {
    const host = new ToolRegistry();
    const createFolder = vi.fn();
    registerFilesBridge(host, { adapter: makeAdapter({ createFolder }) });

    const res = await host.callTool("files_create_folder", { parentPath: "/root", name: "utils" });

    expect(createFolder).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
  });

  it("creates when the host confirm hook approves", async () => {
    const host = new ToolRegistry();
    const createFolder = vi.fn();
    const confirm = vi.fn(async () => true);
    registerFilesBridge(host, { adapter: makeAdapter({ createFolder }), confirm });

    const res = await host.callTool("files_create_folder", { parentPath: "/root", name: "utils" });

    expect(confirm).toHaveBeenCalled();
    expect(createFolder).toHaveBeenCalledWith({ parentPath: "/root", name: "utils" });
    expect(res.isError).toBeFalsy();
  });

  it("does not create when the human declines", async () => {
    const host = new ToolRegistry();
    const createFolder = vi.fn();
    registerFilesBridge(host, {
      adapter: makeAdapter({ createFolder }),
      confirm: async () => false,
    });

    const res = await host.callTool("files_create_folder", { parentPath: "/root", name: "utils" });

    expect(createFolder).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
  });

  it("accepts an explicit confirm:true when the host wired no hook", async () => {
    // The catalog bridge's convention: with no host hook, the agent's own
    // acknowledgement is the staged step.
    const host = new ToolRegistry();
    const createFolder = vi.fn();
    registerFilesBridge(host, { adapter: makeAdapter({ createFolder }) });

    const res = await host.callTool("files_create_folder", {
      parentPath: "/root",
      name: "utils",
      confirm: true,
    });

    expect(createFolder).toHaveBeenCalled();
    expect(res.isError).toBeFalsy();
  });

  it("creates outright when the host turned staging off", async () => {
    const host = new ToolRegistry();
    const createFolder = vi.fn();
    registerFilesBridge(host, {
      adapter: makeAdapter({ createFolder }),
      pendingMode: false,
    });

    const res = await host.callTool("files_create_folder", { parentPath: "/root", name: "utils" });

    expect(createFolder).toHaveBeenCalled();
    expect(res.isError).toBeFalsy();
  });
});

describe("the adapter's own failure", () => {
  it("surfaces a rejection as a tool error rather than reporting success", async () => {
    const host = new ToolRegistry();
    registerFilesBridge(host, {
      adapter: makeAdapter({
        createFolder: vi.fn(async () => {
          throw new Error("EACCES: permission denied");
        }),
      }),
      pendingMode: false,
    });

    const res = await host.callTool("files_create_folder", { parentPath: "/root", name: "utils" });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toMatch(/permission denied/i);
  });
});
