import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry, type ToolHost } from "../../mcp/tool-host";
import type { CallToolResult } from "../../mcp/types";
import { pushUndoEntry, resetAllUndoStacks } from "../../undo/undo-stack";
import { registerUndoTools } from "../../undo/undo-tools";
import { registerAgentChatBridge } from "../agent-chat";
import { registerArtboardBridge } from "../artboard";
import { registerCatalogBridge } from "../catalog";
import { registerChartsBridge } from "../charts";
import { registerCmsBridge } from "../cms";
import { registerCodeBridge } from "../code";
import { registerContentReactionBridge } from "../content-reaction";
import { registerCoworkBridge } from "../cowork";
import { registerFeaturesBridge } from "../features";
import { registerFilesBridge } from "../files";
import { registerFlowBridge } from "../flow";
import { registerFormBridge } from "../forms";
import { registerGitBridge } from "../git";
import { registerGraphBridge } from "../graph";
import { registerGridBridge } from "../grid";
import { registerMapBridge } from "../map";
import { registerNavigationBridge } from "../navigation";
import { registerPasskeyBridge } from "../passkeys";
import { registerSceneBridge } from "../scene";
import { registerScreenDocBridge } from "../screen-doc";
import { registerScreensBridge } from "../screens";
import { registerSheetsBridge } from "../sheets";
import { registerSignBridge } from "../sign";
import { registerTemplateBridge } from "../template";
import { registerSlidesBridge } from "../slides";
import { registerTerminalBridge } from "../terminal";
import { registerTuiBridge } from "../tui";
import { registerWhiteboardBridge } from "../whiteboard";

/**
 * Every bridge's `structuredContent` is a JSON object.
 *
 * MCP 2025-06-18 onward types `structuredContent` as an object, and a client
 * that validates it rejects an array outright. Ten list tools used to return
 * their rows as a bare array; they now wrap them under one named key. This
 * sweep calls EVERY tool of EVERY bridge so a new array cannot slip in.
 *
 * The adapter is a "rows" proxy: any call returns something that behaves as a
 * one-row list AND as an object, so list tools produce real arrays and object
 * tools produce objects. What is checked is the WIRE shape — the value after a
 * JSON round trip — because that is what the client receives.
 *
 * A sweep that reaches nothing passes vacuously, so the instrument is proven:
 * each of the ten list tools must actually return structured content here, and
 * the git guard is driven with an adapter that returns an array on purpose.
 */

/**
 * How many proxy values one tool call may create. A handler that walks the
 * proxy forever (a cursor loop, a recursive tree walk) hits this and throws,
 * which the sweep treats like any refusal: no structured content.
 */
const BUDGET = 2_000;
let made = 0;

/**
 * A value that answers any property, any call, and any list operation with one
 * row. `overrides` pins named properties to real values, for a handler that
 * passes an adapter's list straight through (a proxy serialises to nothing, so
 * it would never be seen on the wire).
 */
