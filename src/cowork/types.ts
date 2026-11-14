/**
 * Wire and state types for co-work sessions, contract v1. The same shapes as
 * the servers, particle-academy/fancy-cowork (PHP) and
 * @particle-academy/fancy-cowork (Node); the byte-identical fixture file
 * `__tests__/cowork-v1.json` is what keeps the three equal.
 */

export type Ref = string;
export type MaybePromise<T> = T | Promise<T>;

export const INTENT_KINDS = ["visit", "scroll", "field", "focus", "click", "submit", "control", "app", "cursor", "activity"] as const;
export type IntentKind = (typeof INTENT_KINDS)[number];

/**
 * Presence kinds: lossy, view-less, never subject to limits, masking, revision or
 * control, and changing no state but their rate counters. They exist so a socket
 * server that does not stamp a client event's sender (Sockudo) can still carry
 * cursors and field activity: the client posts them, the server stamps the sender.
 */
export const PRESENCE_KINDS = ["cursor", "activity"] as const;

/** Kinds that act on a view: they need an envelope `view` and `revision`. */
export const VIEW_KINDS = ["visit", "scroll", "field", "focus", "click", "submit"] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

export type ControlOp = "request" | "grant" | "release" | "revoke";

export type Intent =
  | { kind: "visit"; url: string }
  | { kind: "scroll"; anchor?: string; y: number }
  | { kind: "field"; handle: string; value: unknown }
  | { kind: "focus"; handle: string }
  | { kind: "click"; handle: string }
  | { kind: "submit"; handle: string }
  | { kind: "control"; op: ControlOp; target?: Ref }
  | { kind: "app"; topic: string; payload: unknown }
  | { kind: "cursor"; route: string; anchor?: string; fx?: number; fy?: number; x?: number; y?: number }
  | { kind: "activity"; handle: string; active: boolean };

/** What travels with an intent. `from`, `session` and `at` are stamped by whoever runs the pipeline. */
export type Envelope = {
  id?: string;
  session?: string;
  from?: Ref;
  to?: Ref[];
  /** The ref of the view's owner. */
  view?: Ref;
  revision?: number;
  at?: number;
};

export type Allow = { allow: true };
export type Refusal = { allow: false; reason: string; status: number; blockedUntil?: number };
export type Decision = Allow | Refusal;

export type ConsentMode = "none" | "notify" | "accept";
export type Routing = "server" | "direct";

export type ControlConfig =
  | { mode: "free" }
  | { mode: "ranked"; rank?: Record<Ref, number> | ((ref: Ref) => number); idleMs?: number }
  | { mode: "baton" };

/** A limits rule. Every named criterion must match; see the README for "applicable". */
export type LimitRule = { kinds?: string[]; handles?: string[]; routes?: string[]; when?: string };

export type SessionConfig = {
  consent: ConsentMode;
  /** Whose consent `accept` waits for. Defaults to the session's starter. */
  subject?: Ref;
  control: ControlConfig;
  routing: Routing;
  limits: { allow: LimitRule[]; deny: LimitRule[]; mask: string[]; viewOnly: string[] };
  rate: { intentsPerSecond: number; visitsPerSecond: number; appPerMinute: number; startsPerMinute: number; cursorsPerSecond: number };
  size: { intentBytes: number; appBytes: number };
  maxParticipants: number;
};

/** What a host's config resolver may return: any subset, the rest defaults. */
export type SessionConfigInput = Partial<Omit<SessionConfig, "limits" | "rate" | "size">> & {
  limits?: Partial<SessionConfig["limits"]>;
  rate?: Partial<SessionConfig["rate"]>;
  size?: Partial<SessionConfig["size"]>;
};

export type SessionStatus = "requested" | "live" | "ended";

/** One participant, as the package stores it: opaque strings, never a host model. */
export type ParticipantState = {
  ref: Ref;
  label?: string;
  attributes?: Record<string, unknown>;
  actingFor?: Ref;
  route: string;
  revision: number;
  follows: Ref | null;
  joinedAt: number;
};

export type ViewControl = { holder: Ref; requests: Ref[] };

export type SessionState = {
  id: string;
  state: SessionStatus;
  starter: Ref;
  consented: boolean;
  /** Bumped on every committed change, so a reconnecting client can tell it is behind. */
  revision: number;
  createdAt: number;
  endedAt: number | null;
  /** Live participants only, in join order. */
  participants: Record<Ref, ParticipantState>;
  /** Baton state per view (absent = the owner holds it, nobody queued). */
  control: Record<Ref, ViewControl>;
  /** Ranked control: last committed intent time per view, per sender. */
  last: Record<Ref, Record<Ref, number>>;
  /** Committed intent times per sender, for the rate windows. */
  rate: Record<Ref, RateTimes>;
};

/** Committed intent times for one sender. `cursor` is absent on state written before it existed. */
export type RateTimes = { all: number[]; visit: number[]; app: number[]; cursor?: number[] };

export type Participant = { ref: Ref; label?: string; attributes?: Record<string, unknown>; actingFor?: Ref };

export type HostAnswer = boolean | { allow: boolean; reason?: string };

/** The audit events. The host decides whether and where to keep them. */
export type CoworkEvent =
  | { type: "SessionRequested"; session: string; ref: Ref; actingFor?: Ref; at: number }
  | { type: "SessionActivated"; session: string; ref: Ref; actingFor?: Ref; at: number }
  | { type: "PeerJoined"; session: string; ref: Ref; actingFor?: Ref; at: number }
  | { type: "PeerLeft"; session: string; ref: Ref; actingFor?: Ref; at: number }
  | { type: "ConsentGiven"; session: string; ref: Ref; actingFor?: Ref; at: number }
  | { type: "ControlChanged"; session: string; ref: Ref; actingFor?: Ref; view: Ref; holder: Ref; op: ControlOp | "leave"; at: number }
  | { type: "IntentRelayed"; session: string; ref: Ref; actingFor?: Ref; id?: string; kind: IntentKind; view?: Ref; to?: Ref[]; at: number }
  | { type: "SessionEnded"; session: string; ref: Ref; actingFor?: Ref; at: number };
