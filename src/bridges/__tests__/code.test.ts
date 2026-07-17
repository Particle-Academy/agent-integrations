import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerCodeBridge, type CodeBridgeAdapter } from "../code";

function makeAdapter(initial = "original"): { adapter: CodeBridgeAdapter; state: { value: string; lang: string } } {
  const state = { value: initial, lang: "text" };
  const adapter: CodeBridgeAdapter = {
    id: "editor",
    getValue: () => state.value,
    setValue: (v) => {
      state.value = v;
    },
    getLanguage: () => state.lang,
    setLanguage: (l) => {
      state.lang = l;
    },
    replaceSelection: (t) => {
      state.value = state.value + t;
    },
  };
  return { adapter, state };
}

describe("registerCodeBridge — undo", () => {
  it("code_set_value is reversible via agent_undo", async () => {
    const host = new ToolRegistry();
    const { adapter, state } = makeAdapter("original");
    registerCodeBridge(host, { adapter });

    await host.callTool("code_set_value", { value: "replaced" });
    expect(state.value).toBe("replaced");

    const undo = await host.callTool("agent_undo", {});
    expect(undo.isError).toBeFalsy();
    expect(state.value).toBe("original");
  });

  it("code_append is reversible", async () => {
    const host = new ToolRegistry();
    const { adapter, state } = makeAdapter("a");
    registerCodeBridge(host, { adapter });

    await host.callTool("code_append", { text: "b" });
    expect(state.value).toBe("ab");
    await host.callTool("agent_undo", {});
    expect(state.value).toBe("a");
  });

  it("code_stream_append rejects oversized text", async () => {
    const host = new ToolRegistry();
    const { adapter } = makeAdapter("");
    registerCodeBridge(host, { adapter });

    const res = await host.callTool("code_stream_append", { text: "x".repeat(10_001), cps: 10_000 });
    expect(res.isError).toBe(true);
  });
});
