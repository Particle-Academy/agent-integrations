import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import type { JsonObject } from "../../mcp/types";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import type { DocTree, StyledNode } from "@particle-academy/fancy-doc-commons";
import { registerDocBridge } from "../doc";
import { registerCmsBridge } from "../cms";
import { registerTemplateBridge } from "../template";
import * as templateCore from "@particle-academy/fancy-template-ui/core";
import { registerScreenDocBridge, type ScreenDocNode } from "../screen-doc";
import { registerTuiBridge } from "../tui";
import { MemoryHumanPlusEventStore } from "../../human-plus/events";
import { registerTerminalBridge } from "../terminal";
import { registerCatalogBridge, type CatalogBridgeAdapter, type CatalogProduct, type CatalogPrice } from "../catalog";
import { registerFeaturesBridge, type FeaturesBridgeAdapter } from "../features";
import { registerFilesBridge, type FilesBridgeAdapter } from "../files";
import { registerContentReactionBridge, type ContentReactionBridgeAdapter } from "../content-reaction";

/**
 * `confirmBy` (owner ruling 2026-11-18, q_b83ac35f: "human-only default").
 *
 * The Human+ contract is "agents propose, humans confirm". Every bridge below
 * stages writes, and before this change every one of them let the SAME agent
 * that staged a write also say yes to it: a `<surface>_confirm` tool, a
 * `tui_action_confirm` tool, or a `confirm: true` argument honoured whenever
 * the host wired no confirm hook. pendingMode meant nothing.
 *
 * Now the default is `confirmBy: "human"`: no agent-callable path confirms
 * anything, and confirmation happens only through the host (the returned
 * bridge's `confirm(id)`, or the host's `confirm` hook). `confirmBy: "agent"`
 * restores the old behaviour, as an explicit opt-in.
 */

/** Any tool name that reads as an agent saying yes. */
const SELF_CONFIRM = /confirm|accept|approve|apply_pending|apply_staged/i;

/** Tools that are not the bridge's own (registered by every undo-aware bridge). */
const UNDO = new Set(["agent_undo", "agent_redo", "agent_history"]);

const names = (host: ToolRegistry) => host.listTools().map((t) => t.name);
const own = (host: ToolRegistry) => names(host).filter((n) => !UNDO.has(n)).sort();

/**
 * Call EVERY registered tool with every argument an agent might use to say
 * yes: the pending id under every key, `confirm: true`, `apply: true`, plus
 * the args that staged the write in the first place. The caller then asserts
 * nothing was applied.
 */
async function sweep(host: ToolRegistry, extra: JsonObject) {
  for (const name of names(host)) {
    await host.callTool(name, { ...extra, confirm: true, apply: true, approve: true, accept: true });
  }
}

beforeEach(() => resetAllUndoStacks());

// ─── registerDocBridge and the two bridges built on it ─────────────────────

function docSetup(confirmBy?: "human" | "agent") {
  let tree: DocTree<StyledNode> = { nodes: {} };
  const host = new ToolRegistry();
  const bridge = registerDocBridge<StyledNode>(host, {
    adapter: { get: () => tree, set: (n) => { tree = n; } },
    surface: "tpl",
    makeNode: ({ id, type, parent, order }, props) => ({ id, type, parent, order, props, style: { base: {} } }),
    stagePolicy: () => "confirm",
    ...(confirmBy ? { confirmBy } : {}),
  });
  return { host, bridge, tree: () => tree };
}

