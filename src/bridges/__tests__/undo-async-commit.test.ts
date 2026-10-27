import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerCatalogBridge, type CatalogBridgeAdapter, type CatalogProduct, type CatalogPrice } from "../catalog";
import { registerFeaturesBridge, type FeaturesBridgeAdapter } from "../features";
import { registerPasskeyBridge, type PasskeyBridgeAdapter, type PasskeySummaryLike } from "../passkeys";
import { registerNavigationBridge, type NavigationBridgeAdapter } from "../navigation";
import { resetAllUndoStacks } from "../../undo/undo-stack";

/**
 * agent_undo / agent_redo await the undo entry's step. A step that calls an
 * async host method must therefore hand back the host's promise: otherwise the
 * tool reports success before the host has committed, and a host refusal is
 * lost (or escapes as an unhandled rejection).
 *
 * A failed step follows what a SYNCHRONOUS throw has always done: the tool
 * call fails with the host's error, and the entry is dropped — it is neither
 * left on the undo stack nor moved to the redo stack.
 */

const flush = () => new Promise((r) => setTimeout(r, 0));
const text = (r: any) => r.content?.[0]?.text ?? "";

/**
 * Every mutating adapter method routes through the gate. "sync" commits
 * inline (the action phase); "defer" holds the commit until release(); "reject"
 * refuses it with a rejected promise; "throw" refuses it synchronously.
 */
class Gate {
  mode: "sync" | "defer" | "reject" | "throw" = "sync";
  private held: Array<() => void> = [];
  get pending(): number {
    return this.held.length;
  }
  commit<T>(fn: () => T): T | Promise<T> {
    if (this.mode === "sync") return fn();
    if (this.mode === "throw") throw new Error("host refused");
    if (this.mode === "reject") return Promise.reject(new Error("host refused"));
    return new Promise<T>((resolve) => {
      this.held.push(() => resolve(fn()));
    });
  }
  release(): void {
    const held = this.held;
    this.held = [];
    held.forEach((go) => go());
  }
}

type Case = {
  name: string;
  /** Build a host with the bridge registered, wired through `gate`. */
  setup(gate: Gate): ToolRegistry;
  /** Perform the undoable action (gate is in sync mode). */
  act(host: ToolRegistry): Promise<void>;
};

// ─── catalog ──────────────────────────────────────────────────────────────

function catalogHost(gate: Gate): ToolRegistry {
  const products = new Map<string, CatalogProduct & { deletedAt?: unknown }>();
  const prices = new Map<string, CatalogPrice & { deletedAt?: unknown }>();
  let seq = 0;
  const adapter: CatalogBridgeAdapter = {
    id: "undo-catalog",
    products: {
      find: (id) => products.get(id) ?? null,
      all: () => [...products.values()],
      remove: (id) => gate.commit(() => {
        const p = products.get(id);
        if (p) p.deletedAt = new Date();
      }),
    },
    prices: {
      find: (id) => prices.get(id) ?? null,
      forProduct: (productId) => [...prices.values()].filter((p) => p.productId === productId),
      all: () => [...prices.values()],
      remove: (id) => gate.commit(() => {
        const p = prices.get(id);
        if (p) p.deletedAt = new Date();
      }),
    },
    createProduct: (input) => gate.commit(() => {
      const product: CatalogProduct = { active: true, ...input, id: (input.id as string) ?? `p_${++seq}` };
      products.set(product.id, product);
      return product;
    }),
    createPrice: (input) => gate.commit(() => {
      const price: CatalogPrice = { active: true, ...input, id: (input.id as string) ?? `pr_${++seq}` };
      prices.set(price.id, price);
      return price;
    }),
  };
  const host = new ToolRegistry();
  registerCatalogBridge(host, { adapter });
  return host;
}

async function createProduct(host: ToolRegistry): Promise<string> {
  const r = await host.callTool("catalog_create_product", { name: "Pro" });
  return (r.structuredContent as { id: string }).id;
}

