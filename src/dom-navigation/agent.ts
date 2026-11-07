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
 *
 * Off-limits areas (`data-agent-off-limits`, or a host `exclude` selector) are
 * a third: the agent learns an area EXISTS and its role, and nothing else, and
 * every action whose target resolves inside one is refused. The check runs at
 * action time against the live element, so a stale or forged handle is
 * refused the same way. The README's "Off-limits areas" section is the spec.
 */
import type { OffLimitsArea, PageAction, PageReadout, PageSnapshot } from "../bridges/navigation";

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
  "guard",
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

// ───────────── Off-limits areas ─────────────

/** The marker. Presence is the test: any value, including "" and "false", fences. */
export const OFF_LIMITS_ATTRIBUTE = "data-agent-off-limits";

/** The refusal every fenced action returns. A plain sentence, safe to show a person. */
export const OFF_LIMITS_ERROR = "That part of the page is off-limits to agents, so only the person can use it.";

/** Longest purpose (the attribute's value) reported for an area. */
const PURPOSE_MAX = 40;

export type OffLimitsOptions = {
  /** Host selector(s) fenced exactly like the attribute, descendants included. */
  exclude?: string | string[];
  /**
   * The agent runs in a frame whose embedding element it cannot read (a
   * cross-origin parent), so it cannot tell whether that element is fenced.
   * "refuse" (default) treats the whole document as off-limits; "allow" trusts
   * the embedder. Has no effect in a top-level document.
   */
  opaqueEmbedder?: "refuse" | "allow";
};

/** Every action the fence is asked about. */
export type GuardedAction = "setField" | "click" | "submit" | "focus" | "scrollTo";
const GUARDED_ACTIONS = new Set<string>(["setField", "click", "submit", "focus", "scrollTo"]);

/** Is `el` itself a fence (marker, or an exclude match)? Throws on an invalid selector. */
type Fence = { self(el: Element): boolean; within(node: Node): boolean };

/**
 * The element containing `node` in the COMPOSED tree: the parent element, else
 * a shadow root's host, else (at the top of a document) the frame element that
 * embeds it. `"opaque"` when the document is embedded by a parent it cannot read.
 */
function composedParent(node: Node): Element | null | "opaque" {
  if (node.parentElement) return node.parentElement;
  const parent = node.parentNode;
  if (parent && (parent as ShadowRoot).host && parent.nodeType === 11) return (parent as ShadowRoot).host;
  const doc = parent && parent.nodeType === 9 ? (parent as Document) : node.nodeType === 9 ? (node as Document) : null;
  if (!doc) return null;
  const win = doc.defaultView;
  if (!win) return null;
  let frame: Element | null = null;
  let embedded = false;
  try {
    embedded = win.parent !== win;
    frame = win.frameElement;
  } catch {
    frame = null;
  }
  if (frame) return frame;
  return embedded ? "opaque" : null;
}

