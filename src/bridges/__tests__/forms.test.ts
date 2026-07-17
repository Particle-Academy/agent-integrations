import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerFormBridge, type FormBridgeAdapter } from "../forms";

function makeAdapter(overrides: Partial<FormBridgeAdapter> = {}): FormBridgeAdapter {
  const values: Record<string, unknown> = { email: "" };
  return {
    id: "signup",
    title: "Sign up",
    getFields: () => [{ name: "email", type: "email", required: true }],
    getValue: (n) => values[n],
    getValues: () => ({ ...values }),
    setValue: (n, v) => {
      values[n] = v;
    },
    submit: vi.fn(async () => ({ ok: true, values })),
    ...overrides,
  };
}

const text = (r: any) => r.content?.[0]?.text ?? "";

describe("registerFormBridge — staged submit", () => {
  it("declined confirm blocks the submit", async () => {
    const host = new ToolRegistry();
    const confirm = vi.fn(async () => false);
    const adapter = makeAdapter({ confirm });
    registerFormBridge(host, { adapter }); // pendingMode defaults on

    const res = await host.callTool("form_submit", {});

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ action: "submit", form: "signup" }),
    );
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(text(res)).toContain("Declined");
  });

  it("proceeds when confirm resolves true", async () => {
    const host = new ToolRegistry();
    const confirm = vi.fn(async () => true);
    const adapter = makeAdapter({ confirm });
    registerFormBridge(host, { adapter });

    await host.callTool("form_submit", {});
    expect(adapter.submit).toHaveBeenCalled();
  });

  it("submits directly when no confirm hook is wired (nothing to gate)", async () => {
    const host = new ToolRegistry();
    const adapter = makeAdapter(); // no confirm
    registerFormBridge(host, { adapter });

    await host.callTool("form_submit", {});
    expect(adapter.submit).toHaveBeenCalled();
  });
});