async function createPrice(host: ToolRegistry, productId: string): Promise<string> {
  const r = await host.callTool("catalog_create_price", {
    productId,
    currency: "USD",
    unitAmount: 1999,
    type: "one_time",
  });
  return (r.structuredContent as { id: string }).id;
}

/** Leaves only the action under test on the agent's undo stack. */
async function onlyOnStack(host: ToolRegistry, act: () => Promise<void>): Promise<void> {
  await act();
  const history = (await host.callTool("agent_history", {})).structuredContent as unknown[];
  expect(history).toHaveLength(1);
}

const cases: Case[] = [
  {
    name: "catalog_create_product",
    setup: catalogHost,
    act: async (host) => {
      await createProduct(host);
    },
  },
  {
    name: "catalog_create_price",
    setup: catalogHost,
    act: async (host) => {
      const productId = await createProduct(host);
      resetAllUndoStacks();
      await onlyOnStack(host, async () => {
        await createPrice(host, productId);
      });
    },
  },
  {
    name: "catalog_delete_product",
    setup: catalogHost,
    act: async (host) => {
      const id = await createProduct(host);
      resetAllUndoStacks();
      await onlyOnStack(host, async () => {
        await host.callTool("catalog_delete_product", { id, confirm: true });
      });
    },
  },
  {
    name: "catalog_delete_price",
    setup: catalogHost,
    act: async (host) => {
      const id = await createPrice(host, await createProduct(host));
      resetAllUndoStacks();
      await onlyOnStack(host, async () => {
        await host.callTool("catalog_delete_price", { id, confirm: true });
      });
    },
  },
];

// ─── features ─────────────────────────────────────────────────────────────

function featuresHost(gate: Gate): ToolRegistry {
  const assignments = new Map<string, Set<string>>();
  const groupsOf = (s: unknown) => assignments.get(String(s)) ?? new Set<string>();
  const adapter: FeaturesBridgeAdapter = {
    id: "undo-features",
    canAccess: () => false,
    remaining: () => null,
    enabled: () => [],
    registerFeature: () => {},
    registryKeys: () => [],
    definition: () => null,
    assignGroup: (subject, group) => gate.commit(() => {
      const set = groupsOf(subject);
      set.add(group);
      assignments.set(String(subject), set);
    }),
    detachGroup: (subject, group) => gate.commit(() => {
      groupsOf(subject).delete(group);
    }),
    listGroups: (subject) => [...groupsOf(subject)],
  };
  const host = new ToolRegistry();
  registerFeaturesBridge(host, { adapter });
  return host;
}

cases.push(
  {
    name: "features_grant",
    setup: featuresHost,
    act: async (host) => {
      await host.callTool("features_grant", { subject: "user-1", group: "pro", confirm: true });
    },
  },
  {
    name: "features_revoke",
    setup: featuresHost,
    act: async (host) => {
      await host.callTool("features_grant", { subject: "user-1", group: "pro", confirm: true });
      resetAllUndoStacks();
      await onlyOnStack(host, async () => {
        await host.callTool("features_revoke", { subject: "user-1", group: "pro", confirm: true });
      });
    },
  },
);

// ─── passkeys ─────────────────────────────────────────────────────────────

function passkeysHost(gate: Gate): ToolRegistry {
  const passkeys: PasskeySummaryLike[] = [
    {
      id: "cred-one",
      name: "MacBook",
      createdAt: "2026-03-04T09:12:00Z",
      lastUsedAt: null,
      transports: ["internal"],
      backedUp: true,
      aaguid: "adce0002-35bc-c60a-648b-0b25f1f05503",
      clonedAt: null,
    },
  ];
  const adapter: PasskeyBridgeAdapter = {
    id: "undo-passkeys",
    list: () => passkeys,
    rename: ({ id, name }) => gate.commit(() => {
      const record = passkeys.find((p) => p.id === id);
      if (record) record.name = name === "" ? null : name;
    }),
    proposeRevoke: () => ({ staged: true, isLastPasskey: false }),
    beginEnrollment: () => {},
    support: () => ({ supported: true, platformAuthenticator: true, conditionalUi: false }),
    state: () => ({ status: "idle", error: null, pendingRevoke: null, renamingId: null }),
  };
  const host = new ToolRegistry();
  registerPasskeyBridge(host, { adapter });
  return host;
}

