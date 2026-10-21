/**
 * The in-page half of DOM co-browsing: a framework-free walker that turns a
 * live document into a {@link PageSnapshot} of stable handles, and acts on
 * those handles.
 *
 * Extracted from px-ui-sandbox's CoBrowseProvider so a host that does NOT own
 * the page (Genie's browser, showing sites through an Electron
 * WebContentsView) can run the same walker, injected into an isolated world.
 *
 * Constraints this file holds, because the injected IIFE is built from it:
 *
 * - NO runtime imports. Type-only imports are erased; anything else would be
 *   bundled into a script that must run with no module loader.
 * - Nothing touches `document` / `window` until a method is called, so the
 *   script can be evaluated in a context with no DOM at all.
 * - Every result is plain, structured-cloneable data.
 *
 * Trust boundary: the page is hostile input. It controls every attribute,
 * label and text node read here. Two consequences:
 * - Sensitive values (passwords, card fields, one-time codes, anything marked
 *   `data-private`) are masked HERE, before anything leaves the page — the host
 *   cannot mask what it has already received.
 * - Handles are compared as plain strings, never spliced into a CSS selector,
 *   so a crafted handle cannot change what a lookup matches.
 */
import type { PageAction, PageSnapshot } from "../bridges/navigation";

/** Elements the walker considers actionable. */
export const INTERACTIVE =
  "a[href], button, input, select, textarea, [role=button], [role=link], [role=checkbox], [role=tab], [data-co-handle]";

/** Every method the in-page agent answers. The wire protocol is exactly this list. */
export const DOM_NAVIGATION_METHODS = [
  "getLocation",
  "describe",
  "read",
  "visit",
  "back",
  "forward",
  "scrollTo",
  "scrollBy",
  "setField",
  "click",
  "submit",
  "rectFor",
] as const;

export type DomNavigationMethod = (typeof DOM_NAVIGATION_METHODS)[number];

export type ActionResult = { ok: boolean; error?: string };
export type HandleRect = { x: number; y: number; width: number; height: number };

type FieldElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const tag = (el: Element) => el.tagName.toUpperCase();

export function isVisible(el: Element): boolean {
  const he = el as HTMLElement;
  if ((el as HTMLInputElement).type === "hidden") return false;
  if (he.hidden || he.getAttribute("aria-hidden") === "true") return false;
  return he.offsetParent !== null || he.getClientRects().length > 0;
}

/** Sensitive fields whose value is never read into the snapshot. */
export function isSensitive(el: Element): boolean {
  const input = el as HTMLInputElement;
  const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  return (
    input.type === "password" ||
    ac.startsWith("cc-") ||
    ac === "one-time-code" ||
    el.hasAttribute("data-private")
  );
}

/** True when this node, or any element containing it, is sensitive. */
function insideSensitive(node: Node): boolean {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (isSensitive(el)) return true;
  }
  return false;
}

/** textContent, minus any text that sits inside a sensitive element. */
function safeText(root: Node): string {
  const doc = root.ownerDocument ?? (root as Document);
  // NodeFilter.SHOW_TEXT === 4; the literal avoids depending on a NodeFilter global.
  const walker = doc.createTreeWalker(root, 4);
  let out = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!insideSensitive(n)) out += n.nodeValue ?? "";
  }
  return out;
}

export function roleOf(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const t = tag(el);
  if (t === "A") return "link";
  if (t === "BUTTON") return "button";
  if (t === "SELECT") return "select";
  if (t === "TEXTAREA") return "textbox";
  if (t === "INPUT") {
    const type = (el as HTMLInputElement).type;
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "submit" || type === "button") return "button";
    return "textbox";
  }
  return "generic";
}

function labelFor(doc: Document, id: string): Element | null {
  // Equivalent to querySelector(`label[for="${CSS.escape(id)}"]`) — first match
  // in document order — without building a selector from page-controlled text.
  for (const lbl of Array.from(doc.querySelectorAll("label[for]"))) {
    if (lbl.getAttribute("for") === id) return lbl;
  }
  return null;
}

export function accessibleName(el: Element): string {
  const doc = el.ownerDocument;
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    const txt = labelledby
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    if (txt) return txt;
  }
  const id = el.getAttribute("id");
  if (id) {
    const lbl = labelFor(doc, id);
    if (lbl?.textContent?.trim()) return lbl.textContent.trim();
  }
  const wrapping = el.closest("label");
  if (wrapping) {
    const txt = safeText(wrapping).trim();
    if (txt) return txt;
  }
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return placeholder.trim();
  // A sensitive field's own text is its value (a textarea's content), so it is
  // never used as its name.
  const text = isSensitive(el) ? "" : (el as HTMLElement).textContent?.trim();
  if (text) return text.replace(/\s+/g, " ").slice(0, 80);
  return el.getAttribute("name") ?? el.getAttribute("id") ?? roleOf(el);
}