function makeFence(options: OffLimitsOptions = {}): Fence {
  const selectors = (Array.isArray(options.exclude) ? options.exclude : options.exclude ? [options.exclude] : [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const opaqueFenced = options.opaqueEmbedder !== "allow";
  const self = (el: Element) => {
    if (el.hasAttribute(OFF_LIMITS_ATTRIBUTE)) return true;
    for (const s of selectors) if (el.matches(s)) return true; // an invalid selector throws: fail closed, loudly
    return false;
  };
  const within = (node: Node) => {
    let cur: Node | null = node.nodeType === 1 ? node : null;
    if (!cur) {
      const p = composedParent(node);
      if (p === "opaque") return opaqueFenced;
      cur = p;
    }
    while (cur) {
      if (self(cur as Element)) return true;
      const p = composedParent(cur);
      if (p === "opaque") return opaqueFenced;
      cur = p;
    }
    return false;
  };
  return { self, within };
}

const DEFAULT_FENCE = makeFence();

/**
 * True when `el` sits inside an off-limits area: it, or any element containing
 * it in the composed tree (through open shadow roots and same-origin frames),
 * carries {@link OFF_LIMITS_ATTRIBUTE} or matches an `exclude` selector.
 */
export function isOffLimits(el: Element, options?: OffLimitsOptions): boolean {
  return (options ? makeFence(options) : DEFAULT_FENCE).within(el);
}

function idTargets(el: Element, attr: string): Element[] {
  const raw = el.getAttribute(attr);
  if (!raw) return [];
  const root = el.getRootNode() as Document | ShadowRoot;
  const byId = (id: string) =>
    typeof root.getElementById === "function" ? root.getElementById(id) : el.ownerDocument.getElementById(id);
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map(byId)
    .filter((t): t is HTMLElement => t !== null);
}

/** A form is fenced when it, any field it owns (form= included), or anything inside it is fenced. */
function formTouchesFence(form: HTMLFormElement, fence: Fence): boolean {
  if (fence.within(form)) return true;
  for (const field of Array.from(form.elements)) if (fence.within(field)) return true;
  for (const el of Array.from(form.querySelectorAll("*"))) if (fence.self(el)) return true;
  return false;
}

/** The form a click on `el` would submit or reset, if any. */
function formActivatedBy(el: Element): HTMLFormElement | null {
  const t = tag(el);
  const type = ((el as HTMLInputElement).type ?? "").toLowerCase();
  if (t === "BUTTON" && (type === "submit" || type === "reset")) return (el as HTMLButtonElement).form;
  if (t === "INPUT" && (type === "submit" || type === "reset" || type === "image")) return (el as HTMLInputElement).form;
  return null;
}

/** Radios sharing `el`'s group: checking one unchecks the others. */
function radioGroup(el: Element): Element[] {
  const input = el as HTMLInputElement;
  if (tag(el) !== "INPUT" || input.type !== "radio" || !input.name) return [];
  const scope: ParentNode = input.form ?? (el.getRootNode() as Document | ShadowRoot);
  return Array.from(scope.querySelectorAll("input[type=radio]")).filter(
    (r) => (r as HTMLInputElement).name === input.name && (r as HTMLInputElement).form === input.form,
  );
}

/**
 * Would acting on `el` reach inside an off-limits area? Resolves every element
 * the action ACTIVATES, not just the one named: a label's control, an ancestor
 * label's control, aria-controls / popovertarget / commandfor targets, the form
 * a submit, reset or image button submits, and a radio's whole group.
 */
function reachesFence(action: GuardedAction, el: Element, fence: Fence): boolean {
  if (fence.within(el)) return true;
  if (action === "focus" || action === "scrollTo") return false;
  if (action === "submit") {
    const form = (tag(el) === "FORM" ? el : ((el as HTMLInputElement).form ?? el.closest("form"))) as HTMLFormElement | null;
    return form ? formTouchesFence(form, fence) : false;
  }
  const targets: Element[] = [];
  if (action === "click") {
    for (const label of [el, el.closest("label")]) {
      if (label && tag(label) === "LABEL") {
        const control = (label as HTMLLabelElement).control;
        if (control) targets.push(control);
      }
    }
    for (const attr of ["aria-controls", "popovertarget", "commandfor"]) targets.push(...idTargets(el, attr));
    const form = formActivatedBy(el);
    if (form && formTouchesFence(form, fence)) return true;
  }
  targets.push(...radioGroup(el));
  return targets.some((t) => fence.within(t));
}

const IMPLICIT_AREA_ROLE: Record<string, string> = {
  DIALOG: "dialog",
  FORM: "form",
  SECTION: "region",
  ASIDE: "complementary",
  NAV: "navigation",
  HEADER: "banner",
  FOOTER: "contentinfo",
  MAIN: "main",
  BUTTON: "button",
  A: "link",
  IFRAME: "frame",
};

/** What `describe()` says about an area: its role and its purpose. Never its content. */
function describeArea(el: Element): OffLimitsArea {
  const explicit = (el.getAttribute("role") ?? "").trim().split(/\s+/)[0];
  const role = explicit || IMPLICIT_AREA_ROLE[tag(el)] || "area";
  const purpose = (el.getAttribute(OFF_LIMITS_ATTRIBUTE) ?? "").replace(/\s+/g, " ").trim().slice(0, PURPOSE_MAX);
  const area: OffLimitsArea = { role };
  if (purpose && purpose.toLowerCase() !== "false" && purpose.toLowerCase() !== "true") area.purpose = purpose;
  return area;
}

/** Hide-predicate for text: sensitive, or inside an off-limits area. */
type TextFilter = (textNode: Node) => boolean;
const sensitiveOnly: TextFilter = (n) => insideSensitive(n);
const withFence =
  (fence: Fence): TextFilter =>
  (n) =>
    insideSensitive(n) || fence.within(n);

/** textContent, minus any text that sits inside a sensitive element (or a fenced one). */
function safeText(root: Node, hide: TextFilter = sensitiveOnly): string {
  const doc = root.ownerDocument ?? (root as Document);
  // NodeFilter.SHOW_TEXT === 4; the literal avoids depending on a NodeFilter global.
  const walker = doc.createTreeWalker(root, 4);
  let out = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!hide(n)) out += n.nodeValue ?? "";
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

/**
 * The element's accessible name. Text inside an off-limits area never
 * contributes, so an element outside one cannot carry the area's words out
 * through `aria-labelledby`, a `<label for>` or its own text.
 */
export function accessibleName(el: Element, options?: OffLimitsOptions): string {
  return nameOf(el, options ? makeFence(options) : DEFAULT_FENCE);
}

function nameOf(el: Element, fence: Fence): string {
  const doc = el.ownerDocument;
  const visibleText = (node: Element) => safeText(node, (n) => fence.within(n));
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    const txt = labelledby
      .split(/\s+/)
      .map((id) => {
        const target = doc.getElementById(id);
        return target ? visibleText(target) : "";
      })
      .join(" ")
      .trim();
    if (txt) return txt;
  }
  const id = el.getAttribute("id");
  if (id) {
    const lbl = labelFor(doc, id);
    const txt = lbl ? visibleText(lbl).trim() : "";
    if (txt) return txt;
  }
  const wrapping = el.closest("label");
  if (wrapping) {
    const txt = safeText(wrapping, withFence(fence)).trim();
    if (txt) return txt;
  }
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return placeholder.trim();
  // A sensitive field's own text is its value (a textarea's content), so it is
  // never used as its name.
  const text = isSensitive(el) ? "" : visibleText(el).trim();
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
export function walk(
  doc: Document = document,
  options?: OffLimitsOptions,
): { snapshot: PageSnapshot; registry: Map<string, Element> } {
  return walkFenced(doc, options ? makeFence(options) : DEFAULT_FENCE, options);
}

/** The outermost visible off-limits areas: what exists, never what is inside. */
function offLimitsAreas(doc: Document, fence: Fence, options?: OffLimitsOptions): OffLimitsArea[] {
  const selectors = (Array.isArray(options?.exclude) ? options.exclude : options?.exclude ? [options.exclude] : [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const candidates = new Set<Element>(Array.from(doc.querySelectorAll(`[${OFF_LIMITS_ATTRIBUTE}]`)));
  for (const s of selectors) for (const el of Array.from(doc.querySelectorAll(s))) candidates.add(el);
  const areas: OffLimitsArea[] = [];
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    if (!candidates.has(el) || !isVisible(el)) continue;
    const parent = composedParent(el);
    if (parent && parent !== "opaque" && fence.within(parent)) continue; // nested: its outer area is reported
    areas.push(describeArea(el));
  }
  // The whole document is fenced (an unreadable embedder, or a marker on <html>).
  if (areas.length === 0 && doc.documentElement && fence.within(doc.documentElement)) areas.push({ role: "document" });
  return areas;
}

function walkFenced(
  doc: Document,
  fence: Fence,
  options?: OffLimitsOptions,
): { snapshot: PageSnapshot; registry: Map<string, Element> } {
  const registry = new Map<string, Element>();
  const actions: PageAction[] = [];
  const seen = new Set<Element>();
  let synthetic = 0;
  const offLimits = offLimitsAreas(doc, fence, options);

  for (const el of Array.from(doc.querySelectorAll(INTERACTIVE))) {
    if (seen.has(el) || !isVisible(el)) continue;
    seen.add(el);
    // Inside an area, or activating something inside one: not an action at all.
    if (reachesFence("click", el, fence)) continue;
    const label = nameOf(el, fence);
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
  const snapshot: PageSnapshot = { url: loc ? loc.pathname + loc.search : "", title: doc.title, actions };
  if (offLimits.length > 0) snapshot.offLimits = offLimits;
  return { snapshot, registry };
}

function isField(el: Element): el is FieldElement {
  const t = tag(el);
  return t === "INPUT" || t === "TEXTAREA" || t === "SELECT";
}

/**
 * Set a field's value so a React-controlled input sees the change.
 *
 * - Text, textarea, select: call the PROTOTYPE `value` setter (React shadows
 *   `value` on the instance with its value tracker), then dispatch bubbling
 *   `input` + `change`.
 * - Checkbox, radio: React's onChange for these listens to `click`, not
 *   `input` / `change`, so the write is a real `click()` — the browser toggles
 *   the box and fires click, input and change itself. Only when the state
 *   actually differs, so setting the current value is a no-op rather than a
 *   toggle. A radio cannot be unchecked by clicking it; that one case falls
 *   back to the setter.
 */
export function setNativeValue(el: FieldElement, value: unknown): void {
  const view = (el.ownerDocument.defaultView ?? globalThis) as typeof globalThis;
  const fire = () => {
    el.dispatchEvent(new view.Event("input", { bubbles: true }));
    el.dispatchEvent(new view.Event("change", { bubbles: true }));
  };
  const t = tag(el);
  if (t === "INPUT" && ((el as HTMLInputElement).type === "checkbox" || (el as HTMLInputElement).type === "radio")) {
    const input = el as HTMLInputElement;
    const want = Boolean(value);
    if (input.checked === want) return;
    if (input.type === "checkbox" || want) {
      input.click();
      return;
    }
    const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "checked")?.set;
    setter?.call(el, false);
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

/**
 * Visible text / heading outline, with sensitive text and every off-limits
 * area removed. Structured, so the bridge can render each page-supplied string
 * on its own single line.
 */
export function readPage(doc: Document = document, options?: OffLimitsOptions): PageReadout {
  return readFenced(doc, options ? makeFence(options) : DEFAULT_FENCE);
}

function readFenced(doc: Document, fence: Fence): PageReadout {
  const main = doc.querySelector("main") ?? doc.body;
  if (!main) return { title: doc.title, headings: [], text: "" };
  const hide = withFence(fence);
  const headings = Array.from(main.querySelectorAll("h1, h2, h3"))
    .filter((h) => !fence.within(h))
    .map((h) => ({
      level: Number(h.tagName.slice(1)),
      text: safeText(h, hide).trim(),
    }));
  const text = safeText(main, hide).replace(/\s+/g, " ").trim().slice(0, 4000);
  return { title: doc.title, headings, text };
}

export type DomNavigationAgentOptions = OffLimitsOptions & {
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
  read(): PageReadout;
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
  /**
   * Would `action` on `handle` reach inside an off-limits area? `{ ok: false,
   * error }` when it would. Pass it as the bridge adapter's `guard`, so the
   * bridge refuses before `pendingMode` stages anything. An unknown handle is
   * `{ ok: true }`: the action itself reports that it found nothing.
   */
  guard(action: GuardedAction, handle: string): ActionResult;
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
  const fence = makeFence(options);

  /**
   * The fence, checked against the LIVE element at action time — never a
   * describe-time verdict — so a handle captured before the marker appeared, or
   * one the agent was never shown, is refused the same way. A fence that cannot
   * be evaluated (an invalid `exclude` selector) refuses rather than ignores.
   */
  const refusal = (action: GuardedAction, el: Element): string | null => {
    try {
      return reachesFence(action, el, fence) ? OFF_LIMITS_ERROR : null;
    } catch (e) {
      return `The off-limits check could not run, so the action was refused: ${e instanceof Error ? e.message : String(e)}`;
    }
  };

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
      const res = walkFenced(doc(), fence, options);
      registry = res.registry;
      return res.snapshot;
    },
    read: () => readFenced(doc(), fence),
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
        const el = resolve(handle);
        if (!el) return;
        const refused = refusal("scrollTo", el);
        if (refused) throw new Error(refused);
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      w.scrollTo({ left: x ?? w.scrollX, top: y ?? w.scrollY, behavior: "smooth" });
    },
    scrollBy: (dy) => win().scrollBy({ top: dy, behavior: "smooth" }),
    setField: (handle, value) => {
      before("setField");
      const el = resolve(handle);
      if (!el) return { ok: false, error: `No element for handle "${handle}"` };
      const refused = refusal("setField", el);
      if (refused) return { ok: false, error: refused };
      if (isField(el)) {
        setNativeValue(el, value);
        return { ok: true };
      }
      return { ok: false, error: `Handle "${handle}" is not a form field` };
    },
    click: (handle) => {
      const el = resolve(handle);
      if (!el) return { ok: false, error: `No element for handle "${handle}"` };
      const refused = refusal("click", el);
      if (refused) return { ok: false, error: refused };
      // Before the click: an Inertia link fires its visit synchronously inside click().
      before("click");
      (el as HTMLElement).click();
      return { ok: true };
    },
    submit: (handle) => {
      const el = resolve(handle);
      if (!el) return { ok: false, error: `No element for handle "${handle}"` };
      const refused = refusal("submit", el);
      if (refused) return { ok: false, error: refused };
      // The form the element belongs to: its `form` owner (which honours form=), else its ancestor.
      const form = (tag(el) === "FORM" ? el : ((el as HTMLInputElement).form ?? el.closest("form"))) as HTMLFormElement | null;
      if (!form) return { ok: false, error: `Handle "${handle}" is not inside a form` };
      before("submit");
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
      return { ok: true };
    },
    rectFor: (handle) => {
      const el = resolve(handle);
      // No rect into an area: the agent's cursor and focus ring never point inside one.
      if (!el || refusal("focus", el)) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    },
    guard: (action, handle) => {
      const el = resolve(handle);
      if (!el) return { ok: true };
      const refused = refusal(action, el);
      return refused ? { ok: false, error: refused } : { ok: true };
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
        case "guard": {
          const action = String(a[0] ?? "");
          if (!GUARDED_ACTIONS.has(action)) return { ok: false, error: `Unknown guarded action: ${action}` };
          return agent.guard(action as GuardedAction, String(a[1] ?? ""));
        }
        default:
          throw new Error(`Unknown dom-navigation method: ${String(method)}`);
      }
    },
  };
  return agent;
}