describe("registerDocBridge — confirmBy", () => {
  it("default: the closed tool list has no confirm tool", () => {
    const { host } = docSetup();
    expect(own(host)).toEqual(
      ["tpl_add", "tpl_describe", "tpl_get", "tpl_get_node", "tpl_list", "tpl_move", "tpl_reject", "tpl_remove", "tpl_update"],
    );
    expect(names(host).filter((n) => SELF_CONFIRM.test(n))).toEqual([]);
  });

  it("default: no tool, called with anything, applies a staged op", async () => {
    const { host, tree } = docSetup();
    const staged = (await host.callTool("tpl_add", { type: "box" })).structuredContent as Record<string, unknown>;
    expect(staged.staged).toBe(true);
    const pendingId = staged.pendingId as string;

    await sweep(host, { id: pendingId, pendingId, type: "box" });

    expect(Object.keys(tree().nodes)).toEqual([]);
  });

  it("default: the host confirms through the returned bridge", async () => {
    const { host, bridge, tree } = docSetup();
    const staged = (await host.callTool("tpl_add", { type: "box", id: "b1" })).structuredContent as Record<string, unknown>;
    expect(bridge.pending().map((p) => p.id)).toEqual([staged.pendingId]);

    expect(bridge.confirm(staged.pendingId as string)).toBe(true);
    expect(tree().nodes.b1?.type).toBe("box");
    expect(bridge.pending()).toEqual([]);
    expect(bridge.confirm(staged.pendingId as string)).toBe(false);

    // The applied op is undoable like any other.
    await host.callTool("agent_undo", {});
    expect(tree().nodes.b1).toBeUndefined();
  });

  it("default: the host rejects through the returned bridge", async () => {
    const { host, bridge, tree } = docSetup();
    const staged = (await host.callTool("tpl_add", { type: "box" })).structuredContent as Record<string, unknown>;
    expect(bridge.reject(staged.pendingId as string)).toBe(true);
    expect(bridge.confirm(staged.pendingId as string)).toBe(false);
    expect(Object.keys(tree().nodes)).toEqual([]);
  });

  it("confirmBy: 'agent' restores the agent-callable confirm tool", async () => {
    const { host, tree } = docSetup("agent");
    expect(names(host)).toContain("tpl_confirm");
    const staged = (await host.callTool("tpl_add", { type: "box" })).structuredContent as Record<string, unknown>;
    await host.callTool("tpl_confirm", { id: staged.pendingId as string });
    expect(Object.keys(tree().nodes)).toHaveLength(1);
  });
});

describe("registerCmsBridge — confirmBy", () => {
  function setup(confirmBy?: "human" | "agent") {
    let tree: DocTree<StyledNode> = { nodes: {} };
    const host = new ToolRegistry();
    const bridge = registerCmsBridge(host, {
      adapter: { get: () => tree, set: (n) => { tree = n; } },
      stagePolicy: () => "confirm",
      ...(confirmBy ? { confirmBy } : {}),
    });
    return { host, bridge, tree: () => tree };
  }

  it("default: no cms_confirm, and nothing an agent calls applies a staged op", async () => {
    const { host, tree } = setup();
    expect(names(host)).not.toContain("cms_confirm");
    expect(names(host).filter((n) => SELF_CONFIRM.test(n))).toEqual([]);

    const staged = (await host.callTool("cms_add", { type: "box" })).structuredContent as Record<string, unknown>;
    await sweep(host, { id: staged.pendingId as string, type: "box", patch: { color: "#f00" } });
    expect(Object.keys(tree().nodes)).toEqual([]);
  });

  it("default: the host confirms it", async () => {
    const { host, bridge, tree } = setup();
    const staged = (await host.callTool("cms_add", { type: "box" })).structuredContent as Record<string, unknown>;
    bridge.confirm(staged.pendingId as string);
    expect(Object.keys(tree().nodes)).toHaveLength(1);
  });

  it("confirmBy: 'agent' restores cms_confirm", () => {
    expect(names(setup("agent").host)).toContain("cms_confirm");
  });
});

describe("registerTemplateBridge — always human, no opt-in", () => {
  function setup() {
    let state = templateCore.emptyState();
    const host = new ToolRegistry();
    const bridge = registerTemplateBridge(host, {
      core: templateCore,
      // An extra `confirmBy` is not part of the options and must change nothing.
      ...({ confirmBy: "agent" } as object),
      adapter: { get: () => state, set: (n) => { state = n; }, context: () => ({ kinds: [], fields: [], lists: [] }) },
    });
    return { host, bridge, state: () => state };
  }

  it("no tpl_confirm even when asked for one, and nothing an agent calls applies a staged op", async () => {
    const { host, state } = setup();
    expect(names(host).filter((n) => SELF_CONFIRM.test(n))).toEqual([]);
    const staged = (await host.callTool("tpl_add", { type: "pageBreak" })).structuredContent as Record<string, unknown>;
    expect(staged.staged).toBe(true);
    await sweep(host, { id: staged.pendingId as string, type: "pageBreak", patch: { size: "a4" } });
    expect(Object.keys(state().tree.nodes)).toEqual([]);
  });

  it("the host confirms it", async () => {
    const { host, bridge, state } = setup();
    const staged = (await host.callTool("tpl_add", { type: "pageBreak" })).structuredContent as Record<string, unknown>;
    expect(bridge.confirm(staged.pendingId as string)).toBe(true);
    expect(Object.keys(state().tree.nodes)).toHaveLength(1);
  });
});

