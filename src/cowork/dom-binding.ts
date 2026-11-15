/**
 * `bindCoworkDom`: report what the person types, so peers see it.
 *
 * A co-work session never reads the DOM on its own; a host reports edits with
 * `session.reportField(handle, value)`. This binds that for a page region: every
 * TRUSTED `input` / `change` from an element with a handle (`data-co-handle`,
 * `name` or `id`), including a contenteditable editing host, is reported,
 * throttled per handle with the final value always sent.
 *
 * Untrusted events are ignored. Those are the ones a script dispatches, which
 * includes the session applying a peer's write, so a mirrored value is never
 * echoed back. Masking stays the session's: a sensitive field's value is never
 * sent, only that it is active. React-free.
 */
import { attributeHandle, isEditableText } from "../dom-navigation/agent";
import type { CoworkSession } from "./session";

export type BindCoworkDomOptions = {
  /** The region to watch. Default `document`. */
  root?: EventTarget & ParentNode;
  /** Minimum gap between two reports of one handle; the last value always goes. Default 150 ms. */
  throttleMs?: number;
  /** Which events the person made. Default `event.isTrusted`. */
  isUserEvent?: (event: Event) => boolean;
};

type Pending = { value: unknown; timer: ReturnType<typeof setTimeout> | undefined; lastSent: number };

/** The element whose value an event changed: the editing host for a contenteditable. */
function fieldOf(target: EventTarget | null): Element | null {
  let el = target instanceof Element ? target : (target as Node | null)?.parentElement ?? null;
  if (!el) return null;
  // Inside a contenteditable, climb to its editing host (the element carrying the handle).
  while (el.parentElement && isEditableText(el.parentElement) && !attributeHandle(el)) el = el.parentElement;
  return el;
}

function valueOf(el: Element): unknown {
  const tag = el.tagName.toUpperCase();
  if (tag === "INPUT") {
    const input = el as HTMLInputElement;
    return input.type === "checkbox" || input.type === "radio" ? input.checked : input.value;
  }
  if (tag === "TEXTAREA" || tag === "SELECT") return (el as HTMLTextAreaElement | HTMLSelectElement).value;
  if (isEditableText(el)) return el.textContent ?? "";
  return undefined;
}

/** Start reporting the person's edits in `root`. Returns the function that stops it. */
export function bindCoworkDom(session: Pick<CoworkSession, "reportField">, options: BindCoworkDomOptions = {}): () => void {
  const root = options.root ?? (typeof document === "undefined" ? undefined : document);
  if (!root) return () => {};
  const throttleMs = Math.max(0, options.throttleMs ?? 150);
  const isUserEvent = options.isUserEvent ?? ((event: Event) => event.isTrusted);
  const pending = new Map<string, Pending>();

  const send = (handle: string, entry: Pending) => {
    entry.timer = undefined;
    entry.lastSent = Date.now();
    void session.reportField(handle, entry.value);
  };

  const onEdit = (event: Event) => {
    if (!isUserEvent(event)) return;
    const el = fieldOf(event.target);
    if (!el) return;
    const handle = attributeHandle(el);
    const value = valueOf(el);
    if (!handle || value === undefined) return;

    const entry = pending.get(handle) ?? { value, timer: undefined, lastSent: Number.NEGATIVE_INFINITY };
    entry.value = value;
    pending.set(handle, entry);
    if (entry.timer !== undefined) return; // A trailing send is already due; it takes the latest value.
    const wait = entry.lastSent + throttleMs - Date.now();
    if (wait <= 0) send(handle, entry);
    else entry.timer = setTimeout(() => send(handle, entry), wait);
  };

  // CAPTURE, not bubble: an editor (or a React onInput) that stops its own input event
  // from bubbling would otherwise hide every keystroke, and input/change fire after the
  // value changed, so capture already sees the final text.
  root.addEventListener("input", onEdit, true);
  root.addEventListener("change", onEdit, true);
  return () => {
    root.removeEventListener("input", onEdit, true);
    root.removeEventListener("change", onEdit, true);
    // FLUSH, never drop: a re-bind (React re-running the effect) or an unmount before the
    // trailing edge must still send the person's last value.
    for (const [handle, entry] of pending) {
      if (entry.timer === undefined) continue;
      clearTimeout(entry.timer);
      send(handle, entry);
    }
    pending.clear();
  };
}