function rows(overrides: Record<string, unknown> = {}): any {
  if (++made > BUDGET) throw new Error("rows budget exhausted");
  const target = function () {};
  const proxy: any = new Proxy(target, {
    get: (_t, key) => {
      if (typeof key === "string" && Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
      if (key === "then") return undefined;
      if (key === "toJSON") return undefined;
      if (key === Symbol.toPrimitive) return () => "x";
      if (key === Symbol.iterator) return function* () { yield rows(); };
      if (key === "length") return 1;
      if (key === "0") return rows();
      if (typeof key === "string" && typeof (Array.prototype as any)[key] === "function") return (Array.prototype as any)[key];
      return rows();
    },
    apply: () => rows(),
  });
  return proxy;
}

const BRIDGES: Record<string, (host: ToolHost) => unknown> = {
  registerAgentChatBridge: (h) => registerAgentChatBridge(h, { adapter: rows() } as never),
  registerArtboardBridge: (h) => registerArtboardBridge(h, { adapter: rows() } as never),
  registerCatalogBridge: (h) => registerCatalogBridge(h, { adapter: rows() } as never),
  registerChartsBridge: (h) => registerChartsBridge(h, { adapter: rows() } as never),
  registerCmsBridge: (h) => registerCmsBridge(h, { adapter: rows() } as never),
  registerCodeBridge: (h) => registerCodeBridge(h, { adapter: rows() } as never),
  registerContentReactionBridge: (h) => registerContentReactionBridge(h, { adapter: rows() } as never),
  registerCoworkBridge: (h) => registerCoworkBridge(h, { session: rows(), id: "shape" } as never),
  registerFeaturesBridge: (h) => registerFeaturesBridge(h, { adapter: rows() } as never),
  registerFilesBridge: (h) => registerFilesBridge(h, { adapter: rows() } as never),
  registerFlowBridge: (h) => registerFlowBridge(h, { adapter: rows() } as never),
  registerFormBridge: (h) => registerFormBridge(h, { adapter: rows() } as never),
  registerGitBridge: (h) => registerGitBridge(h, { adapter: rows() } as never),
  registerGraphBridge: (h) => registerGraphBridge(h, { adapter: rows() } as never),
  registerGridBridge: (h) => registerGridBridge(h, { adapter: rows() } as never),
  registerMapBridge: (h) => registerMapBridge(h, { adapter: rows() } as never),
  registerNavigationBridge: (h) => registerNavigationBridge(h, { adapter: rows() } as never),
  registerPasskeyBridge: (h) => registerPasskeyBridge(h, { adapter: rows() } as never),
  registerSceneBridge: (h) => registerSceneBridge(h, { adapter: rows() } as never),
  registerScreenDocBridge: (h) => registerScreenDocBridge(h, { adapter: rows() } as never),
  registerScreensBridge: (h) =>
    registerScreensBridge(h, { adapter: rows({ listKinds: () => [{ kind: "page", label: "Page" }] }) } as never),
  registerSheetsBridge: (h) => registerSheetsBridge(h, { adapter: rows() } as never),
  registerSignBridge: (h) => registerSignBridge(h, { adapter: rows() } as never),
  registerSlidesBridge: (h) => registerSlidesBridge(h, { adapter: rows() } as never),
  registerTemplateBridge: (h) => registerTemplateBridge(h, { adapter: rows(), core: rows() } as never),
  registerTerminalBridge: (h) => registerTerminalBridge(h, { adapter: rows() } as never),
  registerTuiBridge: (h) =>
    registerTuiBridge(h, { registry: rows(), eventStore: rows(), appId: "shape" } as never),
  registerWhiteboardBridge: (h) => registerWhiteboardBridge(h, { adapter: rows() } as never),
};

/** The ten list tools that used to return a bare array, and the key each now uses. */
const LIST_TOOLS: Record<string, string> = {
  screens_list_kinds: "kinds",
  slide_list: "slides",
  catalog_list_products: "products",
  catalog_list_prices: "prices",
  artboard_list_pieces: "sections",
  flow_list_nodes: "nodes",
  flow_list_node_kinds: "kinds",
  flow_list_edges: "edges",
  whiteboard_list_items: "items",
  tui_surfaces_list: "surfaces",
};

/** What the client receives: the value after a JSON round trip. */
function onTheWire(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
}

function isJsonObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Call every tool every bridge registers, with empty arguments, and keep each wire-shaped `structuredContent`. */
async function sweep(): Promise<Map<string, unknown>> {
  const seen = new Map<string, unknown>();
  for (const [bridge, register] of Object.entries(BRIDGES)) {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    made = 0;
    register(host);
    for (const { name } of host.listTools()) {
      let result: CallToolResult;
      made = 0;
      try {
        result = await host.callTool(name, {});
      } catch {
        continue; // a refusal carries no structured content
      }
      if (result?.structuredContent === undefined) continue;
      const wire = onTheWire(result.structuredContent);
      if (wire === undefined) continue;
      seen.set(`${bridge}:${name}`, wire);
    }
  }
  return seen;
}

let swept: Promise<Map<string, unknown>> | null = null;
/** The sweep is expensive and deterministic, so the three assertions share one run. */
const sweepOnce = () => (swept ??= sweep());

describe("structuredContent is a JSON object on every bridge", () => {
  beforeEach(() => resetAllUndoStacks());

  it("covers every bridge entry point in src/bridges", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const declared = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) => [...readFileSync(join(dir, f), "utf8").matchAll(/^export function (register\w+Bridge)\b/gm)].map((m) => m[1]))
      // The generic doc bridge is reached through cms + screen-doc, which fix its surface.
      .filter((name) => name !== "registerDocBridge")
      .sort();
    expect(Object.keys(BRIDGES).sort()).toEqual(declared);
  });

  it("no tool returns an array, or any non-object, as structuredContent", async () => {
    const seen = await sweepOnce();
    const offenders = [...seen]
      .filter(([, wire]) => !isJsonObject(wire))
      .map(([tool, wire]) => `${tool} -> ${Array.isArray(wire) ? "array" : wire === null ? "null" : typeof wire}`);
    expect(offenders).toEqual([]);
  });

  it("reaches agent_history, the shared undo tool, as { history }", async () => {
    const seen = await sweepOnce();
    const shapes = [...seen].filter(([k]) => k.split(":")[1] === "agent_history").map(([, wire]) => wire);
    expect(shapes.length, "agent_history was not reached").toBeGreaterThan(0);
    for (const wire of shapes) {
      expect(isJsonObject(wire)).toBe(true);
      expect(Object.keys(wire as object)).toEqual(["history"]);
      expect(Array.isArray((wire as { history: unknown }).history)).toBe(true);
    }
  });

  it("the sweep reaches each of the ten list tools, so the check above is not vacuous", async () => {
    const seen = await sweepOnce();
    const reached = new Set([...seen.keys()].map((k) => k.split(":")[1]));
    const missed = Object.keys(LIST_TOOLS).filter((tool) => !reached.has(tool));
    expect(missed).toEqual([]);
  });

  it("each list tool wraps its rows under its named key, as an array", async () => {
    const seen = await sweepOnce();
    const byTool = new Map([...seen].map(([k, v]) => [k.split(":")[1], v]));
    const wrong = Object.entries(LIST_TOOLS)
      .filter(([tool, key]) => {
        const wire = byTool.get(tool) as Record<string, unknown> | undefined;
        return !isJsonObject(wire) || Object.keys(wire!).join(",") !== key || !Array.isArray(wire![key]);
      })
      .map(([tool, key]) => `${tool} should be { ${key}: [...] }`);
    expect(wrong).toEqual([]);
  });
});

