import { beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../tool-host";
import { MicroMcpServer } from "../server";
import { registerChartsBridge } from "../../bridges/charts";
import { registerSheetsBridge } from "../../bridges/sheets";
import { registerUndoTools } from "../../undo/undo-tools";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import type { ChartsBridgeOptions } from "../../bridges/charts";
import type { SheetsBridgeOptions } from "../../bridges/sheets";
import type { CallToolResult } from "../types";

/**
 * Tool names are a shared namespace, so a name belongs to whoever registered it.
 *
 * Before this, `registerTool` was a bare `Map.set`: a second registrant for the
 * same name replaced the first, silently. In a multi-agent app (two bridges, two
 * agents, one host) the first surface simply stopped being reachable. Its tools
 * still showed in `tools/list`, but every call went to the second surface's
 * handler, and nothing anywhere reported it.
 *
 * Two kinds of re-registration are legitimate and must keep working:
 *
 *   - the SAME surface registering again. A React remount re-runs the bridge's
 *     effect, and the playground applies the same bridges to the same server
 *     through more than one path.
 *   - the shared undo tools (`agent_undo` / `agent_redo` / `agent_history`),
 *     which every bridge ensures and which are shared on purpose.
 */

const ok = async (): Promise<CallToolResult> => ({ content: [{ type: "text", text: "ok" }] });
const says = (text: string) => async (): Promise<CallToolResult> => ({ content: [{ type: "text", text }] });

async function textOf(host: ToolRegistry, name: string): Promise<string> {
  const r = await host.callTool(name, {});
  return (r.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");
}

function chartAdapter(id: string, title = id): ChartsBridgeOptions["adapter"] {
  let option: Record<string, unknown> = { title: { text: title } };
  return {
    id,
    title,
    getOption: () => option,
    setOption: (next) => {
      option = next;
    },
  };
}

function sheetsAdapter(): SheetsBridgeOptions["adapter"] {
  return {
    getWorkbook: () => ({ sheets: [{ id: "s1", name: "Sheet1", cells: {} }], activeSheetId: "s1" }),
    getActiveSheetId: () => "s1",
    setCellValue: () => {},
  } as unknown as SheetsBridgeOptions["adapter"];
}

describe("registerTool refuses a name held by a different registrant", () => {
  beforeEach(() => resetAllUndoStacks());

  it("throws when two different bridges claim one tool name, naming both owners", () => {
    const host = new ToolRegistry();
    registerChartsBridge(host, { adapter: chartAdapter("revenue") });

    let error: unknown;
    try {
      registerChartsBridge(host, { adapter: chartAdapter("costs") });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("chart:revenue");
    expect(message).toContain("chart:costs");
    expect(message).toMatch(/chart_\w+/);
  });

  it("leaves the first registrant's tool in place when refusing the second", async () => {
    const host = new ToolRegistry();
    host.registerTool({ name: "support_reply", inputSchema: { type: "object" } }, says("triage"), { owner: "triage" });

    expect(() =>
      host.registerTool({ name: "support_reply", inputSchema: { type: "object" } }, says("billing"), { owner: "billing" }),
    ).toThrow(/"triage".*"billing"|"billing".*"triage"/s);

    expect(await textOf(host, "support_reply")).toBe("triage");
  });

  it("refuses an unowned registration over an owned one, and says the newcomer is unnamed", () => {
    const host = new ToolRegistry();
    host.registerTool({ name: "x", inputSchema: { type: "object" } }, ok, { owner: "whiteboard" });

    expect(() => host.registerTool({ name: "x", inputSchema: { type: "object" } }, ok)).toThrow(
      /"whiteboard".*unnamed/s,
    );
  });

  it("treats two unowned registrations as different registrants", () => {
    // Without an owner there is nothing to say they are the same surface, and
    // assuming so is exactly the silent overwrite this guards against.
    const host = new ToolRegistry();
    host.registerTool({ name: "x", inputSchema: { type: "object" } }, ok);

    expect(() => host.registerTool({ name: "x", inputSchema: { type: "object" } }, ok)).toThrow(/"x"/);
  });

  it("fails before any tool of the refused bridge is half-registered on a MicroMcpServer", () => {
    const server = new MicroMcpServer({ info: { name: "t", version: "1" } });
    registerChartsBridge(server, { adapter: chartAdapter("revenue") });
    const before = server.listTools().map((t) => t.name).sort();

    expect(() => registerChartsBridge(server, { adapter: chartAdapter("costs") })).toThrow();

    // The bridge's first tool is the one refused, so nothing of "costs" landed.
    expect(server.listTools().map((t) => t.name).sort()).toEqual(before);
  });
});

describe("the same registrant may register again", () => {
  beforeEach(() => resetAllUndoStacks());

  it("a remount of the same bridge, without a dispose in between, re-registers and takes effect", async () => {
    const host = new ToolRegistry();
    registerChartsBridge(host, { adapter: chartAdapter("revenue", "first mount") });

    expect(() => registerChartsBridge(host, { adapter: chartAdapter("revenue", "second mount") })).not.toThrow();
    expect(await textOf(host, "chart_get_option")).toContain("second mount");
  });

  it("a remount with a dispose in between (React StrictMode) works", async () => {
    const host = new ToolRegistry();
    const first = registerChartsBridge(host, { adapter: chartAdapter("revenue", "first mount") });
    first.dispose();

    registerChartsBridge(host, { adapter: chartAdapter("revenue", "second mount") });
    expect(await textOf(host, "chart_get_option")).toContain("second mount");
  });

  it("a stale disposer from the replaced registration does not withdraw its successor", async () => {
    const host = new ToolRegistry();
    const first = registerChartsBridge(host, { adapter: chartAdapter("revenue", "first mount") });
    registerChartsBridge(host, { adapter: chartAdapter("revenue", "second mount") });

    // The first mount's cleanup runs late. It owns nothing any more.
    first.dispose();

    expect(host.getTool("chart_get_option")).not.toBeNull();
    expect(await textOf(host, "chart_get_option")).toContain("second mount");
  });
});

describe("the shared undo tools are not refused", () => {
  beforeEach(() => resetAllUndoStacks());

  it("two different bridges on one host both get agent_undo / agent_redo / agent_history", () => {
    const host = new ToolRegistry();
    registerChartsBridge(host, { adapter: chartAdapter("revenue") });

    expect(() => registerSheetsBridge(host, { adapter: sheetsAdapter() })).not.toThrow();

    const names = host.listTools().map((t) => t.name);
    for (const n of ["agent_undo", "agent_redo", "agent_history"]) expect(names).toContain(n);
  });

  it("registerUndoTools called directly, then bridges ensuring them (the playground's order), is allowed", () => {
    const host = new ToolRegistry();
    registerUndoTools(host, { defaultAgentId: "agent" });

    expect(() => registerChartsBridge(host, { adapter: chartAdapter("revenue") })).not.toThrow();
    expect(() => registerUndoTools(host, { defaultAgentId: "agent" })).not.toThrow();
  });

  it("refuses a different registrant claiming agent_undo", () => {
    const host = new ToolRegistry();
    registerUndoTools(host);

    expect(() =>
      host.registerTool({ name: "agent_undo", inputSchema: { type: "object" } }, ok, { owner: "my-app" }),
    ).toThrow(/agent_undo/);
  });
});

describe("disposing frees a registrant's names", () => {
  beforeEach(() => resetAllUndoStacks());

  it("a different bridge can register the names after the first is disposed", async () => {
    const host = new ToolRegistry();
    const revenue = registerChartsBridge(host, { adapter: chartAdapter("revenue", "Revenue") });
    revenue.dispose();

    expect(() => registerChartsBridge(host, { adapter: chartAdapter("costs", "Costs") })).not.toThrow();
    expect(await textOf(host, "chart_get_option")).toContain("Costs");
  });

  it("a single tool's disposer frees its name", () => {
    const host = new ToolRegistry();
    const dispose = host.registerTool({ name: "x", inputSchema: { type: "object" } }, ok, { owner: "a" });
    dispose();

    expect(() => host.registerTool({ name: "x", inputSchema: { type: "object" } }, ok, { owner: "b" })).not.toThrow();
  });
});

describe("replace: true is the explicit opt-in to take a name over", () => {
  it("replaces a different registrant's tool when asked to", async () => {
    const host = new ToolRegistry();
    host.registerTool({ name: "x", inputSchema: { type: "object" } }, says("old"), { owner: "a" });

    expect(() =>
      host.registerTool({ name: "x", inputSchema: { type: "object" } }, says("new"), { owner: "b", replace: true }),
    ).not.toThrow();
    expect(await textOf(host, "x")).toBe("new");
  });

  it("the displaced registrant's disposer cannot then withdraw the replacement", async () => {
    const host = new ToolRegistry();
    const disposeOld = host.registerTool({ name: "x", inputSchema: { type: "object" } }, says("old"), { owner: "a" });
    host.registerTool({ name: "x", inputSchema: { type: "object" } }, says("new"), { replace: true });

    disposeOld();

    expect(await textOf(host, "x")).toBe("new");
  });
});
