/**
 * Real input blocking for co-work control.
 *
 * While someone else has control of this person's view (a higher rank acted
 * within `idleMs`, or the baton is elsewhere), the person's own keyboard and
 * pointer presses are swallowed before the page sees them. Pointer MOVEMENT stays
 * free, so their cursor still moves and peers still see it.
 *
 * Only events the browser marks trusted are blocked, which is what makes this
 * safe to leave on: the controlling peer's intents land through the navigation
 * adapter, which dispatches untrusted events, so they still reach the page.
 *
 * React-free and DOM-only. The session installs it; a host can use it directly.
 */

/**
 * Every event the person uses to change the page. Pointer movement, hover and
 * focus events are deliberately absent.
 */
export const BLOCKED_EVENTS: readonly string[] = Object.freeze([
  "keydown",
  "keypress",
  "keyup",
  "beforeinput",
  "input",
  "compositionstart",
  "paste",
  "cut",
  "drop",
  "dragstart",
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "touchstart",
  "touchend",
  "wheel",
  "submit",
]);

/** Mark a co-work control surface with this attribute and input inside it is never blocked. */
export const CONTROL_ATTRIBUTE = "data-cowork-control";

export type InputBlockerOptions = {
  /** Where to listen, capturing. Default `document`. */
  target?: EventTarget;
  /** Read on EVERY event, so a hand-back takes effect the moment the clock passes it. */
  isBlocked: () => boolean;
  /** Which events the person made. Default `event.isTrusted`. */
  isUserEvent?: (event: Event) => boolean;
  /** Called for each swallowed event, e.g. to flash the banner. */
  onBlocked?: (event: Event) => void;
};

export interface InputBlocker {
  destroy(): void;
}

export function createInputBlocker(options: InputBlockerOptions): InputBlocker {
  const target = options.target ?? (typeof document === "undefined" ? undefined : document);
  if (!target) return { destroy() {} };
  const isUserEvent = options.isUserEvent ?? ((event: Event) => event.isTrusted);

  const handler = (event: Event) => {
    if (!isUserEvent(event)) return;
    // The session's own controls (revoke, release, request) stay usable: a blocked
    // owner must be able to take their view back.
    const origin = event.target as { closest?: (selector: string) => unknown } | null;
    if (origin && typeof origin.closest === "function" && origin.closest(`[${CONTROL_ATTRIBUTE}]`)) return;
    let blocked: boolean;
    try {
      blocked = options.isBlocked() === true;
    } catch {
      blocked = true; // A check that cannot answer is closed.
    }
    if (!blocked) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try { options.onBlocked?.(event); } catch { /* A host callback cannot reopen the block. */ }
  };

  const listen = { capture: true, passive: false } as const;
  for (const type of BLOCKED_EVENTS) target.addEventListener(type, handler, listen);
  let destroyed = false;
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const type of BLOCKED_EVENTS) target.removeEventListener(type, handler, listen);
    },
  };
}
