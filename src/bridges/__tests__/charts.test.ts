import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerChartsBridge } from "../charts";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import type { JsonObject } from "../../mcp/types";

function setup(opts: { withOptionalWriters?: boolean } = {}) {
  let option: Record<string, unknown> = {
    title: { text: "Revenue" },
    xAxis: { data: ["Jan", "Feb"] },
    series: [{ type: "bar", data: [1, 2] }],
  };
  const host = new ToolRegistry();

  registerChartsBridge(host, {
    adapter: {
      id: "revenue",
      title: "Revenue",
      getOption: () => option,
      setOption: (next) => {
        option = next;
      },
      ...(opts.withOptionalWriters === false
        ? {}
        : {
            updateOption: (partial) => {
              option = { ...option, ...partial };
            },
            getData: () => (option.series as Array<{ data: unknown }>)[0]?.data,
            updateData: (data) => {
              option = { ...option, series: [{ type: "bar", data }] };
            },
          }),
    },
  });

  const call = async (name: string, args: JsonObject = {}) => {
    const r = await host.callTool(name, args);
    return { isError: r.isError, text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "" };
  };

  return { host, call, option: () => option };
}

describe("registerChartsBridge", () => {
  beforeEach(() => resetAllUndoStacks());

  it("registers its tools", () => {
    const names = setup().host.listTools().map((t) => t.name);

    for (const t of ["chart_describe", "chart_get_option", "chart_set_option", "chart_update_option", "chart_update_data"]) {
      expect(names, `missing ${t}`).toContain(t);
    }
  });

  it("reads the option the chart is actually rendering", async () => {
    const { call } = setup();
    const { text } = await call("chart_get_option");

    expect(text).toContain("Revenue");
  });

  it("writes through setOption rather than mutating the object it read", async () => {
    // The chart is prop-driven, so a mutation in place would not re-render and
    // the agent would see its own write reflected while the user saw nothing.
    const { call, option } = setup();
    const before = option();

    await call("chart_set_option", { option: { title: { text: "Costs" } } });

    expect(option()).not.toBe(before);
    expect((option().title as { text: string }).text).toBe("Costs");
  });

  it("merges a partial update instead of replacing the whole option", async () => {
    const { call, option } = setup();

    await call("chart_update_option", { partial: { title: { text: "Merged" } } });

    expect((option().title as { text: string }).text).toBe("Merged");
    expect(option().series, "series should survive a partial update").toBeDefined();
  });

  it("updates data without disturbing the axes", async () => {
    const { call, option } = setup();

    await call("chart_update_data", { data: [9, 9, 9] });

    expect(JSON.stringify(option().series)).toContain("9");
  });

  it("reports a missing optional writer as an error, not a silent no-op", async () => {
    // `updateOption` / `updateData` are optional on the adapter. A host that
    // does not supply them must get a refusal — an agent told nothing happened
    // can pick another route; one told nothing at all writes into a void.
    const { call } = setup({ withOptionalWriters: false });

    const r = await call("chart_update_data", { data: [1] });
    expect(r.isError).toBe(true);
  });
});
