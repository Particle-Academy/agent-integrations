/**
 * `@particle-academy/agent-integrations/dom-navigation/script`
 *
 * The in-page walker as one self-contained script string — no imports, no
 * module system — for a host to inject into a page it does not own:
 *
 *   await webContents.executeJavaScriptInIsolatedWorld(worldId, [{ code: DOM_NAVIGATION_SCRIPT }]);
 *
 * Built at package build time from ./inject.ts (see
 * scripts/dom-navigation-inject-plugin.ts). Its own subpath so a host process
 * that only injects never loads the walker as a module, and vice versa.
 */
import source from "virtual:dom-navigation-inject";

export const DOM_NAVIGATION_SCRIPT: string = source;
