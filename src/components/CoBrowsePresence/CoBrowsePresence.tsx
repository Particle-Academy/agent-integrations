import { useMemo } from "react";
import { useAgentActivity } from "../../presence/use-agent-activity";
import { ShareControls } from "../ShareControls/ShareControls";
import { ConnectorButtons } from "../../connectors/ConnectorButtons";
import type { AgentActivity } from "../AgentPanel";
import type { AgentActivityEvent } from "../../presence/types";
import type { CoBrowseSession } from "../../sharing/use-co-browse-session";

export type CoBrowsePresenceProps = {
  /** The session from `useCoBrowseSession`. */
  session: CoBrowseSession;
  /** Public MCP/connect URL shown to the user (for ConnectorButtons), optional. */
  connectUrl?: string;
  /** Base URL used to build the shareable session link. */
  shareBaseUrl?: string;
  className?: string;
};

/** Lifecycle chatter — real to the session, but not something the agent *did*. */
const LIFECYCLE_ACTIONS = new Set(["agent_connected", "agent_disconnected"]);

/**
 * The human's view of a site-wide co-browsing session: a "Let an agent drive"
 * starter, the share/connect surface until an agent arrives, a live log of what
 * it is doing once one has, and a Stop / take-back-control button.
 *
 * Staged-action confirms are rendered by the HOST (via the navigation adapter's
 * `confirm`), so this component stays presentation-only.
 */
export function CoBrowsePresence({ session, connectUrl, shareBaseUrl, className }: CoBrowsePresenceProps) {
  const { events } = useAgentActivity(undefined, { capacity: 40 });
  const lastAgentAction = [...events]
    .reverse()
    .find((e) => (e.source ?? "agent") !== "user" && !LIFECYCLE_ACTIONS.has(e.action));

  // Whether an agent is HERE, not whether the browser reached the relay. The
  // latter is true the instant sharing starts, so keying the badge on it told
  // every human "Agent is driving" before they had handed the link to anyone.
  const connected = session.agentConnected;

  const activity = useMemo(() => events.map(toPanelActivity), [events]);

  if (!session.session) {
    return (
      <div className={className} data-co-browse-presence="idle">
        <button type="button" onClick={() => void session.startShare()} data-co-browse-start>
          Let an agent drive
        </button>
      </div>
    );
  }

  return (
    <div className={className} data-co-browse-presence={connected ? "connected" : "waiting"}>
      <div data-co-browse-bar>
        <span data-co-browse-dot data-state={session.relayState} />
        <span data-co-browse-status>
          {connected ? "Agent is driving" : `Waiting for an agent… (${session.relayState})`}
        </span>
        {lastAgentAction && <span data-co-browse-last>{lastAgentAction.target?.label ?? lastAgentAction.action}</span>}
        <button type="button" onClick={session.stopShare} data-co-browse-stop>
          Stop
        </button>
      </div>

      <ShareControls
        session={session.session}
        onStart={() => void session.startShare()}
        onStop={session.stopShare}
        status={session.relayState}
        agentConnected={connected}
        activity={activity}
        shareBaseUrl={shareBaseUrl}
      />

      {connectUrl && <ConnectorButtons serverName="Fancy UI co-browse" mcpUrl={connectUrl} />}
    </div>
  );
}

/**
 * Presence event → the `AgentActivity` row `<ShareControls>` / `<AgentPanel>`
 * render. One shape for both, so a host already collecting presence needs no
 * second stream.
 */
function toPanelActivity(event: AgentActivityEvent): AgentActivity {
  const who = (event.source ?? "agent") === "user" ? "You" : (event.agentName ?? "Agent");
  return {
    id: `${event.timestamp}-${event.action}-${event.target?.elementId ?? event.target?.label ?? ""}`,
    at: event.timestamp,
    kind: LIFECYCLE_ACTIONS.has(event.action) ? "info" : "tool",
    source: who,
    text: event.target?.label ?? event.action,
    detail: event.meta,
  };
}

CoBrowsePresence.displayName = "CoBrowsePresence";
