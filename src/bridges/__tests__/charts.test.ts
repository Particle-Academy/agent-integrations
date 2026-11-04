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

  it("describes a writable chart exactly as before", async () => {
    const { call } = setup();
    const { text } = await call("chart_describe");

    expect(JSON.parse(text)).toEqual({
      id: "revenue",
      title: "Revenue",
      seriesCount: 1,
      seriesTypes: ["bar"],
      hasXAxis: true,
      hasYAxis: false,
    });
  });
});

/**
 * A host showing numbers an engine computed can refuse an agent the means to draw
 * others. All three writers can carry `series`, including `chart_update_option`,
 * whose fallback goes through `setOption`, so read-only has to mean all of them.
 */
describe("registerChartsBridge readOnly", () => {
  const WRITERS = ["chart_set_option", "chart_update_option", "chart_update_data"];

  function setupReadOnly() {
    const series = [{ type: "bar", data: [1, 2] }];
    const writes: string[] = [];
    const host = new ToolRegistry();

    registerChartsBridge(host, {
      readOnly: true,
      // A full adapter, as a host sharing one object across modes would pass.
      adapter: {
        id: "revenue",
        title: "Revenue",
        getOption: () => ({ series }),
        setOption: () => writes.push("setOption"),
        updateOption: () => writes.push("updateOption"),
        updateData: () => writes.push("updateData"),
      },
    });

    const call = async (name: string, args: JsonObject = {}) => {
      const r = await host.callTool(name, args);
      return { isError: r.isError, text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "" };
    };

    return { host, call, writes };
  }

  beforeEach(() => resetAllUndoStacks());

  it("does not list any writer", () => {
    const names = setupReadOnly().host.listTools().map((t) => t.name);

    for (const t of WRITERS) expect(names, `${t} is listed`).not.toContain(t);
  });

  it("still lists the reads", () => {
    const names = setupReadOnly().host.listTools().map((t) => t.name);

    expect(names).toContain("chart_describe");
    expect(names).toContain("chart_get_option");
  });

  it.each([
    ["chart_set_option", { option: { series: [{ type: "bar", data: [999] }] } }],
    ["chart_update_option", { partial: { series: [{ type: "bar", data: [999] }] } }],
    ["chart_update_data", { data: [999] }],
  ])("%s called anyway reaches no writer", async (name, args) => {
    const { call, writes } = setupReadOnly();

    const r = await call(name, args as JsonObject).catch((e: unknown) => ({ isError: true, text: String(e) }));

    expect(r.isError).toBe(true);
    expect(writes).toEqual([]);
  });

  it("tells the agent why, so it does not go looking for another route", async () => {
    const { call } = setupReadOnly();
    const { text } = await call("chart_describe");

    expect(JSON.parse(text).readOnly).toBe(true);
  });

  it("reads the option as usual", async () => {
    const { call } = setupReadOnly();
    const { text } = await call("chart_get_option");

    expect(JSON.parse(text).series[0].data).toEqual([1, 2]);
  });

  it("asks a read-only host for no writer at all", () => {
    // Compile-time half of this: `setOption` is not required here. `npx tsc` checks it.
    const host = new ToolRegistry();

    registerChartsBridge(host, { readOnly: true, adapter: { id: "a", getOption: () => ({}) } });

    expect(host.listTools().map((t) => t.name)).toContain("chart_describe");
  });

  it("fails closed for a host not using TypeScript", () => {
    const host = new ToolRegistry();

    registerChartsBridge(host, {
      readOnly: "yes" as unknown as true,
      adapter: { id: "a", getOption: () => ({}) },
    });

    const names = host.listTools().map((t) => t.name);
    for (const t of WRITERS) expect(names).not.toContain(t);
  });

  it("readOnly: false is the default behaviour", () => {
    const host = new ToolRegistry();

    registerChartsBridge(host, {
      readOnly: false,
      adapter: { id: "a", getOption: () => ({}), setOption: () => {} },
    });

    const names = host.listTools().map((t) => t.name);
    for (const t of WRITERS) expect(names).toContain(t);
  });

  it("takes a flag decided at runtime, with a full adapter", () => {
    const decide = (flag: boolean) => {
      const host = new ToolRegistry();
      registerChartsBridge(host, {
        readOnly: flag,
        adapter: { id: "a", getOption: () => ({}), setOption: () => {} },
      });
      return host.listTools().map((t) => t.name);
    };

    expect(decide(true)).not.toContain("chart_set_option");
    expect(decide(false)).toContain("chart_set_option");
  });

  it("releases its tools on dispose, like any bridge", () => {
    const host = new ToolRegistry();
    const bridge = registerChartsBridge(host, { readOnly: true, adapter: { id: "a", getOption: () => ({}) } });

    bridge.dispose();

    expect(host.listTools().map((t) => t.name)).not.toContain("chart_describe");
  });
});