export function isDestructive(el: Element, label: string): boolean {
  if (el.hasAttribute("data-co-confirm")) return true;
  if ((el as HTMLInputElement).type === "submit") return true;
  if (tag(el) === "BUTTON" && (el as HTMLButtonElement).type === "submit") return true;
  return /\b(delete|remove|destroy|sign out|log ?out|cancel subscription|deactivate)\b/i.test(label);
}

/**
 * The element's own stable handle: data-co-handle → name → id, or "" when it
 * has none. An EMPTY attribute counts as absent — `button.name` is `""`, not
 * null, on every button, anchor and input without one, so a plain `??` chain
 * never reaches the id.
 */
export function attributeHandle(el: Element): string {
  return (
    el.getAttribute("data-co-handle") ||
    el.getAttribute("name") ||
    el.getAttribute("id") ||
    ""
  );
}

/**
 * Build a fresh snapshot + a handle→element registry. Handle preference:
 * data-co-handle → name → id → `role#index` (stable within a snapshot).
 */
export function walk(doc: Document = document): { snapshot: PageSnapshot; registry: Map<string, Element> } {
  const registry = new Map<string, Element>();
  const actions: PageAction[] = [];
  const seen = new Set<Element>();
  let synthetic = 0;

  for (const el of Array.from(doc.querySelectorAll(INTERACTIVE))) {
    if (seen.has(el) || !isVisible(el)) continue;
    seen.add(el);
    const label = accessibleName(el);
    const role = roleOf(el);
    let handle = attributeHandle(el);
    if (!handle || registry.has(handle)) handle = `${role}#${synthetic++}`;
    registry.set(handle, el);

    let value: unknown;
    if (role === "textbox" || role === "select") {
      value = isSensitive(el) ? undefined : (el as HTMLInputElement).value;
    } else if (role === "checkbox" || role === "radio") {
      value = (el as HTMLInputElement).checked;
    }

    const action: PageAction = { handle, role, label, destructive: isDestructive(el, label) };
    if (value !== undefined) action.value = value;
    actions.push(action);
  }

  const loc = doc.defaultView?.location;
  return {
    snapshot: { url: loc ? loc.pathname + loc.search : "", title: doc.title, actions },
    registry,
  };
}

function isField(el: Element): el is FieldElement {
  const t = tag(el);
  return t === "INPUT" || t === "TEXTAREA" || t === "SELECT";
}

/**
 * Set a field's value so a React-controlled input sees the change: call the
 * PROTOTYPE setter (React shadows `value` on the instance with its value
 * tracker), then dispatch bubbling `input` + `change`.
 */
export function setNativeValue(el: FieldElement, value: unknown): void {
  const view = (el.ownerDocument.defaultView ?? globalThis) as typeof globalThis;
  const fire = () => {
    el.dispatchEvent(new view.Event("input", { bubbles: true }));
    el.dispatchEvent(new view.Event("change", { bubbles: true }));
  };
  const t = tag(el);
  if (t === "INPUT" && ((el as HTMLInputElement).type === "checkbox" || (el as HTMLInputElement).type === "radio")) {
    const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "checked")?.set;
    setter?.call(el, Boolean(value));
    fire();
    return;
  }
  const proto =
    t === "TEXTAREA"
      ? view.HTMLTextAreaElement.prototype
      : t === "SELECT"
        ? view.HTMLSelectElement.prototype
        : view.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, String(value));
  fire();
}

/** Visible text / heading outline, with sensitive text removed. */
export function readPage(doc: Document = document): string {
  const main = doc.querySelector("main") ?? doc.body;
  if (!main) return doc.title;
  const heads = Array.from(main.querySelectorAll("h1, h2, h3"))
    .map((h) => `${h.tagName}: ${safeText(h).trim()}`)
    .filter(Boolean);
  const text = safeText(main).replace(/\s+/g, " ").trim().slice(0, 4000);
  return [doc.title, ...heads, "", text].join("\n");
}

export type DomNavigationAgentOptions = {
  /** Document to drive. Default: the global `document`, read lazily. */
  document?: Document;
  /**
   * Called just before the agent acts on the page — before resolving a field
   * for `setField`, and after resolving (only when the element exists) for
   * `click` / `submit`. The sandbox uses it to attribute the request an action
   * causes to the agent.
   */
  beforeAction?: (action: "setField" | "click" | "submit") => void;
};

