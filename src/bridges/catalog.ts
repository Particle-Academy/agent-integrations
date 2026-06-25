import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import type { AgentTarget } from "../presence/types";
import { pushUndoEntry } from "../undo/undo-stack";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";

/**
 * Headless bridge for `@particle-academy/fancy-catalog` — a Stripe catalog with
 * NO UI surface. The adapter exposes the catalog's STORES + operations (not UI
 * getters/setters), and the tools are CRUD over products / prices + checkout +
 * Stripe sync. Mutations still funnel through `wrapToolWithActivity` so presence
 * + undo compose, and the destructive delete is `pendingMode`-gated.
 *
 * The adapter shapes below are STRUCTURAL mirrors of fancy-catalog's public
 * `Catalog` + store interfaces, defined LOCALLY so this bridge builds with the
 * sibling package absent (it's an optional peer). A real `Catalog` instance is
 * assignable to `CatalogBridgeAdapter` with no import — TypeScript is structural.
 */

/** Minimal product shape crossing the MCP wire (mirror of fancy-catalog `Product`). */
export type CatalogProduct = {
  id: string;
  name: string;
  description?: string | null;
  active?: boolean;
  lookupKey?: string | null;
  externalId?: string | null;
  metadata?: Record<string, unknown> | null;
  [k: string]: unknown;
};

/** Minimal price shape crossing the MCP wire (mirror of fancy-catalog `Price`). */
export type CatalogPrice = {
  id: string;
  productId: string;
  active?: boolean;
  currency: string;
  unitAmount: number;
  type: "recurring" | "one_time";
  externalId?: string | null;
  [k: string]: unknown;
};

/** Common checkout args (mirror of fancy-catalog `CheckoutArgs`). */
export type CatalogCheckoutArgs = {
  customer?: string;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
  /** One-time checkouts only. */
  quantity?: number;
};

/**
 * Adapter = the catalog instance / stores. A live `Catalog` from fancy-catalog
 * satisfies this directly (`catalog.products`, `catalog.createProduct`, …); a
 * host can also hand-roll one over its own persistence.
 */
export type CatalogBridgeAdapter = {
  /** Stable id for this catalog instance (multiple catalogs ⇒ distinct ids). */
  id?: string;
  /** Display label for logs / presence. */
  title?: string;
  /** Optional fancy-screens screen id (usually unset — this is headless). */
  screenId?: string;

  /** Product store — `catalog.products`. */
  products: {
    find(id: string, opts?: { withTrashed?: boolean }): CatalogProduct | null | Promise<CatalogProduct | null>;
    all(opts?: { withTrashed?: boolean }): CatalogProduct[] | Promise<CatalogProduct[]>;
    remove(id: string): void | Promise<void>;
  };
  /** Price store — `catalog.prices`. */
  prices: {
    find(id: string, opts?: { withTrashed?: boolean }): CatalogPrice | null | Promise<CatalogPrice | null>;
    forProduct(productId: string, opts?: { withTrashed?: boolean }): CatalogPrice[] | Promise<CatalogPrice[]>;
    all(opts?: { withTrashed?: boolean }): CatalogPrice[] | Promise<CatalogPrice[]>;
    remove(id: string): void | Promise<void>;
  };

  /** Authoring helpers — `catalog.createProduct` / `catalog.createPrice` (ULIDs auto-assigned). */
  createProduct(input: Partial<CatalogProduct> & { name: string }): Promise<CatalogProduct> | CatalogProduct;
  createPrice(
    input: Partial<CatalogPrice> & { productId: string; currency: string; unitAmount: number; type: "recurring" | "one_time" },
  ): Promise<CatalogPrice> | CatalogPrice;

  /** Stripe sync — `catalog.syncProductAndPrices`. Optional (no-op when absent). */
  syncProductAndPrices?(product: CatalogProduct): Promise<CatalogProduct> | CatalogProduct;
  /** Connection test — `catalog.testConnection`. Optional. */
  testConnection?(): Promise<{ success: boolean; message: string; productCount?: number }> | { success: boolean; message: string; productCount?: number };

  /** Hosted Checkout — `catalog.getSubscriptionCheckoutUrl` / `getOneTimeCheckoutUrl`. Optional. */
  getSubscriptionCheckoutUrl?(price: CatalogPrice, args: CatalogCheckoutArgs): Promise<string> | string;
  getOneTimeCheckoutUrl?(price: CatalogPrice, args: CatalogCheckoutArgs): Promise<string> | string;
};