describe("registerScreenDocBridge — confirmBy", () => {
  function tree0(): DocTree<ScreenDocNode> {
    return {
      nodes: {
        ":root": { id: ":root", type: "Card", parent: null, order: "a0", props: {}, synthetic: true },
        title: { id: "title", type: "Heading", parent: ":root", order: "a0", props: {} },
      },
    };
  }
  function setup(confirmBy?: "human" | "agent") {
    let tree = tree0();
    const host = new ToolRegistry();
    const bridge = registerScreenDocBridge(host, {
      adapter: { get: () => tree, set: (n) => { tree = n; } },
      stagePolicy: () => "confirm",
      ...(confirmBy ? { confirmBy } : {}),
    });
    return { host, bridge, tree: () => tree };
  }

  it("default: no screen_confirm, and nothing an agent calls applies a staged remove", async () => {
    const { host, tree } = setup();
    expect(names(host)).not.toContain("screen_confirm");
    expect(names(host).filter((n) => SELF_CONFIRM.test(n))).toEqual([]);

    const staged = (await host.callTool("screen_remove", { id: "title" })).structuredContent as Record<string, unknown>;
    expect(staged.staged).toBe(true);
    await sweep(host, { id: staged.pendingId as string });
    expect(tree().nodes.title).toBeDefined();
  });

  it("default: the host confirms it", async () => {
    const { host, bridge, tree } = setup();
    const staged = (await host.callTool("screen_remove", { id: "title" })).structuredContent as Record<string, unknown>;
    bridge.confirm(staged.pendingId as string);
    expect(tree().nodes.title).toBeUndefined();
  });

  it("confirmBy: 'agent' restores screen_confirm", () => {
    expect(names(setup("agent").host)).toContain("screen_confirm");
  });
});

// ─── registerTuiBridge ──────────────────────────────────────────────────────

describe("registerTuiBridge — confirmBy", () => {
  function setup(confirmBy?: "human" | "agent") {
    const calls: unknown[] = [];
    const command = { name: "delete", policy: "confirm" as const, invoke: (input?: Record<string, unknown>) => { calls.push(input); } };
    const surface = { id: "row", kind: "button", read: () => ({}), commands: [command] };
    const store = new MemoryHumanPlusEventStore();
    const host = new ToolRegistry();
    const bridge = registerTuiBridge(host, {
      registry: { list: () => [surface], get: (id) => (id === "row" ? surface : undefined) },
      eventStore: store,
      appId: "test",
      ...(confirmBy ? { confirmBy } : {}),
    });
    return { host, bridge, calls, store };
  }

  it("default: the closed tool list has no confirm tool", () => {
    expect(own(setup().host)).toEqual([
      "human_plus_events_ack",
      "human_plus_events_list",
      "human_plus_events_subscribe",
      "tui_action_invoke",
      "tui_action_reject",
      "tui_surface_read",
      "tui_surfaces_list",
    ]);
  });

  it("default: no tool, called with anything, executes a proposed action", async () => {
    const { host, bridge, calls } = setup();
    await host.callTool("tui_action_invoke", { surfaceId: "row", command: "delete" });
    const id = bridge.pending()[0]!.id;
    await sweep(host, { id, surfaceId: "row", command: "delete", consumerId: "agent", eventIds: [] });
    expect(calls).toEqual([]);
  });

  it("default: the host confirms it, and the event is the human's", async () => {
    const { host, bridge, calls, store } = setup();
    await host.callTool("tui_action_invoke", { surfaceId: "row", command: "delete", input: { n: 1 } });
    const id = bridge.pending()[0]!.id;
    await bridge.confirm(id);
    expect(calls).toEqual([{ n: 1 }]);
    const events = (await store.list({ consumerId: "x" })).events;
    expect(events.at(-1)).toMatchObject({ type: "action.confirmed", actor: { kind: "human" } });
  });

  it("an agent withdrawing its own proposal is recorded as the agent, not the human", async () => {
    const { host, bridge, store } = setup();
    await host.callTool("tui_action_invoke", { surfaceId: "row", command: "delete" });
    await host.callTool("tui_action_reject", { id: bridge.pending()[0]!.id });
    const events = (await store.list({ consumerId: "x" })).events;
    expect(events.at(-1)).toMatchObject({ type: "action.rejected", actor: { kind: "agent" } });
  });

  it("confirmBy: 'agent' restores tui_action_confirm", async () => {
    const { host, bridge, calls } = setup("agent");
    await host.callTool("tui_action_invoke", { surfaceId: "row", command: "delete" });
    await host.callTool("tui_action_confirm", { id: bridge.pending()[0]!.id });
    expect(calls).toHaveLength(1);
  });
});

