import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerCatalogBridge, type CatalogBridgeAdapter, type CatalogProduct, type CatalogPrice } from "../catalog";
import { resetAllUndoStacks } from "../../undo/undo-stack";

/**
 * A tiny in-memory catalog standing in for a real fancy-catalog `Catalog`.
 * Mirrors the store + authoring-helper shape the bridge adapter expects.
 */
function makeAdapter(): { adapter: CatalogBridgeAdapter; products: Map<string, CatalogProduct>; prices: Map<string, CatalogPrice> } {
  const products = new Map<string, CatalogProduct>();
  const prices = new Map<string, CatalogPrice>();
  let seq = 0;
  const id = () => `id_${++seq}`;
  const live = <T extends { deletedAt?: unknown }>(rows: T[], withTrashed?: boolean) =>
    withTrashed ? rows : rows.filter((r) => r.deletedAt == null);

  const adapter: CatalogBridgeAdapter = {
    id: "test-catalog",
    products: {
      find: (pid, opts) => {
        const p = products.get(pid);
        if (!p) return null;
        return !opts?.withTrashed && (p as { deletedAt?: unknown }).deletedAt != null ? null : p;
      },
      all: (opts) => live([...products.values()] as Array<CatalogProduct & { deletedAt?: unknown }>, opts?.withTrashed),
      remove: (pid) => {
        const p = products.get(pid) as (CatalogProduct & { deletedAt?: unknown }) | undefined;
        if (p) p.deletedAt = new Date();
      },
    },
    prices: {
      find: (rid, opts) => {
        const p = prices.get(rid);
        if (!p) return null;
        return !opts?.withTrashed && (p as { deletedAt?: unknown }).deletedAt != null ? null : p;
      },
      forProduct: (productId, opts) =>
        live([...prices.values()].filter((p) => p.productId === productId) as Array<CatalogPrice & { deletedAt?: unknown }>, opts?.withTrashed),
      all: (opts) => live([...prices.values()] as Array<CatalogPrice & { deletedAt?: unknown }>, opts?.withTrashed),
      remove: (rid) => {
        const p = prices.get(rid) as (CatalogPrice & { deletedAt?: unknown }) | undefined;
        if (p) p.deletedAt = new Date();
      },
    },
    createProduct: (input) => {
      const product: CatalogProduct = { active: true, ...input, id: (input.id as string) ?? id() };
      products.set(product.id, product);
      return product;
    },
    createPrice: (input) => {
      const price: CatalogPrice = { active: true, ...input, id: (input.id as string) ?? id() };
      prices.set(price.id, price);
      return price;
    },
    getSubscriptionCheckoutUrl: vi.fn(() => "https://checkout.test/sub"),
    getOneTimeCheckoutUrl: vi.fn(() => "https://checkout.test/once"),
  };
  return { adapter, products, prices };
}

const text = (r: any) => r.content?.[0]?.text ?? "";
const sc = (r: any) => r.structuredContent;

describe("registerCatalogBridge", () => {
  it("registers the catalog_* tools plus undo tools", () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    registerCatalogBridge(host, { adapter: makeAdapter().adapter });
    const names = host.listTools().map((t) => t.name);
    for (const n of [
      "catalog_list_products",
      "catalog_get_product",
      "catalog_create_product",
      "catalog_delete_product",
      "catalog_list_prices",
      "catalog_create_price",
      "catalog_delete_price",
      "catalog_sync_product",
      "catalog_test_connection",
      "catalog_create_checkout",
      "agent_undo",
    ]) {
      expect(names).toContain(n);
    }
  });

  it("creates a product then lists it", async () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    const { adapter, products } = makeAdapter();
    registerCatalogBridge(host, { adapter });

    const created = await host.callTool("catalog_create_product", { name: "Pro Plan", lookupKey: "pro" });
    const id = sc(created).id as string;
    expect(products.has(id)).toBe(true);

    const listed = await host.callTool("catalog_list_products", {});
    const list = sc(listed) as Array<{ id: string; name: string; priceCount: number }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, name: "Pro Plan", priceCount: 0 });
  });

  it("creates a price under a product (priceCount reflects it)", async () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    const { adapter } = makeAdapter();
    registerCatalogBridge(host, { adapter });

    const product = sc(await host.callTool("catalog_create_product", { name: "Pro" }));
    const price = await host.callTool("catalog_create_price", {
      productId: product.id,
      currency: "USD",
      unitAmount: 1999,
      type: "recurring",
      recurringInterval: "month",
    });
    expect(sc(price)).toMatchObject({ productId: product.id, unitAmount: 1999, type: "recurring" });

    const got = sc(await host.callTool("catalog_get_product", { id: product.id }));
    expect(got.prices).toHaveLength(1);
  });

  it("stages catalog_delete_product in pendingMode until confirm:true", async () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    const { adapter, products } = makeAdapter();
    registerCatalogBridge(host, { adapter }); // pendingMode defaults true
    const product = sc(await host.callTool("catalog_create_product", { name: "Doomed" }));

    const staged = await host.callTool("catalog_delete_product", { id: product.id });
    expect(staged.isError).toBe(true);
    expect(text(staged)).toContain("staged");
    expect((products.get(product.id) as any).deletedAt).toBeUndefined();

    const applied = await host.callTool("catalog_delete_product", { id: product.id, confirm: true });
    expect(applied.isError).toBeFalsy();
    expect((products.get(product.id) as any).deletedAt).toBeInstanceOf(Date);
  });

  it("routes destructive deletes through a host confirm hook when provided", async () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    const { adapter, products } = makeAdapter();
    const confirm = vi.fn(async () => false);
    registerCatalogBridge(host, { adapter, confirm });
    const product = sc(await host.callTool("catalog_create_product", { name: "Safe" }));

    const declined = await host.callTool("catalog_delete_product", { id: product.id });
    expect(confirm).toHaveBeenCalledWith({ action: "catalog_delete_product", id: product.id, label: "Safe" });
    expect(declined.isError).toBe(true);
    expect((products.get(product.id) as any).deletedAt).toBeUndefined();
  });

  it("builds a subscription checkout url for a recurring price", async () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    const { adapter } = makeAdapter();
    registerCatalogBridge(host, { adapter });
    const product = sc(await host.callTool("catalog_create_product", { name: "Pro" }));
    const price = sc(await host.callTool("catalog_create_price", { productId: product.id, currency: "USD", unitAmount: 1000, type: "recurring" }));

    const res = await host.callTool("catalog_create_checkout", {
      priceId: price.id,
      successUrl: "https://app/ok",
      cancelUrl: "https://app/no",
    });
    expect(sc(res).url).toBe("https://checkout.test/sub");
    expect(adapter.getSubscriptionCheckoutUrl).toHaveBeenCalled();
  });
});
