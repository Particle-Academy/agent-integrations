import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";
import type { AgentTarget } from "../presence/types";

/**
 * Adapter wires a single fancy-echarts chart to the bridge. Charts are
 * already prop-driven, so the adapter just exposes the data + option
 * setters and a way to read what's currently rendered.
 */
export type ChartsBridgeAdapter = {
  /** Stable id for this chart instance. */
  id: string;
  title?: string;
  screenId?: string;
  /** Read the current ECharts option object the chart is rendering. */
  getOption: () => Record<string, unknown>;
  /** Replace the entire option. */
  setOption: (option: Record<string, unknown>) => void;
  /** Convenience: shallow-merge a partial option update. */
  updateOption?: (partial: Record<string, unknown>) => void;
  /** Read just the data series (subset of option for quick agent reads). */
  getData?: () => unknown;
  /** Update only the data, leaving axes/colors/etc. alone. */
  updateData?: (data: unknown) => void;
};

export type ChartsBridgeOptions = {
  adapter: ChartsBridgeAdapter;
  agent?: { id: string; name?: string; color?: string };
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };

/**
 * registerChartsBridge — schema-aware MCP access to a single chart.
 */
export function registerChartsBridge(
  host: ToolHost,
  options: ChartsBridgeOptions,
): Bridge {
  const { adapter } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const disposers: Array<() => void> = [];

  // agent_undo / agent_redo / agent_history are registered whenever any bridge
  // mounts, so undo availability doesn't hinge on which bridges are co-present.
  ensureUndoToolsRegistered(host, { defaultAgentId: agent.id });

  const target: AgentTarget = {
    kind: "chart",
    screenId: adapter.screenId,
    elementId: adapter.id,
    label: adapter.title ?? adapter.id,
  };

  const reg = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: JsonObject) => Promise<any> | any,
    isMutation: boolean,
  ) => {
    const wrapped = async (args: JsonObject) => {
      try { return await handler(args); }
      catch (e) { return errorResult(e instanceof Error ? e.message : String(e)); }
    };
    const final = isMutation
      ? wrapToolWithActivity(wrapped, {
          toolName: name, agent, kind: "chart", screenId: adapter.screenId,
          resolveTarget: () => target,
        })
      : wrapped;
    disposers.push(
      host.registerTool(
        { name, description, inputSchema: { type: "object", properties: properties as any, required, additionalProperties: false } },
        final as any,
      ),
    );
  };

  reg(
    "chart_describe",
    `Describe the chart "${adapter.id}" — series count, type guesses, axis info.`,
    {},
    [],
    () => {
      const opt = adapter.getOption();
      const series = Array.isArray(opt.series) ? opt.series : [];
      const summary = {
        id: adapter.id,
        title: adapter.title,
        seriesCount: series.length,
        seriesTypes: series.map((s: any) => s?.type ?? "unknown"),
        hasXAxis: !!opt.xAxis,
        hasYAxis: !!opt.yAxis,
      };
      return textResult(JSON.stringify(summary), summary);
    },
    false,
  );

  reg(
    "chart_get_option",
    "Read the full ECharts option object the chart is rendering.",
    {},
    [],
    () => {
      const opt = adapter.getOption();
      return textResult(JSON.stringify(opt, null, 2), opt);
    },
    false,
  );

  reg(
    "chart_set_option",
    "Replace the entire ECharts option. Use chart_update_option for partial updates.",
    { option: { type: "object" } },
    ["option"],
    (args) => {
      const opt = (args.option && typeof args.option === "object") ? args.option as Record<string, unknown> : {};
      adapter.setOption(opt);
      return textResult("Replaced chart option", { });
    },
    true,
  );

  reg(
    "chart_update_option",
    "Shallow-merge a partial option update — only the keys you provide change.",
    { partial: { type: "object" } },
    ["partial"],
    (args) => {
      const partial = (args.partial && typeof args.partial === "object") ? args.partial as Record<string, unknown> : {};
      if (adapter.updateOption) {
        adapter.updateOption(partial);
      } else {
        adapter.setOption({ ...adapter.getOption(), ...partial });
      }
      return textResult("Merged chart option", { keys: Object.keys(partial) });
    },
    true,
  );

  reg(
    "chart_update_data",
    "Update only the data (typically the `series` field). Leaves layout / axes / colors alone.",
    { data: { description: "New series array (or whatever shape the host's adapter expects)." } },
    ["data"],
    (args) => {
      if (!adapter.updateData) return errorResult("Host did not provide updateData.");
      adapter.updateData(args.data);
      return textResult("Updated chart data", { });
    },
    true,
  );

  return {
    id: `chart:${adapter.id}`,
    title: adapter.title ?? adapter.id,
    dispose: () => { for (const d of disposers) d(); },
  };
}
