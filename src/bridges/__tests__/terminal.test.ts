import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerTerminalBridge, type TerminalBridgeAdapter, type TerminalRef } from "../terminal";

function makeAdapter(overrides: Partial<TerminalBridgeAdapter> = {}): TerminalBridgeAdapter {
  return {
    getBuffer: () => "$ ",
    write: vi.fn(),
    runCommand: vi.fn(),
    ...overrides,
  };
}

const text = (r: any) => r.content?.[0]?.text ?? "";

describe("registerTerminalBridge — safe by default", () => {
  it("stages terminal_run instead of executing (pendingMode defaults ON)", async () => {
    const host = new ToolRegistry();
    const adapter = makeAdapter();
    const bridge = registerTerminalBridge(host, { adapter });

    const res = await host.callTool("terminal_run", { command: "rm -rf /" });

    expect(res.structuredContent).toMatchObject({ pending: true });
    expect(adapter.runCommand).not.toHaveBeenCalled();
    expect(adapter.write).not.toHaveBeenCalled();

    // The human confirms via the returned bridge — only then does it run.
    bridge.confirm((res.structuredContent as any).id);
    expect(adapter.runCommand).toHaveBeenCalledWith("rm -rf /");
  });

  it("does NOT expose terminal_confirm/reject as agent tools by default", () => {
    const host = new ToolRegistry();
    registerTerminalBridge(host, { adapter: makeAdapter() });
    const names = host.listTools().map((t) => t.name);

    expect(names).not.toContain("terminal_confirm");
    expect(names).not.toContain("terminal_reject");
    expect(names).toContain("terminal_pending"); // read-only listing stays
  });

  it("exposes terminal_confirm/reject only when allowAgentConfirm is set", () => {
    const host = new ToolRegistry();
    registerTerminalBridge(host, { adapter: makeAdapter(), allowAgentConfirm: true });
    const names = host.listTools().map((t) => t.name);

    expect(names).toContain("terminal_confirm");
    expect(names).toContain("terminal_reject");
  });

  it("executes immediately only when pendingMode is explicitly false", async () => {
    const host = new ToolRegistry();
    const adapter = makeAdapter();
    registerTerminalBridge(host, { adapter, pendingMode: false });

    await host.callTool("terminal_run", { command: "ls" });
    expect(adapter.runCommand).toHaveBeenCalledWith("ls");
  });

  it("terminal_set_shell fails closed when the shell isn't listed", async () => {
    const host = new ToolRegistry();
    const setShell = vi.fn();
    // Exposes setShell but NOT listShells — must reject, not pass the id through.
    registerTerminalBridge(host, { adapter: makeAdapter({ setShell }), pendingMode: false });

    const res = await host.callTool("terminal_set_shell", { id: "pwsh" });

    expect(res.isError).toBe(true);
    expect(setShell).not.toHaveBeenCalled();
  });

  it("canAccess hides a terminal from listing and targeting", async () => {
    const host = new ToolRegistry();
    const build: TerminalRef = { id: "build", getBuffer: () => "build-buf", write: vi.fn() };
    const secret: TerminalRef = { id: "secret", getBuffer: () => "SECRET", write: vi.fn() };
    registerTerminalBridge(host, {
      terminals: () => [build, secret],
      canAccess: (id) => id !== "secret",
      pendingMode: false,
    });

    const list = await host.callTool("terminal_list", {});
    expect(text(list)).toContain("build");
    expect(text(list)).not.toContain("secret");

    const read = await host.callTool("terminal_read", { terminal: "secret" });
    expect(read.isError).toBe(true);
  });
});
