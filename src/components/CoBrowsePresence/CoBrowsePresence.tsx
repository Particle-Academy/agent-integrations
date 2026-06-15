import { useAgentActivity } from "../../presence/use-agent-activity";
import { ShareControls } from "../ShareControls/ShareControls";
import { ConnectorButtons } from "../../connectors/ConnectorButtons";
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

/**
 * The human's view of a site-wide co-browsing session: a "Let an agent drive"
 * starter, the share/connect surface once started, a live "agent is driving"
 * status with the latest action, and a Stop / take-back-control button.
 *
 * Staged-action confirms are rendered by the HOST (via the navigation adapter's
 * `confirm`), so this component stays presentation-only.
 */
export function CoBrowsePresence({ session, connectUrl, shareBaseUrl, className }: CoBrowsePresenceProps) {
  const { events } = useAgentActivity(undefined, { capacity: 40 });
  const lastAgentAction = [...events].reverse().find((e) => (e.source ?? "agent") !== "user");
  const connected = session.relayState === "open";

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
        shareBaseUrl={shareBaseUrl}
      />

      {connectUrl && <ConnectorButtons serverName="Fancy UI co-browse" mcpUrl={connectUrl} />}
    </div>
  );
}

CoBrowsePresence.displayName = "CoBrowsePresence";