// ─── registerTerminalBridge (already human-only; confirmBy is the shared name) ─

describe("registerTerminalBridge — confirmBy", () => {
  const adapter = () => ({ getBuffer: () => "$ ", write: vi.fn(), runCommand: vi.fn() });

  it("confirmBy: 'agent' exposes terminal_confirm, the same opt-in as allowAgentConfirm", () => {
    const host = new ToolRegistry();
    registerTerminalBridge(host, { adapter: adapter(), confirmBy: "agent" });
    expect(names(host)).toContain("terminal_confirm");
  });

  it("confirmBy: 'human' wins over the deprecated allowAgentConfirm", () => {
    const host = new ToolRegistry();
    registerTerminalBridge(host, { adapter: adapter(), allowAgentConfirm: true, confirmBy: "human" });
    expect(names(host)).not.toContain("terminal_confirm");
  });
});

// ─── The `confirm: true` argument bridges ──────────────────────────────────

function catalogAdapter() {
  const products = new Map<string, CatalogProduct & { deletedAt?: unknown }>();
  const prices = new Map<string, CatalogPrice & { deletedAt?: unknown }>();
  const adapter: CatalogBridgeAdapter = {
    id: "c",
    products: {
      find: (id) => products.get(id) ?? null,
      all: () => [...products.values()],
      remove: (id) => { const p = products.get(id); if (p) p.deletedAt = new Date(); },
    },
    prices: {
      find: (id) => prices.get(id) ?? null,
      forProduct: () => [],
      all: () => [...prices.values()],
      remove: (id) => { const p = prices.get(id); if (p) p.deletedAt = new Date(); },
    },
    createProduct: (input) => { const p = { active: true, ...input, id: "p1" } as CatalogProduct; products.set(p.id, p); return p; },
    createPrice: (input) => { const p = { active: true, ...input, id: "r1" } as CatalogPrice; prices.set(p.id, p); return p; },
  };
  products.set("p1", { id: "p1", name: "Doomed", active: true } as CatalogProduct);
  prices.set("r1", { id: "r1", productId: "p1", active: true } as unknown as CatalogPrice);
  return { adapter, products, prices };
}

function featuresAdapter() {
  const assignments = new Set<string>();
  const adapter: FeaturesBridgeAdapter = {
    id: "f",
    canAccess: () => false,
    remaining: () => null,
    enabled: () => [],
    registerFeature: () => undefined,
    registryKeys: () => [],
    definition: () => null,
    assignGroup: (_s, g) => { assignments.add(g); },
    detachGroup: (_s, g) => { assignments.delete(g); },
    listGroups: () => [...assignments],
  };
  return { adapter, assignments };
}

function filesAdapter(createFolder: FilesBridgeAdapter["createFolder"]): FilesBridgeAdapter {
  return {
    getPath: () => "/root",
    setPath: () => undefined,
    getSelection: () => [],
    setSelection: () => undefined,
    getExpanded: () => [],
    setExpanded: () => undefined,
    listChildren: () => [],
    createFolder,
  };
}

function reactionAdapter() {
  const state = { value: [] as string[] };
  const adapter: ContentReactionBridgeAdapter = {
    id: "c1",
    getValue: () => state.value,
    setValue: (next) => { state.value = next; },
    getReactions: () => [{ key: "like", emoji: "+", label: "Like" }],
  };
  return { adapter, state };
}

const schemaProps = (host: ToolRegistry, name: string) =>
  Object.keys(((host.listTools().find((t) => t.name === name)?.inputSchema ?? {}) as { properties?: object }).properties ?? {});

