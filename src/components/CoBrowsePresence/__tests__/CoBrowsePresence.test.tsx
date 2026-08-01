// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CoBrowsePresence } from "../CoBrowsePresence";
import { emitActivity, resetActivityRegistry } from "../../../presence/registry";
import type { CoBrowseSession } from "../../../sharing/use-co-browse-session";

/**
 * The panel is the human's only window onto a session they cannot see into.
 *
 * Two defects lived here at once. It announced "Agent is driving" off the
 * BROWSER's relay state — true the instant sharing starts, before the link had
 * been handed to anybody — and it kept rendering the paste-this-prompt UI after
 * a real agent connected, because it never passed `<ShareControls>` the props
 * that switch it to the activity log.
 */
const descriptor = { id: "kO7bI73O", token: "secret-token-value", display: "secr" } as never;

const makeSession = (over: Partial<CoBrowseSession> = {}): CoBrowseSession => ({
  server: null,
  session: descriptor,
  relayState: "open",
  agentConnected: false,
  agentCount: 0,
  startShare: async () => {},
  stopShare: () => {},
  observeUser: () => {},
  ...over,
});

afterEach(cleanup);
beforeEach(() => resetActivityRegistry());

describe("CoBrowsePresence", () => {
  it("does not claim an agent is driving just because the relay is open", () => {
    const { container } = render(<CoBrowsePresence session={makeSession()} />);

    expect(container.querySelector("[data-co-browse-presence]")?.getAttribute("data-co-browse-presence")).toBe(
      "waiting",
    );
    expect(container.querySelector("[data-co-browse-status]")?.textContent).toMatch(/Waiting for an agent/i);
    // Still the connect instructions — nobody has arrived to have an activity
    // log about.
    expect(screen.queryByRole("tab", { name: /activity/i })).toBeNull();
  });

  it("switches to the activity log once an agent actually connects", () => {
    emitActivity({
      agentId: "agent",
      agentName: "Agent",
      action: "nav_visit",
      timestamp: Date.UTC(2026, 6, 30, 12, 0, 0),
      target: { kind: "navigation", label: "Navigate → /packages" },
    });

    const { container } = render(
      <CoBrowsePresence session={makeSession({ agentConnected: true, agentCount: 1 })} />,
    );

    expect(container.querySelector("[data-co-browse-presence]")?.getAttribute("data-co-browse-presence")).toBe(
      "connected",
    );
    expect(screen.getByRole("tab", { name: /activity/i })).toBeTruthy();
    // Twice over: once as the status bar's "last action", once as a log row.
    expect(container.querySelector(".fai-share__activity-text")?.textContent).toBe("Navigate → /packages");
    expect(container.querySelector("[data-co-browse-last]")?.textContent).toBe("Navigate → /packages");
    // The prompt is still reachable for a human who wants to re-copy the link,
    // it is just no longer what the panel opens on.
    expect(screen.queryByText(/Paste this straight into an AI agent/i)).toBeNull();
  });

  it("does not report connecting as something the agent did", () => {
    emitActivity({
      agentId: "agent",
      agentName: "Agent",
      action: "agent_connected",
      timestamp: Date.UTC(2026, 6, 30, 12, 0, 0),
      target: { kind: "navigation", label: "Agent connected" },
    });

    const { container } = render(
      <CoBrowsePresence session={makeSession({ agentConnected: true, agentCount: 1 })} />,
    );

    // The status bar's "last action" is for work, not handshakes — an agent that
    // has only connected has done nothing to show.
    expect(container.querySelector("[data-co-browse-last]")).toBeNull();
  });
});
