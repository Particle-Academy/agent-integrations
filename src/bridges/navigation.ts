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
  /** Monotonic host revision. Human input advances it and invalidates stale agent intent. */
  revision?: number;
};

/**
 * Structured page text. Preferred over a plain string from `read()`: the bridge
 * can then put every page-supplied string on its own single line and keep the
 * outline. A plain string is untrusted as a whole and is rendered as ONE line.
 */
export type PageReadout = {
  title: string;
  headings: Array<{ level: number; text: string }>;
  text: string;
};

/** A write the host may want the human to confirm (trust-but-verify). */
export type NavigationConfirmRequest = {
  action: "submit" | "click";
  handle: string;
  label: string;
};

type MaybePromise<T> = T | Promise<T>;

/**
 * Host-provided adapter. In the sandbox this is backed by Inertia's `router` +
 * the DOM walker from `@particle-academy/agent-integrations/dom-navigation`.
 * Every method works on stable handles, never raw selectors.
 *
 * Any method may return a Promise: a host driving a page it does not run in
 * (an Electron WebContentsView, via `createRemoteNavigationAdapter`) can only
 * answer asynchronously. The bridge awaits every call.
 */
export type NavigationBridgeAdapter = {
  /** Optional fancy-screens screen id for presence targeting. */
  screenId?: string;
  /** Current location. */
  getLocation: () => MaybePromise<{ url: string; title: string }>;
  /** Current human-control revision. Omit to disable stale-intent protection. */
  getRevision?: () => MaybePromise<number>;
  /** Snapshot of the page's actionable elements (stable handles + labels). */
  describe: () => MaybePromise<PageSnapshot>;
  /** Visible text / heading outline for grounding (optional). Prefer a {@link PageReadout}. */
  read?: () => MaybePromise<string | PageReadout>;
  /** Navigate to a URL (host wires to router.visit). */
  visit: (url: string) => void | Promise<void>;
  back?: () => void | Promise<void>;
  forward?: () => void | Promise<void>;
  /** Scroll to coords or to a handle's element. */
  scrollTo: (opts: { x?: number; y?: number; handle?: string }) => void | Promise<void>;
  scrollBy: (dy: number) => void | Promise<void>;
  /** Set a field's value by handle (host dispatches input/change for React). */
  setField: (handle: string, value: unknown) => MaybePromise<{ ok: boolean; error?: string }>;
  /** Activate an element by handle. */
  click: (handle: string) => MaybePromise<{ ok: boolean; error?: string }>;
  /** Submit a form by handle. */
  submit: (handle: string) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
  /**
   * Viewport rect of a handle's element, for agent-presence rendering (cursor +
   * highlight). Returned in tool `meta.rect` so `<CoBrowseCursorLayer>` can show
   * the agent acting on the page. Optional — omit and there's just no cursor.
   */
  rectFor?: (handle: string) => MaybePromise<{ x: number; y: number; width: number; height: number } | null>;
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

// ───────────── Text safety ─────────────
//
// Every string below the adapter is page-supplied, and the page may be hostile.
// The tool TEXT is what lands in the agent's context, so a line break inside a
// label would let the page write its own lines there: a forged action, a forged
// heading, forged tool framing. Each page string is therefore rendered on ONE
// line, with C0/C1 controls and the Unicode line/paragraph separators replaced,
// and capped. (Control characters are tested by code point, so no escape
// sequence is involved.)

const isControl = (code: number) =>
  code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;

/** One line, controls replaced by spaces, whitespace collapsed, capped at `max`. */
function oneLine(value: unknown, max: number): string {
  const raw = typeof value === "string" ? value : value == null ? "" : String(value);
  // Bound the work on a hostile multi-megabyte string before scanning it.
  const bounded = raw.length > max * 4 ? raw.slice(0, max * 4) : raw;
  let out = "";
  for (const c of bounded) out += isControl(c.charCodeAt(0)) ? " " : c;
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? out.slice(0, max - 3) + "..." : out;
}

/**
 * A handle shown verbatim must not be able to imitate the `[handle] role:`
 * syntax, so only this charset is shown as-is. Anything else — spaces,
 * brackets, controls, or a `~`, which is reserved so a page cannot squat on an
 * alias — is shown as a bridge-minted `~N` alias that resolves back to it.
 */
const SAFE_HANDLE = /^[A-Za-z0-9_.:#@/-]{1,80}$/;

const CAP = { url: 500, title: 200, role: 40, label: 200, heading: 200, text: 4000, error: 300, headings: 50 };

function formatReadout(r: string | PageReadout): string {
  if (typeof r === "string") return oneLine(r, CAP.text);
  const headings = (Array.isArray(r.headings) ? r.headings : [])
    .slice(0, CAP.headings)
    .map((h) => `H${Math.min(6, Math.max(1, Math.trunc(Number(h?.level)) || 1))}: ${oneLine(h?.text, CAP.heading)}`);
  return [oneLine(r.title, CAP.title), ...headings, "", oneLine(r.text, CAP.text)].join("\n");
}

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
  // The bridge id is also its registrant identity on the host: the same bridge
  // may re-register (a remount), a different one claiming a name is refused.
  const bridgeId = "navigation";
  let groundedRevision: number | null = null;

  const staleIntent = async () => {
    const current = await adapter.getRevision?.();
    if (current === undefined) return null;
    if (groundedRevision === null || groundedRevision !== current) {
      return errorResult(
        `Human took control at page revision ${current}. This agent action was cancelled; call page_describe before acting again.`,
      );
    }
    return null;
  };

  /** Alias → page handle, from the latest page_describe. */
  let aliases = new Map<string, string>();
  /** The handle the adapter knows, for a handle the agent passed back. */
  const pageHandle = (handle: string) => aliases.get(handle) ?? handle;
  /** A failure message that may carry page-supplied text. */
  const failure = (message: unknown, fallback: string) => errorResult(oneLine(message ?? fallback, CAP.error) || fallback);

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
        // A transport into the page can surface the page's own error text.
        return failure(e instanceof Error ? e.message : String(e), `${name} failed`);
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
        { owner: bridgeId },
      ),
    );
  };

  // ───────────── Read ─────────────

  reg(
    "page_describe",
    "Describe the current page: its URL, title, and the interactive elements you can act on (each with a stable `handle`, role, and label). Call this first, and again after navigating.",
    {},
    [],
    async () => {
      const raw = await adapter.describe();
      const next = new Map<string, string>();
      const actions = (Array.isArray(raw.actions) ? raw.actions : []).map((a) => {
        const handle = String(a.handle ?? "");
        if (SAFE_HANDLE.test(handle)) return a;
        const alias = `~${next.size}`;
        next.set(alias, handle);
        return { ...a, handle: alias };
      });
      aliases = next;
      const snap: PageSnapshot = { ...raw, actions };
      const revision = await adapter.getRevision?.();
      if (revision !== undefined) {
        snap.revision = revision;
        groundedRevision = revision;
      }
      const text = [
        `URL: ${oneLine(snap.url, CAP.url)}`,
        `Title: ${oneLine(snap.title, CAP.title)}`,
        "",
        ...actions.map(
          (a) =>
            `[${a.handle}] ${oneLine(a.role, CAP.role)}: ${oneLine(a.label, CAP.label)}${a.destructive ? " (destructive)" : ""}`,
        ),
      ].join("\n");
      return textResult(text, snap);
    },
    () => target("Inspect page"),
  );

  reg(
    "page_read",
    "Read the page's visible text / heading outline for grounding.",
    {},
    [],
    async () => {
      const r = adapter.read ? await adapter.read() : undefined;
      return textResult(r == null ? "(host did not provide page text)" : formatReadout(r));
    },
    () => target("Read page"),
  );

  reg(
    "page_focus",
    "Move the agent's visible focus to an interactive element by stable handle without activating it.",
    { handle: { type: "string" } },
    ["handle"],
    async (args) => {
      const stale = await staleIntent();
      if (stale) return stale;
      const shown = String(args.handle ?? "");
      const handle = pageHandle(shown);
      const action = (await adapter.describe()).actions.find((candidate) => candidate.handle === handle);
      if (!action) return failure(`No element for handle "${shown}"`, "No element for that handle");
      return textResult(`Focused ${oneLine(shown, CAP.label)}`, {
        handle: shown,
        rect: (await adapter.rectFor?.(handle)) ?? undefined,
      });
    },
    (args) => target(`Focus ${String(args.handle ?? "")}`, String(args.handle ?? "")),
  );

  // ───────────── Navigate / scroll ─────────────

  reg(
    "nav_visit",
    "Navigate to a URL (same-site path or absolute). The human watches the page change.",
    { url: { type: "string", description: "Path like /packages or an absolute URL." } },
    ["url"],
    async (args) => {
      const stale = await staleIntent();
      if (stale) return stale;
      const url = String(args.url ?? "");
      if (!url) return errorResult("url is required");
      // Scheme allow-list: permit only same-site/relative paths and http(s)
      // absolutes. A `javascript:` / `data:` / `file:` / `vbscript:` URL handed
      // to a host that wires visit() to window.location would execute as the
      // human — a semi-trusted agent (steerable via page_read prompt injection)
      // must not reach those.
      const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)?.[1]?.toLowerCase();
      if (scheme && scheme !== "http" && scheme !== "https") {
        return errorResult(
          `Refusing to navigate to a '${scheme}:' URL. Only http(s) URLs or same-site paths are allowed.`,
        );
      }
      const from = (await adapter.getLocation()).url;
      await adapter.visit(url);
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: "navigation",
        action: "nav_visit",
        label: `Navigate to ${url}`,
        undo: async () => {
          await adapter.visit(from);
        },
        redo: async () => {
          await adapter.visit(url);
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
      const stale = await staleIntent();
      if (stale) return stale;
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
      const stale = await staleIntent();
      if (stale) return stale;
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
    async (args) => {
      const stale = await staleIntent();
      if (stale) return stale;
      const shown = typeof args.handle === "string" ? args.handle : undefined;
      const handle = shown === undefined ? undefined : pageHandle(shown);
      await adapter.scrollTo({
        handle,
        x: typeof args.x === "number" ? args.x : undefined,
        y: typeof args.y === "number" ? args.y : undefined,
      });
      return textResult(
        "Scrolled",
        handle ? { handle: shown, rect: (await adapter.rectFor?.(handle)) ?? undefined } : undefined,
      );
    },
    () => target("Scroll"),
  );

  reg(
    "nav_scroll_by",
    "Scroll the page by a vertical delta in pixels (negative scrolls up).",
    { dy: { type: "number" } },
    ["dy"],
    async (args) => {
      const stale = await staleIntent();
      if (stale) return stale;
      await adapter.scrollBy(Number(args.dy ?? 0));
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
    async (args) => {
      const stale = await staleIntent();
      if (stale) return stale;
      const shown = String(args.handle ?? "");
      const handle = pageHandle(shown);
      const res = await adapter.setField(handle, args.value);
      if (!res.ok) return failure(res.error, `Could not set ${oneLine(shown, CAP.label)}`);
      return textResult(`${oneLine(shown, CAP.label)} ← ${JSON.stringify(args.value)}`, {
        handle: shown,
        value: args.value,
        rect: (await adapter.rectFor?.(handle)) ?? undefined,
      });
    },
    (args) => target(`Set ${String(args.handle ?? "")}`, String(args.handle ?? "")),
  );

  reg(
    "page_click",
    "Activate an element by handle (link, button, checkbox…). Destructive elements are staged for the human to confirm.",
    { handle: { type: "string" } },
    ["handle"],
    async (args) => {
      const stale = await staleIntent();
      if (stale) return stale;
      const shown = String(args.handle ?? "");
      const handle = pageHandle(shown);
      const action = (await adapter.describe()).actions.find((a) => a.handle === handle);
      const rect = (await adapter.rectFor?.(handle)) ?? undefined; // capture before the click may navigate away
      if (pendingMode && action?.destructive && adapter.confirm) {
        const ok = await adapter.confirm({ action: "click", handle, label: action.label });
        if (!ok) return errorResult("Declined by user");
      }
      const res = await adapter.click(handle);
      if (!res.ok) return failure(res.error, `Could not click ${oneLine(shown, CAP.label)}`);
      return textResult(`Clicked ${oneLine(shown, CAP.label)}`, { handle: shown, rect });
    },
    (args) => target(`Click ${String(args.handle ?? "")}`, String(args.handle ?? "")),
  );

  reg(
    "page_submit",
    "Submit a form by handle. Always staged for the human to confirm when pendingMode is on.",
    { handle: { type: "string" } },
    ["handle"],
    async (args) => {
      const stale = await staleIntent();
      if (stale) return stale;
      const shown = String(args.handle ?? "");
      const handle = pageHandle(shown);
      const rect = (await adapter.rectFor?.(handle)) ?? undefined; // capture before the submit navigates
      if (pendingMode && adapter.confirm) {
        const ok = await adapter.confirm({ action: "submit", handle, label: handle });
        if (!ok) return errorResult("Declined by user");
      }
      const res = await adapter.submit(handle);
      if (!res.ok) return failure(res.error, "Submit failed");
      return textResult(`Submitted ${oneLine(shown, CAP.label)}`, { handle: shown, rect });
    },
    (args) => target(`Submit ${String(args.handle ?? "")}`, String(args.handle ?? "")),
  );

  return {
    id: bridgeId,
    title: "Co-browsing",
    dispose: () => {
      for (const d of disposers) d();
    },
  };
}
