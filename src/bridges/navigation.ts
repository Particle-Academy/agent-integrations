import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import type { AgentTarget } from "../presence/types";
import { pushUndoEntry } from "../undo/undo-stack";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";

/**
 * One interactive element the agent can act on, addressed by a STABLE handle
 * (not a CSS selector) so the agent drives the page the Human+ way — never DOM
 * scraping. The host builds these in `describe()` (data-co-handle → name/id →
 * ARIA role + accessible name).
 */
export type PageAction = {
  /** Stable, opaque handle the agent passes back to act on this element. */
  handle: string;
  /** ARIA-ish role: "link" | "button" | "textbox" | "checkbox" | "select" | … */
  role: string;
  /** Accessible name / label. */
  label: string;
  /** Current value for inputs (omitted/masked for sensitive fields). */
  value?: unknown;
  /** True when activating this is destructive / submits (agent should stage). */
  destructive?: boolean;
};

/** The page as the agent sees it: where it is + what it can do. */
export type PageSnapshot = {
  url: string;
  title: string;
  actions: PageAction[];
};

/** A write the host may want the human to confirm (trust-but-verify). */
export type NavigationConfirmRequest = {
  action: "submit" | "click";
  handle: string;
  label: string;
};

/**
 * Host-provided adapter. In the sandbox this is backed by Inertia's `router` +
 * a DOM walker (see resources/js/agent/CoBrowseProvider.tsx). Every method
 * works on stable handles, never raw selectors.
 */
export type NavigationBridgeAdapter = {
  /** Optional fancy-screens screen id for presence targeting. */
  screenId?: string;
  /** Current location. */
  getLocation: () => { url: string; title: string };
  /** Snapshot of the page's actionable elements (stable handles + labels). */
  describe: () => PageSnapshot;
  /** Visible text / heading outline for grounding (optional). */
  read?: () => string;
  /** Navigate to a URL (host wires to router.visit). */
  visit: (url: string) => void | Promise<void>;
  back?: () => void | Promise<void>;
  forward?: () => void | Promise<void>;
  /** Scroll to coords or to a handle's element. */
  scrollTo: (opts: { x?: number; y?: number; handle?: string }) => void;
  scrollBy: (dy: number) => void;
  /** Set a field's value by handle (host dispatches input/change for React). */
  setField: (handle: string, value: unknown) => { ok: boolean; error?: string };
  /** Activate an element by handle. */
  click: (handle: string) => { ok: boolean; error?: string };
  /** Submit a form by handle. */
  submit: (handle: string) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
  /**
   * Trust-but-verify hook. When `pendingMode` is on, `page_submit` and
   * destructive `page_click` route through this; the host shows a prompt and
   * resolves true (proceed) / false (declined).
   */
  confirm?: (req: NavigationConfirmRequest) => Promise<boolean>;
};

export type NavigationBridgeOptions = {
  adapter: NavigationBridgeAdapter;
  /** Identity tagged into activity events (so the human sees who's driving). */
  agent?: { id: string; name?: string; color?: string };
  /** Route submit + destructive clicks through `adapter.confirm`. Default true. */
  pendingMode?: boolean;
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };

/**
 * registerNavigationBridge — site-wide co-browsing. Lets a connected agent
 * navigate, scroll, and (with staged confirm) fill + click any page, addressed
 * by stable handles. Pairs with `useCoBrowseSession` (server + relay) and
 * `<CoBrowsePresence>` (the human's view of the agent). The 12th Fancy bridge.
 */
