import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import {
  registerNavigationBridge,
  type NavigationBridgeAdapter,
  type PageSnapshot,
} from "../navigation";

/** A scriptable in-memory adapter mirroring the host's Inertia/DOM adapter. */
function makeAdapter(overrides: Partial<NavigationBridgeAdapter> = {}) {
  const state = { url: "/", title: "Home", scrollY: 0 };
  const snapshot: PageSnapshot = {
    url: "/",
    title: "Home",
    actions: [
      { handle: "h1", role: "link", label: "Packages" },
      { handle: "name", role: "textbox", label: "Name", value: "" },
      { handle: "delete", role: "button", label: "Delete account", destructive: true },
      { handle: "signup", role: "button", label: "Sign up" },
    ],
  };
  const adapter: NavigationBridgeAdapter = {
    getLocation: () => ({ url: state.url, title: state.title }),
    describe: () => ({ ...snapshot, url: state.url, title: state.title }),
    read: () => "Home\nWelcome to Fancy UI",
    visit: vi.fn((url: string) => {
      state.url = url;
    }),
    back: vi.fn(),
    forward: vi.fn(),
    scrollTo: vi.fn(),
    scrollBy: vi.fn((dy: number) => {
      state.scrollY += dy;
    }),
    setField: vi.fn(() => ({ ok: true })),
    click: vi.fn(() => ({ ok: true })),
    submit: vi.fn(() => ({ ok: true })),
    ...overrides,
  };
  return { adapter, state };
}

const text = (r: any) => r.content?.[0]?.text ?? "";

describe("registerNavigationBridge", () => {
  it("registers the page_/nav_ tools plus undo tools", () => {
    const host = new ToolRegistry();
    registerNavigationBridge(host, { adapter: makeAdapter().adapter });
    const names = host.listTools().map((t) => t.name);
    for (const n of [
      "page_describe",
      "page_read",
      "page_focus",
      "nav_visit",
      "nav_back",
      "nav_forward",
      "nav_scroll_to",
      "nav_scroll_by",
      "page_set_field",
      "page_click",
      "page_submit",
      "agent_undo",
    ]) {
      expect(names).toContain(n);
    }
  });

  it("page_focus reports the stable handle rect without activating it", async () => {
    const host = new ToolRegistry();
    const rect = { x: 10, y: 20, width: 100, height: 30 };
    const { adapter } = makeAdapter({ rectFor: vi.fn(() => rect) });
    registerNavigationBridge(host, { adapter });

    const res = await host.callTool("page_focus", { handle: "h1" });

    expect(res.structuredContent).toMatchObject({ handle: "h1", rect });
    expect(adapter.click).not.toHaveBeenCalled();
  });

  it("cancels stale agent intent after the human advances the page revision", async () => {
    const host = new ToolRegistry();
    let revision = 1;
    const { adapter } = makeAdapter({ getRevision: () => revision });
    registerNavigationBridge(host, { adapter });

    await host.callTool("page_describe", {});
    revision += 1;
    const stale = await host.callTool("page_click", { handle: "h1" });

    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain("Human took control");
    expect(adapter.click).not.toHaveBeenCalled();

    await host.callTool("page_describe", {});
    await host.callTool("page_click", { handle: "h1" });
    expect(adapter.click).toHaveBeenCalledWith("h1");
  });

  it("page_describe returns the snapshot with stable handles", async () => {
    const host = new ToolRegistry();
    registerNavigationBridge(host, { adapter: makeAdapter().adapter });
    const res = await host.callTool("page_describe", {});
    expect(text(res)).toContain("[h1] link: Packages");
    expect(text(res)).toContain("[delete] button: Delete account (destructive)");
  });

  it("nav_visit drives the adapter and records the previous URL for undo", async () => {
    const host = new ToolRegistry();
    const { adapter, state } = makeAdapter();
    registerNavigationBridge(host, { adapter });
    await host.callTool("nav_visit", { url: "/packages" });
    expect(adapter.visit).toHaveBeenCalledWith("/packages");
    expect(state.url).toBe("/packages");
  });

  it("nav_scroll_by forwards the delta", async () => {
    const host = new ToolRegistry();
    const { adapter } = makeAdapter();
    registerNavigationBridge(host, { adapter });
    await host.callTool("nav_scroll_by", { dy: 240 });
    expect(adapter.scrollBy).toHaveBeenCalledWith(240);
  });

  it("page_set_field sets a value through the adapter", async () => {
    const host = new ToolRegistry();
    const { adapter } = makeAdapter();
    registerNavigationBridge(host, { adapter });
    await host.callTool("page_set_field", { handle: "name", value: "Ada" });
    expect(adapter.setField).toHaveBeenCalledWith("name", "Ada");
  });

  it("page_submit is staged: declined confirm blocks the submit", async () => {
    const host = new ToolRegistry();
    const confirm = vi.fn(async () => false);
    const { adapter } = makeAdapter({ confirm });
    registerNavigationBridge(host, { adapter, pendingMode: true });
    const res = await host.callTool("page_submit", { handle: "signup" });
    expect(confirm).toHaveBeenCalledWith({ action: "submit", handle: "signup", label: "signup" });
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(text(res)).toContain("Declined");
  });

  it("page_submit proceeds when confirm resolves true", async () => {
    const host = new ToolRegistry();
    const confirm = vi.fn(async () => true);
    const { adapter } = makeAdapter({ confirm });
    registerNavigationBridge(host, { adapter, pendingMode: true });
    await host.callTool("page_submit", { handle: "signup" });
    expect(adapter.submit).toHaveBeenCalledWith("signup");
  });

  it("page_click stages destructive elements but lets safe ones through", async () => {
    const host = new ToolRegistry();
    const confirm = vi.fn(async () => false);
    const { adapter } = makeAdapter({ confirm });
    registerNavigationBridge(host, { adapter, pendingMode: true });

    // Destructive → confirm gate (declined → not clicked)
    await host.callTool("page_click", { handle: "delete" });
    expect(confirm).toHaveBeenCalledWith({ action: "click", handle: "delete", label: "Delete account" });
    expect(adapter.click).not.toHaveBeenCalled();

    // Safe → no confirm, clicked directly
    await host.callTool("page_click", { handle: "h1" });
    expect(adapter.click).toHaveBeenCalledWith("h1");
  });
});