export type DomNavigationAgent = {
  getLocation(): { url: string; title: string };
  describe(): PageSnapshot;
  read(): string;
  /** Navigate. Only http(s) or same-site paths; deferred a tick so a remote call returns first. */
  visit(url: string): void;
  back(): void;
  forward(): void;
  scrollTo(opts: { x?: number; y?: number; handle?: string }): void;
  scrollBy(dy: number): void;
  setField(handle: string, value: unknown): ActionResult;
  click(handle: string): ActionResult;
  submit(handle: string): ActionResult;
  rectFor(handle: string): HandleRect | null;
  /** Element for a handle: this snapshot's registry, then a live attribute lookup. */
  resolve(handle: string): Element | null;
  /** Serialisable dispatch — what the injected script exposes to a host. */
  call(method: DomNavigationMethod, args?: unknown[]): unknown;
};

function findByAttribute(doc: Document, attr: string, value: string): Element | null {
  for (const el of Array.from(doc.querySelectorAll(`[${attr}]`))) {
    if (el.getAttribute(attr) === value) return el;
  }
  return null;
}

const num = (v: unknown) => (typeof v === "number" ? v : undefined);

export function createDomNavigationAgent(options: DomNavigationAgentOptions = {}): DomNavigationAgent {
  let registry = new Map<string, Element>();
  const doc = () => options.document ?? document;
  const win = () => (doc().defaultView ?? window) as Window;
  const before = (action: "setField" | "click" | "submit") => options.beforeAction?.(action);

  const resolve = (handle: string): Element | null => {
    const hit = registry.get(handle);
    if (hit && hit.isConnected) return hit;
    // Fallback: a real attribute handle the agent may use before describe().
    const d = doc();
    return (
      findByAttribute(d, "data-co-handle", handle) ??
      findByAttribute(d, "name", handle) ??
      d.getElementById(handle)
    );
  };

  const agent: DomNavigationAgent = {
    getLocation: () => {
      const loc = win().location;
      return { url: loc.pathname + loc.search, title: doc().title };
    },
    describe: () => {
      const res = walk(doc());
      registry = res.registry;
      return res.snapshot;
    },
    read: () => readPage(doc()),
    visit: (url) => {
      const w = win();
      const target = new URL(String(url), w.location.href);
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        throw new Error(`Refusing to navigate to a '${target.protocol}' URL.`);
      }
      w.setTimeout(() => w.location.assign(target.href), 0);
    },
    back: () => win().history.back(),
    forward: () => win().history.forward(),
    scrollTo: ({ x, y, handle }) => {
      const w = win();
      if (handle) {
        resolve(handle)?.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      w.scrollTo({ left: x ?? w.scrollX, top: y ?? w.scrollY, behavior: "smooth" });
    },
    scrollBy: (dy) => win().scrollBy({ top: dy, behavior: "smooth" }),
    setField: (handle, value) => {
      before("setField");
      const el = resolve(handle);
      if (!el) return { ok: false, error: `No element for handle "${handle}"` };
      if (isField(el)) {
        setNativeValue(el, value);
        return { ok: true };
      }
      return { ok: false, error: `Handle "${handle}" is not a form field` };
    },
    click: (handle) => {
      const el = resolve(handle);
      if (!el) return { ok: false, error: `No element for handle "${handle}"` };
      // Before the click: an Inertia link fires its visit synchronously inside click().
      before("click");
      (el as HTMLElement).click();
      return { ok: true };
    },
    submit: (handle) => {
      const el = resolve(handle);
      if (!el) return { ok: false, error: `No element for handle "${handle}"` };
      const form = (tag(el) === "FORM" ? el : el.closest("form")) as HTMLFormElement | null;
      if (!form) return { ok: false, error: `Handle "${handle}" is not inside a form` };
      before("submit");
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
      return { ok: true };
    },
    rectFor: (handle) => {
      const el = resolve(handle);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    },
    resolve,
    call: (method, args = []) => {
      const a = Array.isArray(args) ? args : [];
      const handle = String(a[0] ?? "");
      switch (method) {
        case "getLocation":
          return agent.getLocation();
        case "describe":
          return agent.describe();
        case "read":
          return agent.read();
        case "visit":
          agent.visit(String(a[0] ?? ""));
          return undefined;
        case "back":
          agent.back();
          return undefined;
        case "forward":
          agent.forward();
          return undefined;
        case "scrollTo": {
          const o = (a[0] && typeof a[0] === "object" ? a[0] : {}) as Record<string, unknown>;
          agent.scrollTo({
            x: num(o.x),
            y: num(o.y),
            handle: typeof o.handle === "string" ? o.handle : undefined,
          });
          return undefined;
        }
        case "scrollBy":
          agent.scrollBy(Number(a[0] ?? 0));
          return undefined;
        case "setField":
          return agent.setField(handle, a[1]);
        case "click":
          return agent.click(handle);
        case "submit":
          return agent.submit(handle);
        case "rectFor":
          return agent.rectFor(handle);
        default:
          throw new Error(`Unknown dom-navigation method: ${String(method)}`);
      }
    },
  };
  return agent;
}