export function registerNavigationBridge(
  host: ToolHost,
  options: NavigationBridgeOptions,
): Bridge {
  const { adapter } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const pendingMode = options.pendingMode ?? true;
  const disposers: Array<() => void> = [];

  ensureUndoToolsRegistered(host, { defaultAgentId: agent.id });

  const target = (label: string, elementId?: string): AgentTarget => ({
    kind: "navigation",
    screenId: adapter.screenId,
    elementId,
    label,
  });

  const reg = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: JsonObject) => Promise<any> | any,
    activity: false | ((args: JsonObject) => AgentTarget),
  ) => {
    const wrapped = async (args: JsonObject) => {
      try {
        return await handler(args);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    };
    const final = activity
      ? wrapToolWithActivity(wrapped, {
          toolName: name,
          agent: { id: agent.id, name: agent.name, color: agent.color },
          kind: "navigation",
          screenId: adapter.screenId,
          resolveTarget: ({ args }) => activity(args),
        })
      : wrapped;
    disposers.push(
      host.registerTool(
        {
          name,
          description,
          inputSchema: { type: "object", properties: properties as any, required, additionalProperties: false },
        },
        final as any,
      ),
    );
  };

  // ───────────── Read ─────────────

  reg(
    "page_describe",
    "Describe the current page: its URL, title, and the interactive elements you can act on (each with a stable `handle`, role, and label). Call this first, and again after navigating.",
    {},
    [],
    () => {
      const snap = adapter.describe();
      const text = [
        `URL: ${snap.url}`,
        `Title: ${snap.title}`,
        "",
        ...snap.actions.map((a) => `[${a.handle}] ${a.role}: ${a.label}${a.destructive ? " (destructive)" : ""}`),
      ].join("\n");
      return textResult(text, snap);
    },
    false,
  );

  reg(
    "page_read",
    "Read the page's visible text / heading outline for grounding.",
    {},
    [],
    () => textResult(adapter.read ? adapter.read() : "(host did not provide page text)"),
    false,
  );

  // ───────────── Navigate / scroll ─────────────

  reg(
    "nav_visit",
    "Navigate to a URL (same-site path or absolute). The human watches the page change.",
    { url: { type: "string", description: "Path like /packages or an absolute URL." } },
    ["url"],
    async (args) => {
      const url = String(args.url ?? "");
      if (!url) return errorResult("url is required");
      const from = adapter.getLocation().url;
      await adapter.visit(url);
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: "navigation",
        action: "nav_visit",
        label: `Navigate to ${url}`,
        undo: () => {
          adapter.visit(from);
        },
        redo: () => {
          adapter.visit(url);
        },
      });
      return textResult(`Navigated to ${url}`, { url });
    },
    (args) => target(`Navigate → ${String(args.url ?? "")}`),
  );

  reg(
    "nav_back",
    "Go back to the previous page.",
    {},
    [],
    async () => {
      if (!adapter.back) return errorResult("Host did not provide back navigation.");
      await adapter.back();
      return textResult("Went back");
    },
    () => target("Back"),
  );

  reg(
    "nav_forward",
    "Go forward to the next page.",
    {},
    [],
    async () => {
      if (!adapter.forward) return errorResult("Host did not provide forward navigation.");
      await adapter.forward();
      return textResult("Went forward");
    },
    () => target("Forward"),
  );

  reg(
    "nav_scroll_to",
    "Scroll the page to absolute coordinates, or to a specific element by its handle.",
    {
      handle: { type: "string", description: "Scroll this element into view." },
      x: { type: "number" },
      y: { type: "number" },
    },
    [],
    (args) => {
      adapter.scrollTo({
        handle: typeof args.handle === "string" ? args.handle : undefined,
        x: typeof args.x === "number" ? args.x : undefined,
        y: typeof args.y === "number" ? args.y : undefined,
      });
      return textResult("Scrolled");
    },
    () => target("Scroll"),
  );

  reg(
    "nav_scroll_by",
    "Scroll the page by a vertical delta in pixels (negative scrolls up).",
    { dy: { type: "number" } },
    ["dy"],
    (args) => {
      adapter.scrollBy(Number(args.dy ?? 0));
      return textResult(`Scrolled by ${Number(args.dy ?? 0)}px`);
    },
    () => target("Scroll"),
  );

  // ───────────── Co-drive (fill / click / submit) ─────────────

  reg(
    "page_set_field",
    "Set a form field's value by handle. The host updates the controlled input and the human sees it change.",
    {
      handle: { type: "string" },
      value: { description: "Value to set; type matches the field." },
    },
    ["handle", "value"],
    (args) => {
      const handle = String(args.handle ?? "");
      const res = adapter.setField(handle, args.value);
      if (!res.ok) return errorResult(res.error ?? `Could not set ${handle}`);
      return textResult(`${handle} ← ${JSON.stringify(args.value)}`, { handle, value: args.value });
    },
    (args) => target(`Set ${String(args.handle ?? "")}`, String(args.handle ?? "")),
  );

  reg(
    "page_click",
    "Activate an element by handle (link, button, checkbox…). Destructive elements are staged for the human to confirm.",
    { handle: { type: "string" } },
    ["handle"],
    async (args) => {
      const handle = String(args.handle ?? "");
      const action = adapter.describe().actions.find((a) => a.handle === handle);
      if (pendingMode && action?.destructive && adapter.confirm) {
        const ok = await adapter.confirm({ action: "click", handle, label: action.label });
        if (!ok) return errorResult("Declined by user");
      }
      const res = adapter.click(handle);
      if (!res.ok) return errorResult(res.error ?? `Could not click ${handle}`);
      return textResult(`Clicked ${handle}`, { handle });
    },
    (args) => target(`Click ${String(args.handle ?? "")}`, String(args.handle ?? "")),
  );

  reg(
    "page_submit",
    "Submit a form by handle. Always staged for the human to confirm when pendingMode is on.",
    { handle: { type: "string" } },
    ["handle"],
    async (args) => {
      const handle = String(args.handle ?? "");
      if (pendingMode && adapter.confirm) {
        const ok = await adapter.confirm({ action: "submit", handle, label: handle });
        if (!ok) return errorResult("Declined by user");
      }
      const res = await adapter.submit(handle);
      if (!res.ok) return errorResult(res.error ?? "Submit failed");
      return textResult(`Submitted ${handle}`, { handle });
    },
    (args) => target(`Submit ${String(args.handle ?? "")}`, String(args.handle ?? "")),
  );

  return {
    id: "navigation",
    title: "Co-browsing",
    dispose: () => {
      for (const d of disposers) d();
    },
  };
}
