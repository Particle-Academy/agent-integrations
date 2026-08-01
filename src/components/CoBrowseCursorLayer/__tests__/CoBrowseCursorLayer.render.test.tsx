// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { CoBrowseCursorLayer } from "../CoBrowseCursorLayer";
import { emitActivity, resetActivityRegistry } from "../../../presence/registry";

/**
 * A cursor that renders and then never moves is not presence — it is a bug
 * report. It appeared on `agent_connected` alone, parking a motionless pointer
 * captioned "Agent connected" in the middle of the viewport for a session in
 * which the agent had made no tool call at all, which reads exactly like a
 * hung agent.
 */
const tool = (label: string, rect?: { x: number; y: number; width: number; height: number }) =>
  emitActivity({
    agentId: "agent",
    agentName: "Agent",
    action: "page_focus",
    timestamp: Date.now(),
    target: { kind: "navigation", label },
    meta: rect ? { rect } : undefined,
  });

afterEach(cleanup);
beforeEach(() => resetActivityRegistry());

describe("CoBrowseCursorLayer", () => {
  it("renders nothing for a connected agent that has not acted", () => {
    const { container } = render(<CoBrowseCursorLayer />);

    act(() => {
      emitActivity({
        agentId: "agent",
        agentName: "Agent",
        action: "agent_connected",
        timestamp: Date.now(),
        target: { kind: "navigation", label: "Agent connected" },
      });
    });

    expect(document.querySelector("[data-co-browse-cursor-layer]")).toBeNull();
    expect(container.querySelector(".fai-cursor")).toBeNull();
  });

  it("appears on real tool traffic", () => {
    render(<CoBrowseCursorLayer />);

    act(() => tool("Focus link#2", { x: 100, y: 40, width: 80, height: 20 }));

    const layer = document.querySelector("[data-co-browse-cursor-layer]");
    expect(layer).not.toBeNull();
    expect(layer?.textContent).toContain("Focus link#2");
  });

  it("retires the cursor once the agent goes quiet", () => {
    vi.useFakeTimers();
    try {
      render(<CoBrowseCursorLayer idleAfterMs={15_000} />);
      act(() => tool("Focus link#2", { x: 100, y: 40, width: 80, height: 20 }));
      expect(document.querySelector("[data-co-browse-cursor-layer]")).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(15_001);
      });

      expect(document.querySelector("[data-co-browse-cursor-layer]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a reconnect keep a stale cursor alive", () => {
    vi.useFakeTimers();
    try {
      render(<CoBrowseCursorLayer idleAfterMs={15_000} />);
      act(() => tool("Focus link#2", { x: 100, y: 40, width: 80, height: 20 }));

      // Short-lived relay clients reconnect constantly (one process per call).
      // That is not the agent doing anything, so it must not extend the window.
      act(() => {
        vi.advanceTimersByTime(14_000);
        emitActivity({
          agentId: "agent",
          agentName: "Agent",
          action: "agent_connected",
          timestamp: Date.now(),
          target: { kind: "navigation", label: "Agent connected" },
        });
      });
      act(() => {
        vi.advanceTimersByTime(1_500);
      });

      expect(document.querySelector("[data-co-browse-cursor-layer]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