describe("agent_history wraps its rows as { history }", () => {
  beforeEach(() => resetAllUndoStacks());

  it("returns the same rows under history, with the text content unchanged", async () => {
    const host = new ToolRegistry();
    registerUndoTools(host);
    const noop = () => {};
    pushUndoEntry("agent", { timestamp: 0, bridgeId: "whiteboard", action: "add", label: "Added n1", undo: noop, redo: noop });
    pushUndoEntry("agent", { timestamp: 1000, bridgeId: "grid", action: "paint", label: "Painted A1", undo: noop, redo: noop });
    const r = await host.callTool("agent_history", {});
    expect(r.structuredContent).toEqual({
      history: [
        { timestamp: 0, bridgeId: "whiteboard", action: "add", label: "Added n1" },
        { timestamp: 1000, bridgeId: "grid", action: "paint", label: "Painted A1" },
      ],
    });
    expect(r.content?.[0]).toEqual({
      type: "text",
      text: ["1970-01-01T00:00:00.000Z whiteboard add: Added n1", "1970-01-01T00:00:01.000Z grid paint: Painted A1"].join("\n"),
    });
  });

  it("an empty stack is { history: [] } and the text is (empty)", async () => {
    const host = new ToolRegistry();
    registerUndoTools(host);
    const r = await host.callTool("agent_history", {});
    expect(r.structuredContent).toEqual({ history: [] });
    expect(r.content?.[0]).toEqual({ type: "text", text: "(empty)" });
  });
});

describe("git bridge guard: an adapter that returns an array", () => {
  const ARRAY_TOOLS = ["git_status", "git_log", "git_diff", "git_reviews_list", "git_checks"];

  it("wraps an array read result as { items } instead of sending it as-is", async () => {
    const list = [{ sha: "a1" }, { sha: "b2" }];
    const host = new ToolRegistry();
    registerGitBridge(host, {
      adapter: {
        status: async () => list,
        log: async () => list,
        diff: async () => list,
        reviews: async () => list,
        checks: async () => list,
        propose: async () => ({ summary: "s" }),
      },
    } as never);
    for (const tool of ARRAY_TOOLS) {
      const r = await host.callTool(tool, { revision: "HEAD" });
      expect(r.structuredContent, tool).toEqual({ items: list });
      // The text a reader sees is unchanged: the adapter's own value, as JSON.
      expect(r.content?.[0], tool).toEqual({ type: "text", text: JSON.stringify(list, null, 2) });
    }
  });

  it("wraps an array apply result as { items }", async () => {
    const host = new ToolRegistry();
    registerGitBridge(host, {
      allowApply: true,
      adapter: {
        status: async () => ({}),
        log: async () => ({}),
        diff: async () => ({}),
        propose: async () => ({ summary: "stage a" }),
        applyProposal: async () => [{ path: "a" }],
      },
    } as never);
    const r = await host.callTool("git_stage", { paths: ["a"], apply: true });
    expect(r.structuredContent).toEqual({ items: [{ path: "a" }] });
  });

  it("passes an object result through unchanged", async () => {
    const status = { branch: "main", clean: true };
    const host = new ToolRegistry();
    registerGitBridge(host, {
      adapter: { status: async () => status, log: async () => ({}), diff: async () => ({}), propose: async () => ({ summary: "s" }) },
    } as never);
    const r = await host.callTool("git_status", {});
    expect(r.structuredContent).toEqual(status);
  });
});
