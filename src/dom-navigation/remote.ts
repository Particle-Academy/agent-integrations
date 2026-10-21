/**
 * The host half: a {@link NavigationBridgeAdapter} that drives a page it does
 * not run in, through any transport that can carry a method name and plain
 * arguments into the page and a plain result back — Electron's
 * `executeJavaScript` / `executeJavaScriptInIsolatedWorld`, a MessagePort, a
 * WebSocket to a remote browser.
 *
 * Every result is treated as hostile: the page owns the DOM the in-page walker
 * reads, and if the script was injected into the MAIN world the page can
 * replace the walker outright. So results are coerced to the declared shapes
 * here, and anything malformed is dropped rather than passed on to the agent.
 */
import type {
  NavigationBridgeAdapter,
  NavigationConfirmRequest,
  PageAction,
  PageReadout,
  PageSnapshot,
} from "../bridges/navigation";
import { DOM_NAVIGATION_METHODS, type ActionResult, type DomNavigationMethod, type HandleRect } from "./agent";

/** The global the injected script installs in the world it runs in. */
export const DOM_NAVIGATION_GLOBAL = "__fancyDomNavigation";

/** Bumped only if the wire protocol changes incompatibly. */
export const DOM_NAVIGATION_PROTOCOL = 1;

/**
 * Carries one call into the page. `args` and the resolved value are plain,
 * structured-cloneable data. Reject (or throw) when the call could not be
 * delivered — e.g. the page navigated and the script must be re-injected.
 */
export type DomNavigationTransport = {
  call(method: DomNavigationMethod, args: unknown[]): Promise<unknown>;
};

export type RemoteNavigationAdapterOptions = {
  transport: DomNavigationTransport;
  /** Optional fancy-screens screen id for presence targeting. */
  screenId?: string;
  /** Human-control revision, if the host tracks one. Omit to disable stale-intent protection. */
  getRevision?: () => number | Promise<number>;
  /**
   * Trust-but-verify. Without it, `page_submit` and destructive `page_click`
   * are NOT staged — they run as soon as the agent asks. A host showing pages
   * it does not own should always supply one.
   */
  confirm?: (req: NavigationConfirmRequest) => Promise<boolean>;
};

const METHODS = new Set<string>(DOM_NAVIGATION_METHODS);

function assertMethod(method: string): asserts method is DomNavigationMethod {
  if (!METHODS.has(method)) throw new Error(`Unknown dom-navigation method: ${method}`);
}

/**
 * A JavaScript expression that performs one call against the injected global —
 * what a host passes to `executeJavaScript`. Arguments are embedded as JSON,
 * which is a valid JS expression, so no argument can break out of its literal.
 */
export function domNavigationCallScript(method: DomNavigationMethod, args: unknown[] = []): string {
  assertMethod(method);
  const g = JSON.stringify(DOM_NAVIGATION_GLOBAL);
  return (
    `(function(){var n=globalThis[${g}];` +
    `if(!n||typeof n.call!=="function")throw new Error("fancy dom-navigation is not injected in this world");` +
    `return n.call(${JSON.stringify(method)},${JSON.stringify(args)});})()`
  );
}

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function coerceAction(v: unknown): PageAction | null {
  if (!isObj(v) || typeof v.handle !== "string" || v.handle === "") return null;
  const action: PageAction = {
    handle: v.handle,
    role: str(v.role, "generic"),
    label: str(v.label),
    destructive: v.destructive === true,
  };
  const value = v.value;
  if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    action.value = value;
  }
  return action;
}

function coerceSnapshot(v: unknown): PageSnapshot {
  const o = isObj(v) ? v : {};
  const actions = Array.isArray(o.actions)
    ? o.actions.map(coerceAction).filter((a): a is PageAction => a !== null)
    : [];
  return { url: str(o.url), title: str(o.title), actions };
}

/** A plain string stays a string (the bridge renders it as one line). */
function coerceReadout(v: unknown): string | PageReadout {
  if (typeof v === "string") return v;
  const o = isObj(v) ? v : {};
  const headings = (Array.isArray(o.headings) ? o.headings : []).flatMap((h) =>
    isObj(h) && typeof h.text === "string" && typeof h.level === "number" && Number.isFinite(h.level)
      ? [{ level: h.level, text: h.text }]
      : [],
  );
  return { title: str(o.title), headings, text: str(o.text) };
}

function coerceResult(v: unknown): ActionResult {
  const o = isObj(v) ? v : {};
  return { ok: o.ok === true, error: typeof o.error === "string" ? o.error : undefined };
}

function coerceRect(v: unknown): HandleRect | null {
  if (!isObj(v)) return null;
  const { x, y, width, height } = v;
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  return finite(x) && finite(y) && finite(width) && finite(height) ? { x, y, width, height } : null;
}

/** Build a NavigationBridgeAdapter backed by a transport into the page. */
export function createRemoteNavigationAdapter(options: RemoteNavigationAdapterOptions): NavigationBridgeAdapter {
  const { transport } = options;
  const call = (method: DomNavigationMethod, ...args: unknown[]) => transport.call(method, args);
  const fail = (e: unknown): ActionResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) });

  return {
    screenId: options.screenId,
    getRevision: options.getRevision,
    confirm: options.confirm,
    getLocation: async () => {
      const o = await call("getLocation");
      const loc = isObj(o) ? o : {};
      return { url: str(loc.url), title: str(loc.title) };
    },
    describe: async () => coerceSnapshot(await call("describe")),
    read: async () => coerceReadout(await call("read")),
    visit: async (url) => {
      await call("visit", url);
    },
    back: async () => {
      await call("back");
    },
    forward: async () => {
      await call("forward");
    },
    scrollTo: async (opts) => {
      await call("scrollTo", { x: opts.x, y: opts.y, handle: opts.handle });
    },
    scrollBy: async (dy) => {
      await call("scrollBy", dy);
    },
    setField: async (handle, value) => coerceResult(await call("setField", handle, value).catch(fail)),
    click: async (handle) => coerceResult(await call("click", handle).catch(fail)),
    submit: async (handle) => coerceResult(await call("submit", handle).catch(fail)),
    rectFor: async (handle) => coerceRect(await call("rectFor", handle).catch(() => null)),
  };
}
