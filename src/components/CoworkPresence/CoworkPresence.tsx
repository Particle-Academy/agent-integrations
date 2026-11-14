import { useEffect, useState } from "react";

import type { CoworkPeer, CoworkSnapshot } from "../../cowork/session";

export type CoworkPresenceLabels = {
  /** The session indicator, shown under `notify` (and `accept`). */
  live?: (count: number) => string;
  /** Shown while the local person cannot act in their own view. `seconds` only for ranked control. */
  blocked?: (who: string, seconds?: number) => string;
  /** A peer's avatar text. Default: initials of its label. */
  initials?: (peer: CoworkPeer) => string;
};

export type CoworkPresenceProps = {
  /** `useCoworkSession`'s result, or any snapshot of one. */
  session: Pick<CoworkSnapshot, "peers" | "blocked" | "consent">;
  labels?: CoworkPresenceLabels;
  /** Clock for the countdown. Default `Date.now`. */
  now?: () => number;
  className?: string;
};

const DEFAULTS: Required<CoworkPresenceLabels> = {
  live: (count) => `Co-working session: ${count} ${count === 1 ? "person" : "people"}`,
  blocked: (who, seconds) => (seconds === undefined ? `${who} has control` : `${who} has control, ${seconds}s`),
  initials: (peer) =>
    (peer.label ?? peer.ref)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0]!.toUpperCase())
      .join("") || "?",
};

/**
 * Who is in a co-work session, and the session indicator.
 *
 * Each peer is an avatar with a stable handle (`data-cowork-peer="<ref>"`, plus
 * `data-self`, `data-drives`, `data-idle`). The indicator (`data-cowork-indicator`,
 * `role="status"`) is shown when the host's consent mode is `notify` or `accept`,
 * and ALWAYS while the local person is blocked, because a person whose input is
 * being held needs to know why. Its tone (`data-tone`) is `warning` then, with
 * a countdown under ranked control ("Admin has control, 2s"), else `neutral`.
 * Under consent `none` and nothing blocked, only the avatars render.
 *
 * Presentation only, and every word comes from `labels`.
 */
export function CoworkPresence({ session, labels, now = Date.now, className }: CoworkPresenceProps) {
  const text = { ...DEFAULTS, ...labels };
  const blocked = session.blocked;
  const until = blocked?.until;
  const [at, setAt] = useState(() => now());

  useEffect(() => {
    setAt(now());
    if (until === undefined) return;
    const timer = setInterval(() => setAt(now()), 250);
    return () => clearInterval(timer);
  }, [until, now]);

  let indicator: string | null = null;
  if (blocked) {
    const who = blocked.label ?? blocked.by;
    indicator = text.blocked(who, until === undefined ? undefined : Math.max(0, Math.ceil((until - at) / 1000)));
  } else if (session.consent === "notify" || session.consent === "accept") {
    indicator = text.live(session.peers.length);
  }

  return (
    <div className={className} data-cowork-presence="" data-cowork-control="" data-tone={blocked ? "warning" : "neutral"}>
      {indicator !== null && (
        <span data-cowork-indicator="" role="status" aria-live="polite">
          {indicator}
        </span>
      )}
      <ul data-cowork-peers="">
        {session.peers.map((peer) => (
          <li
            key={peer.ref}
            data-cowork-peer={peer.ref}
            data-self={peer.self ? "" : undefined}
            data-drives={peer.drives ? "" : undefined}
            data-idle={peer.idle ? "" : undefined}
            title={peer.label ?? peer.ref}
            aria-label={peer.label ?? peer.ref}
          >
            {text.initials(peer)}
          </li>
        ))}
      </ul>
    </div>
  );
}

CoworkPresence.displayName = "CoworkPresence";
