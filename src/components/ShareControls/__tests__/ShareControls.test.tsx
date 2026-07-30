// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ShareControls } from "../ShareControls";
import type { AgentActivity } from "../../AgentPanel";

/**
 * Once an agent is driving, the panel must show what it is DOING.
 *
 * It kept rendering the paste-this-prompt UI — Agent prompt / URL / JSON / cURL
 * — long after the agent had connected and started acting. That is dead weight
 * at exactly the moment the human needs the opposite, and it made a connected
 * agent indistinguishable from a broken one: a stalled session looks the same as
 * a working one when the panel never says otherwise.
 */
const session = { id: "kO7bI73O", token: "secret-token-value", display: "secr" } as never;

const activity = (over: Partial<AgentActivity> = {}): AgentActivity => ({
  id: "a1",
  at: Date.UTC(2026, 6, 30, 12, 0, 0),
  kind: "tool",
  source: "nav_visit",
  text: "Navigated to /packages",
  ...over,
});

// This project does not enable RTL auto-cleanup, so without this each test
// asserts against the PREVIOUS test's DOM as well as its own — which is how
// "multiple elements with role tab" and a stale first row appear.
afterEach(cleanup);

describe("ShareControls", () => {
  it("shows the connect instructions before an agent arrives", () => {
    render(<ShareControls session={session} onStart={() => {}} onStop={() => {}} />);

    expect(screen.getByText(/Paste this straight into an AI agent/i)).toBeTruthy();
    // No Activity tab to switch to yet — offering one that is always empty
    // teaches people to ignore it.
    expect(screen.queryByRole("tab", { name: /activity/i })).toBeNull();
  });

  it("switches to the activity log the moment an agent connects", () => {
    render(
      <ShareControls
        session={session}
        onStart={() => {}}
        onStop={() => {}}
        agentConnected
        activity={[activity()]}
      />,
    );

    expect(screen.getByText("Navigated to /packages")).toBeTruthy();
    expect(screen.getByText("nav_visit")).toBeTruthy();
    // The prompt is still reachable, just no longer the front page — a human
    // may need to re-copy the URL mid-session.
    expect(screen.getByRole("tab", { name: /agent prompt/i })).toBeTruthy();
  });

  it("says so explicitly when connected with nothing done yet", () => {
    // "Connected, no activity" and "connected but broken" must not render the
    // same, or a stalled agent goes unnoticed.
    render(<ShareControls session={session} onStart={() => {}} onStop={() => {}} agentConnected />);

    expect(screen.getByText(/Nothing yet/i)).toBeTruthy();
  });

  it("puts the newest action first", () => {
    // The log is passed oldest-last, matching how events accumulate; the reader
    // wants the most recent thing at the top.
    render(
      <ShareControls
        session={session}
        onStart={() => {}}
        onStop={() => {}}
        agentConnected
        activity={[
          activity({ id: "old", text: "First action" }),
          activity({ id: "new", text: "Latest action" }),
        ]}
      />,
    );

    const rows = screen.getAllByRole("listitem");
    expect(rows[0]?.textContent).toContain("Latest action");
    expect(rows[1]?.textContent).toContain("First action");
  });

  it("never renders the full token", () => {
    // The panel shows a truncated display value; the secret itself must not
    // reach the DOM, where a screenshot or a screen share would leak it.
    const { container } = render(
      <ShareControls session={session} onStart={() => {}} onStop={() => {}} agentConnected />,
    );

    expect(container.innerHTML).not.toContain("secret-token-value");
  });
});