describe("catalog — confirmBy", () => {
  it("default: confirm:true from the agent does not delete, and the schema does not offer it", async () => {
    const host = new ToolRegistry();
    const { adapter, products, prices } = catalogAdapter();
    registerCatalogBridge(host, { adapter });

    expect(schemaProps(host, "catalog_delete_product")).not.toContain("confirm");
    expect(schemaProps(host, "catalog_delete_price")).not.toContain("confirm");

    const r = await host.callTool("catalog_delete_product", { id: "p1", confirm: true });
    expect(r.isError).toBe(true);
    await sweep(host, { id: "p1" });
    await sweep(host, { id: "r1" });
    expect(products.get("p1")?.deletedAt).toBeUndefined();
    expect(prices.get("r1")?.deletedAt).toBeUndefined();
  });

  it("default: the host confirm hook still decides", async () => {
    const host = new ToolRegistry();
    const { adapter, products } = catalogAdapter();
    registerCatalogBridge(host, { adapter, confirm: () => true });
    await host.callTool("catalog_delete_product", { id: "p1" });
    expect(products.get("p1")?.deletedAt).toBeInstanceOf(Date);
  });

  it("confirmBy: 'agent' restores confirm:true", async () => {
    const host = new ToolRegistry();
    const { adapter, products } = catalogAdapter();
    registerCatalogBridge(host, { adapter, confirmBy: "agent" });
    expect(schemaProps(host, "catalog_delete_product")).toContain("confirm");
    await host.callTool("catalog_delete_product", { id: "p1", confirm: true });
    expect(products.get("p1")?.deletedAt).toBeInstanceOf(Date);
  });
});

describe("features — confirmBy", () => {
  it("default: confirm:true from the agent does not grant, and the schema does not offer it", async () => {
    const host = new ToolRegistry();
    const { adapter, assignments } = featuresAdapter();
    registerFeaturesBridge(host, { adapter });

    expect(schemaProps(host, "features_grant")).not.toContain("confirm");
    expect(schemaProps(host, "features_revoke")).not.toContain("confirm");

    const r = await host.callTool("features_grant", { subject: "u", group: "pro", confirm: true });
    expect(r.isError).toBe(true);
    await sweep(host, { subject: "u", group: "pro", key: "pro" });
    expect([...assignments]).toEqual([]);
  });

  it("confirmBy: 'agent' restores confirm:true", async () => {
    const host = new ToolRegistry();
    const { adapter, assignments } = featuresAdapter();
    registerFeaturesBridge(host, { adapter, confirmBy: "agent" });
    await host.callTool("features_grant", { subject: "u", group: "pro", confirm: true });
    expect([...assignments]).toEqual(["pro"]);
  });
});

describe("files — confirmBy", () => {
  it("default: confirm:true from the agent does not create, and the schema does not offer it", async () => {
    const host = new ToolRegistry();
    const createFolder = vi.fn();
    registerFilesBridge(host, { adapter: filesAdapter(createFolder) });

    expect(schemaProps(host, "files_create_folder")).not.toContain("confirm");
    const r = await host.callTool("files_create_folder", { parentPath: "/root", name: "x", confirm: true });
    expect(r.isError).toBe(true);
    await sweep(host, { parentPath: "/root", name: "x", path: "/root" });
    expect(createFolder).not.toHaveBeenCalled();
  });

  it("confirmBy: 'agent' restores confirm:true", async () => {
    const host = new ToolRegistry();
    const createFolder = vi.fn();
    registerFilesBridge(host, { adapter: filesAdapter(createFolder), confirmBy: "agent" });
    await host.callTool("files_create_folder", { parentPath: "/root", name: "x", confirm: true });
    expect(createFolder).toHaveBeenCalled();
  });
});

describe("content-reaction — confirmBy", () => {
  it("default under pendingMode: confirm:true from the agent does not post the reaction", async () => {
    const host = new ToolRegistry();
    const { adapter, state } = reactionAdapter();
    registerContentReactionBridge(host, { adapter, pendingMode: true });
    const r = await host.callTool("reaction_toggle", { key: "like", confirm: true });
    expect(r.isError).toBe(true);
    await sweep(host, { key: "like", value: ["like"], content: "c1" });
    expect(state.value).toEqual([]);
  });

  it("confirmBy: 'agent' restores confirm:true", async () => {
    const host = new ToolRegistry();
    const { adapter, state } = reactionAdapter();
    registerContentReactionBridge(host, { adapter, pendingMode: true, confirmBy: "agent" });
    await host.callTool("reaction_toggle", { key: "like", confirm: true });
    expect(state.value).toEqual(["like"]);
  });
});
