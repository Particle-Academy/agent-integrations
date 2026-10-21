/**
 * Entry for the injectable IIFE (bundled by scripts/dom-navigation-inject-plugin.ts
 * into the string `DOM_NAVIGATION_SCRIPT`). Evaluating it installs
 * `globalThis.__fancyDomNavigation = { protocol, call(method, args) }` in the
 * world it runs in. Re-evaluating it is a no-op, so a host may inject on every
 * `dom-ready` without losing the handle registry of the current document.
 *
 * Kept to literals rather than importing ./remote's constants, so the IIFE
 * contains only the walker.
 */
import { createDomNavigationAgent, type DomNavigationMethod } from "./agent";

const KEY = "__fancyDomNavigation";
const PROTOCOL = 1;

const g = globalThis as unknown as Record<string, { protocol?: number } | undefined>;
const existing = g[KEY];
if (!existing || existing.protocol !== PROTOCOL) {
  const agent = createDomNavigationAgent();
  Object.defineProperty(globalThis, KEY, {
    configurable: true,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      protocol: PROTOCOL,
      call: (method: DomNavigationMethod, args?: unknown[]) => agent.call(method, args),
    }),
  });
}