cases.push({
  name: "passkey_rename",
  setup: passkeysHost,
  act: async (host) => {
    await host.callTool("passkey_rename", { id: "cred-one", name: "Work laptop" });
  },
});

// ─── navigation ───────────────────────────────────────────────────────────

function navigationHost(gate: Gate): ToolRegistry {
  const state = { url: "/" };
  const adapter: NavigationBridgeAdapter = {
    getLocation: () => ({ url: state.url, title: "Page" }),
    describe: () => ({ url: state.url, title: "Page", actions: [] }),
    read: () => "",
    visit: (url) => gate.commit(() => {
      state.url = url;
    }),
    back: () => {},
    forward: () => {},
    scrollTo: () => {},
    scrollBy: () => {},
    setField: () => ({ ok: true }),
    click: () => ({ ok: true }),
    submit: () => ({ ok: true }),
  };
  const host = new ToolRegistry();
  registerNavigationBridge(host, { adapter });
  return host;
}

cases.push({
  name: "nav_visit",
  setup: navigationHost,
  act: async (host) => {
    await host.callTool("nav_visit", { url: "/packages" });
  },
});

// ─── the contract ─────────────────────────────────────────────────────────

async function history(host: ToolRegistry): Promise<unknown[]> {
  return (await host.callTool("agent_history", {})).structuredContent as unknown[];
}

describe.each(cases)("$name undo/redo against an async host", (c) => {
  let gate: Gate;
  let host: ToolRegistry;

  beforeEach(async () => {
    resetAllUndoStacks();
    gate = new Gate();
    host = c.setup(gate);
    await c.act(host);
    expect(await history(host)).toHaveLength(1);
  });

  it("agent_undo does not resolve until the host commits", async () => {
    gate.mode = "defer";
    let settled = false;
    const undo = host.callTool("agent_undo", {}).finally(() => { settled = true; });
    await flush();
    expect(gate.pending).toBe(1);
    expect(settled).toBe(false);

    gate.release();
    const result = await undo;
    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatch(/^Undid: /);
    expect(await history(host)).toHaveLength(0);
  });

  it("agent_redo does not resolve until the host commits", async () => {
    await host.callTool("agent_undo", {});
    gate.mode = "defer";
    let settled = false;
    const redo = host.callTool("agent_redo", {}).finally(() => { settled = true; });
    await flush();
    expect(gate.pending).toBe(1);
    expect(settled).toBe(false);

    gate.release();
    const result = await redo;
    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatch(/^Redid: /);
    expect(await history(host)).toHaveLength(1);
  });

  it("a rejected undo commit fails agent_undo and drops the entry, as a sync throw does", async () => {
    gate.mode = "reject";
    await expect(host.callTool("agent_undo", {})).rejects.toThrow("host refused");
    expect(await history(host)).toHaveLength(0);
    const redo = await host.callTool("agent_redo", {});
    expect(redo.isError).toBe(true);
    expect(text(redo)).toBe("Nothing to redo.");
  });

  it("a rejected redo commit fails agent_redo and drops the entry, as a sync throw does", async () => {
    await host.callTool("agent_undo", {});
    gate.mode = "reject";
    await expect(host.callTool("agent_redo", {})).rejects.toThrow("host refused");
    expect(await history(host)).toHaveLength(0);
    const again = await host.callTool("agent_redo", {});
    expect(text(again)).toBe("Nothing to redo.");
  });

  it("baseline: a synchronous throw fails agent_undo and drops the entry", async () => {
    gate.mode = "throw";
    await expect(host.callTool("agent_undo", {})).rejects.toThrow("host refused");
    expect(await history(host)).toHaveLength(0);
    expect(text(await host.callTool("agent_redo", {}))).toBe("Nothing to redo.");
  });
});