export type CatalogBridgeOptions = {
  adapter: CatalogBridgeAdapter;
  /** Identity stamped on activity + undo entries. */
  agent?: { id: string; name?: string; color?: string };
  /**
   * Trust-but-verify. When on (default), destructive ops (`catalog_delete_product`,
   * `catalog_delete_price`) route through `adapter`-less staging: they require an
   * explicit `confirm: true` arg OR a host `confirm` callback. Read + create +
   * checkout-url tools are unaffected.
   */
  pendingMode?: boolean;
  /** Host confirm hook for destructive ops (pendingMode). Resolves true to proceed. */
  confirm?: (req: { action: string; id: string; label: string }) => Promise<boolean> | boolean;
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/**
 * registerCatalogBridge — full MCP tool set over a headless Stripe catalog.
 *
 *   catalog_list_products    list products ({ id, name, active, priceCount })
 *   catalog_get_product      full product JSON + its prices
 *   catalog_create_product   create a product (ULID auto-assigned)
 *   catalog_delete_product   soft-delete a product (pendingMode-gated, undoable*)
 *   catalog_list_prices      list a product's prices (or all)
 *   catalog_create_price     create a price under a product
 *   catalog_delete_price     soft-delete a price (pendingMode-gated)
 *   catalog_sync_product     push a product + its prices to Stripe
 *   catalog_test_connection  verify the Stripe connection
 *   catalog_create_checkout  build a hosted Checkout URL for a price
 *
 * *delete undo is best-effort: stores expose soft-delete (`remove`) but no
 *  un-delete, so the undo closure re-creates from the captured snapshot.
 */
export function registerCatalogBridge(host: ToolHost, options: CatalogBridgeOptions): Bridge {
  const { adapter } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const pendingMode = options.pendingMode ?? true;
  const catalogId = adapter.id ?? "catalog";
  const disposers: Array<() => void> = [];

  ensureUndoToolsRegistered(host, { defaultAgentId: agent.id });

  const target = (elementId?: string, label?: string): AgentTarget => ({
    kind: "custom",
    screenId: adapter.screenId,
    elementId,
    label: label ?? catalogId,
  });

  const reg = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: JsonObject) => Promise<unknown> | unknown,
    resolveTarget: false | ((args: JsonObject) => AgentTarget),
  ) => {
    const wrapped = async (args: JsonObject) => {
      try {
        return await handler(args);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    };
    const final = resolveTarget
      ? wrapToolWithActivity(wrapped as never, {
          toolName: name,
          agent,
          kind: "custom",
          screenId: adapter.screenId,
          resolveTarget: ({ args }) => resolveTarget(args as JsonObject),
        })
      : wrapped;
    disposers.push(
      host.registerTool(
        { name, description, inputSchema: { type: "object", properties: properties as Record<string, never>, required, additionalProperties: false } },
        final as never,
      ),
    );
  };

  /** Stage a destructive op behind the human (pendingMode). Returns null to proceed, or an errorResult to block. */
  const guardDestructive = async (action: string, id: string, label: string, hasConfirmArg: boolean) => {
    if (!pendingMode) return null;
    if (options.confirm) {
      const ok = await options.confirm({ action, id, label });
      return ok ? null : errorResult(`Declined: ${action} ${id} (human did not confirm).`);
    }
    // No host confirm hook → require an explicit confirm:true arg as the staged ack.
    if (!hasConfirmArg) {
      return errorResult(`${action} is staged (pendingMode). Re-call with confirm:true to apply, or wire a host confirm hook.`);
    }
    return null;
  };

  // ─── Read tools ──────────────────────────────────────────────────────────

  reg(
    "catalog_list_products",
    "List products: { id, name, active, lookupKey, priceCount }. Pass withTrashed:true to include soft-deleted.",
    { withTrashed: { type: "boolean" } },
    [],
    async (args) => {
      const products = await adapter.products.all({ withTrashed: args.withTrashed === true });
      const list = await Promise.all(
        products.map(async (p) => ({
          id: p.id,
          name: p.name,
          active: p.active ?? true,
          lookupKey: p.lookupKey ?? null,
          priceCount: (await adapter.prices.forProduct(p.id)).length,
        })),
      );
      return textResult(JSON.stringify(list, null, 2), list);
    },
    false,
  );

  reg(
    "catalog_get_product",
    "Read a product's full JSON plus its prices.",
    { id: { type: "string" }, withTrashed: { type: "boolean" } },
    ["id"],
    async (args) => {
      const id = str(args.id);
      const product = await adapter.products.find(id, { withTrashed: args.withTrashed === true });
      if (!product) return errorResult(`No product with id ${id}`);
      const prices = await adapter.prices.forProduct(id, { withTrashed: args.withTrashed === true });
      const out = { product, prices };
      return textResult(JSON.stringify(out, null, 2), out);
    },
    false,
  );

  reg(
    "catalog_list_prices",
    "List prices for a product (pass productId), or every price (omit it).",
    { productId: { type: "string" }, withTrashed: { type: "boolean" } },
    [],
    async (args) => {
      const withTrashed = args.withTrashed === true;
      const prices = args.productId !== undefined
        ? await adapter.prices.forProduct(str(args.productId), { withTrashed })
        : await adapter.prices.all({ withTrashed });
      const list = prices.map((p) => ({
        id: p.id,
        productId: p.productId,
        currency: p.currency,
        unitAmount: p.unitAmount,
        type: p.type,
        active: p.active ?? true,
        externalId: p.externalId ?? null,
      }));
      return textResult(JSON.stringify(list, null, 2), list);
    },
    false,
  );

  // ─── Create tools ────────────────────────────────────────────────────────

  reg(
    "catalog_create_product",
    "Create a product. `name` is required; id (ULID) is auto-assigned. Returns the created product.",
    {
      name: { type: "string" },
      description: { type: "string" },
      active: { type: "boolean" },
      lookupKey: { type: "string" },
      metadata: { type: "object" },
    },
    ["name"],
    async (args) => {
      const name = str(args.name);
      if (!name) return errorResult("name is required.");
      const product = await adapter.createProduct({
        name,
        ...(args.description !== undefined ? { description: str(args.description) } : {}),
        ...(args.active !== undefined ? { active: args.active === true } : {}),
        ...(args.lookupKey !== undefined ? { lookupKey: str(args.lookupKey) } : {}),
        ...(args.metadata && typeof args.metadata === "object" ? { metadata: args.metadata as Record<string, unknown> } : {}),
      });
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: catalogId,
        action: "catalog_create_product",
        label: `Created product ${product.id} (${product.name})`,
        undo: () => void adapter.products.remove(product.id),
        redo: () => void adapter.createProduct({ ...product }),
      });
      return textResult(`Created product ${product.id} (${product.name})`, product);
    },
    (args) => target(undefined, `create product ${str(args.name)}`),
  );

  reg(
    "catalog_create_price",
    "Create a price under a product. unitAmount is integer minor units (cents). type is 'recurring' | 'one_time'.",
    {
      productId: { type: "string" },
      currency: { type: "string", description: "ISO-4217, e.g. 'USD'." },
      unitAmount: { type: "number", description: "Price in cents." },
      type: { type: "string", enum: ["recurring", "one_time"] },
      recurringInterval: { type: "string", description: "'month' | 'year' | … (recurring only)." },
      nickname: { type: "string" },
      lookupKey: { type: "string" },
      metadata: { type: "object" },
    },
    ["productId", "currency", "unitAmount", "type"],
    async (args) => {
      const productId = str(args.productId);
      const product = await adapter.products.find(productId);
      if (!product) return errorResult(`No product with id ${productId}`);
      const type = str(args.type) as "recurring" | "one_time";
      if (type !== "recurring" && type !== "one_time") return errorResult("type must be 'recurring' or 'one_time'.");
      const price = await adapter.createPrice({
        productId,
        currency: str(args.currency),
        unitAmount: num(args.unitAmount),
        type,
        ...(args.recurringInterval !== undefined ? { recurringInterval: str(args.recurringInterval) } : {}),
        ...(args.nickname !== undefined ? { nickname: str(args.nickname) } : {}),
        ...(args.lookupKey !== undefined ? { lookupKey: str(args.lookupKey) } : {}),
        ...(args.metadata && typeof args.metadata === "object" ? { metadata: args.metadata as Record<string, unknown> } : {}),
      });
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: catalogId,
        action: "catalog_create_price",
        label: `Created price ${price.id} on ${productId}`,
        undo: () => void adapter.prices.remove(price.id),
        redo: () => void adapter.createPrice({ ...price }),
      });
      return textResult(`Created ${type} price ${price.id} on ${productId}`, price);
    },
    (args) => target(str(args.productId), `create price on ${str(args.productId)}`),
  );

  // ─── Destructive tools (pendingMode-gated) ───────────────────────────────

  reg(
    "catalog_delete_product",
    "Soft-delete a product (preserves financial history). Staged in pendingMode — pass confirm:true or wire a host confirm hook.",
    { id: { type: "string" }, confirm: { type: "boolean" } },
    ["id"],
    async (args) => {
      const id = str(args.id);
      const product = await adapter.products.find(id, { withTrashed: true });
      if (!product) return errorResult(`No product with id ${id}`);
      const blocked = await guardDestructive("catalog_delete_product", id, product.name, args.confirm === true);
      if (blocked) return blocked;
      const snapshot = { ...product };
      await adapter.products.remove(id);
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: catalogId,
        action: "catalog_delete_product",
        label: `Deleted product ${id} (${product.name})`,
        undo: () => void adapter.createProduct({ ...snapshot }),
        redo: () => void adapter.products.remove(id),
      });
      return textResult(`Deleted product ${id}`, { id });
    },
    (args) => target(str(args.id), `delete product ${str(args.id)}`),
  );

  reg(
    "catalog_delete_price",
    "Soft-delete a price (mirrors Stripe archiving). Staged in pendingMode — pass confirm:true or wire a host confirm hook.",
    { id: { type: "string" }, confirm: { type: "boolean" } },
    ["id"],
    async (args) => {
      const id = str(args.id);
      const price = await adapter.prices.find(id, { withTrashed: true });
      if (!price) return errorResult(`No price with id ${id}`);
      const blocked = await guardDestructive("catalog_delete_price", id, id, args.confirm === true);
      if (blocked) return blocked;
      const snapshot = { ...price };
      await adapter.prices.remove(id);
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: catalogId,
        action: "catalog_delete_price",
        label: `Deleted price ${id}`,
        undo: () => void adapter.createPrice({ ...snapshot }),
        redo: () => void adapter.prices.remove(id),
      });
      return textResult(`Deleted price ${id}`, { id });
    },
    (args) => target(str(args.id), `delete price ${str(args.id)}`),
  );

  // ─── Stripe sync ─────────────────────────────────────────────────────────

  reg(
    "catalog_sync_product",
    "Push a product + its prices to Stripe (creates/updates the Stripe Product + Prices, stamps external ids).",
    { id: { type: "string" } },
    ["id"],
    async (args) => {
      if (!adapter.syncProductAndPrices) return errorResult("Host did not wire Stripe sync.");
      const id = str(args.id);
      const product = await adapter.products.find(id);
      if (!product) return errorResult(`No product with id ${id}`);
      const synced = await adapter.syncProductAndPrices(product);
      return textResult(`Synced product ${id} to Stripe (${synced.externalId ?? "no external id"})`, synced);
    },
    (args) => target(str(args.id), `sync product ${str(args.id)}`),
  );

  reg(
    "catalog_test_connection",
    "Verify the Stripe connection — returns { success, message, productCount? }.",
    {},
    [],
    async () => {
      if (!adapter.testConnection) return errorResult("Host did not wire a Stripe connection test.");
      const result = await adapter.testConnection();
      return textResult(JSON.stringify(result, null, 2), result);
    },
    false,
  );

  // ─── Checkout ────────────────────────────────────────────────────────────

  reg(
    "catalog_create_checkout",
    "Build a hosted Stripe Checkout URL for a price. Recurring prices → subscription; one-time → payment (pass quantity). Requires the price be synced to Stripe first.",
    {
      priceId: { type: "string" },
      successUrl: { type: "string" },
      cancelUrl: { type: "string" },
      customer: { type: "string", description: "Stripe customer id (optional — Checkout collects one if omitted)." },
      quantity: { type: "number", description: "One-time checkouts only. Default 1." },
      metadata: { type: "object" },
    },
    ["priceId", "successUrl", "cancelUrl"],
    async (args) => {
      const priceId = str(args.priceId);
      const price = await adapter.prices.find(priceId);
      if (!price) return errorResult(`No price with id ${priceId}`);
      const checkoutArgs: CatalogCheckoutArgs = {
        successUrl: str(args.successUrl),
        cancelUrl: str(args.cancelUrl),
        ...(args.customer !== undefined ? { customer: str(args.customer) } : {}),
        ...(args.metadata && typeof args.metadata === "object" ? { metadata: args.metadata as Record<string, string> } : {}),
      };
      let url: string;
      if (price.type === "recurring") {
        if (!adapter.getSubscriptionCheckoutUrl) return errorResult("Host did not wire subscription checkout.");
        url = await adapter.getSubscriptionCheckoutUrl(price, checkoutArgs);
      } else {
        if (!adapter.getOneTimeCheckoutUrl) return errorResult("Host did not wire one-time checkout.");
        url = await adapter.getOneTimeCheckoutUrl(price, { ...checkoutArgs, quantity: num(args.quantity, 1) });
      }
      return textResult(url || "(no url)", { priceId, type: price.type, url });
    },
    (args) => target(str(args.priceId), `checkout ${str(args.priceId)}`),
  );

  return {
    id: `catalog:${catalogId}`,
    title: adapter.title ?? "Catalog",
    dispose: () => {
      for (const d of disposers.splice(0)) d();
    },
  };
}
