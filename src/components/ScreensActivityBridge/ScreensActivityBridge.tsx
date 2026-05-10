import { useEffect } from "react";
import { onActivity } from "../../presence/registry";

/**
 * Loose shape of the fancy-screens system context — kept here so this
 * component doesn't hard-import `@particle-academy/fancy-screens`.
 */
type ScreenSystemLike = {
  registry: Map<string, { id: string; agentActivity?: unknown }>;
  updateScreen: (id: string, patch: { agentActivity?: unknown }) => void;
};

export type ScreensActivityBridgeProps = {
  /** The value returned by `useScreenSystem()` from fancy-screens. */
  system: ScreenSystemLike;
  /** ms to wait after the last activity before clearing the screen's badge. Default 1500. */
  fadeMs?: number;
};

/**
 * ScreensActivityBridge — subscribe to the in-process activity registry
 * and patch each event into the matching screen's `agentActivity` field.
 * Fade-out clears the badge after `fadeMs`.
 *
 * Use it once near the root of your app, ABOVE every <Screen>:
 *
 *   const system = useScreenSystem();
 *   <>
 *     <ScreensActivityBridge system={system} />
 *     <Screen id="dashboard">…</Screen>
 *     <Screen id="form">…</Screen>
 *   </>
 *
 * Renders nothing; pure side-effect component.
 */
export function ScreensActivityBridge({ system, fadeMs = 1500 }: ScreensActivityBridgeProps) {
  useEffect(() => {
    const fadeTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const off = onActivity((event) => {
      const screenId = event.target.screenId;
      if (!screenId) return;
      // Only patch screens that are currently registered.
      if (!system.registry.has(screenId)) return;
      const activity = {
        agentId: event.agentId,
        agentName: event.agentName,
        agentColor: event.agentColor,
        action: event.action,
        timestamp: event.timestamp,
        elementId: event.target.elementId,
        label: event.target.label,
      };
      system.updateScreen(screenId, { agentActivity: activity });
      const prev = fadeTimers.get(screenId);
      if (prev) clearTimeout(prev);
      fadeTimers.set(
        screenId,
        setTimeout(() => {
          system.updateScreen(screenId, { agentActivity: null });
          fadeTimers.delete(screenId);
        }, event.ttlMs ?? fadeMs),
      );
    });
    return () => {
      off();
      for (const t of fadeTimers.values()) clearTimeout(t);
    };
  }, [system, fadeMs]);
  return null;
}
