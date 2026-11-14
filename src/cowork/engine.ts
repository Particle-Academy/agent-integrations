/**
 * The co-work pipeline, pure: no I/O, no clock, no storage. Every function
 * takes a session state and returns a decision plus the state to keep. The
 * state handed back is a NEW object when the decision allows, and the very
 * object passed in when it refuses, so a refusal can never leave a half-applied
 * change behind.
 *
 * Contract v1, pinned in `src/cowork/__tests__/cowork-v1.json`. Where this file
 * and the fixtures disagree, the fixtures are right.
 *
 * The CLIENT copy of the engine. The same decisions as
 * `@particle-academy/fancy-cowork` (Node) and `particle-academy/fancy-cowork`
 * (PHP), held together by that byte-identical fixture file rather than by a
 * shared import: neither server package is a dependency of this one. In
 * `direct` routing it runs at the sender and again at every receiver, because
 * there is no server in between; in `server` routing it is the sender's early
 * refusal and the receivers' second check of what the server relayed.
 */
import {
  INTENT_KINDS,
  VIEW_KINDS,
  type CoworkEvent,
  type Decision,
  type Envelope,
  type HostAnswer,
  type Intent,
  type IntentKind,
  type LimitRule,
  type MaybePromise,
  type ParticipantState,
  type Ref,
  type Refusal,
  type SessionConfig,
  type SessionConfigInput,
  type SessionState,
  type SessionStatus,
  type ViewControl,
} from "./types";

export const ALLOW: Decision = Object.freeze({ allow: true }) as Decision;

export const REASONS = {
  unconfiguredIdentity: "cowork.unconfigured.identity",
  unconfiguredConfig: "cowork.unconfigured.config",
  unconfiguredMembers: "cowork.unconfigured.members",
  unconfiguredAuthorize: "cowork.unconfigured.authorize",
  invalid: "cowork.invalid.intent",
  ended: "cowork.session.ended",
  notLive: "cowork.session.not-live",
  notRequested: "cowork.session.not-requested",
  membership: "cowork.denied.membership",
  authorize: "cowork.denied.authorize",
  size: "cowork.denied.size",
  origin: "cowork.denied.origin",
  masked: "cowork.denied.masked",
  viewOnly: "cowork.denied.view-only",
  limit: "cowork.denied.limit",
  stale: "cowork.denied.stale",
  control: "cowork.denied.control",
  controlMode: "cowork.denied.control-mode",
  rate: "cowork.denied.rate",
  full: "cowork.denied.full",
  consentPending: "cowork.consent.pending",
  notSubject: "cowork.consent.not-subject",
} as const;

export const refuse = (reason: string, status: number, extra: { blockedUntil?: number } = {}): Refusal => ({
  allow: false,
  reason,
  status,
  ...extra,
});

export const DEFAULT_MIDDLEWARE = [
  "membership",
  "authorize",
  "payloadSize",
  "sameOrigin",
  "masking",
  "limits",
  "revision",
  "control",
  "rateLimit",
  "audit",
] as const;
export type DefaultMiddlewareName = (typeof DEFAULT_MIDDLEWARE)[number];

export const DEFAULT_CONFIG: SessionConfig = {
  consent: "notify",
  control: { mode: "baton" },
  routing: "server",
  limits: { allow: [], deny: [], mask: [], viewOnly: [] },
  rate: { intentsPerSecond: 10, visitsPerSecond: 1, appPerMinute: 30, startsPerMinute: 5 },
  size: { intentBytes: 8192, appBytes: 16384 },
  maxParticipants: 16,
};

/** Fill a host's partial config from the defaults. Every limit stays configurable. */
export function resolveConfig(input: SessionConfigInput = {}): SessionConfig {
  return {
    ...DEFAULT_CONFIG,
    ...input,
    control: input.control ?? DEFAULT_CONFIG.control,
    limits: { ...DEFAULT_CONFIG.limits, ...(input.limits ?? {}) },
    rate: { ...DEFAULT_CONFIG.rate, ...(input.rate ?? {}) },
    size: { ...DEFAULT_CONFIG.size, ...(input.size ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// Host + middleware contract
// ---------------------------------------------------------------------------

export type PipelineContext = {
  session: SessionState;
  from: Ref;
  actingFor?: Ref;
  envelope: Envelope;
  /** The target view (its owner's ref), when the intent has one. */
  view?: Ref;
  config: SessionConfig;
  now: number;
  host: EngineHost;
  /** Events to emit if, and only if, the whole pipeline allows. */
  events: CoworkEvent[];
};

export type Middleware = (ctx: PipelineContext, intent: Intent, next: () => Promise<Decision>) => MaybePromise<Decision>;
export type MiddlewareEntry = DefaultMiddlewareName | Middleware;

/**
 * What the engine asks the host. `null` means the contract is unbound, and an
 * unbound contract denies. There is no allow-by-default anywhere in here.
 */
export type EngineHost = {
  identity: boolean;
  config: SessionConfig | null;
  members: ((ref: Ref) => MaybePromise<boolean>) | null;
  authorize: ((ref: Ref, ability: string, intent?: Intent) => MaybePromise<HostAnswer>) | null;
  /** Named predicates for the `when` limits criterion. `undefined` = not defined (fails closed). */
  predicate?: (name: string, ctx: PipelineContext, intent: Intent) => MaybePromise<boolean | undefined>;
  middleware?: MiddlewareEntry[];
};

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const isHandle = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 256 && !CONTROL_CHARS.test(v);
const isRef = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 256 && !CONTROL_CHARS.test(v);
const TOPIC = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const isViewKind = (kind: string): boolean => (VIEW_KINDS as readonly string[]).includes(kind);
const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/** `*` is any run of characters; everything else is literal. Anchored. */
export function globMatch(pattern: string, value: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, "\\$&"))
    .join("[\\s\\S]*");
  return new RegExp(`^${source}$`).test(value);
}
const anyGlob = (patterns: string[], value: string) => patterns.some((p) => globMatch(p, value));

/** The path of a relative url: everything before `?` or `#`. */
export function routeOf(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

const utf8 = new TextEncoder();
/** UTF-8 bytes of the JSON encoding, keys in received order, no whitespace. */
export const jsonBytes = (value: unknown): number => utf8.encode(JSON.stringify(value) ?? "").length;

const handleOf = (intent: Intent): string | undefined =>
  intent.kind === "field" || intent.kind === "focus" || intent.kind === "click" || intent.kind === "submit"
    ? intent.handle
    : intent.kind === "scroll"
      ? intent.anchor
      : undefined;

const clone = <T>(value: T): T => structuredClone(value);

/** The baton state of a view: its owner holds it until something says otherwise. */
export function holderOf(session: SessionState, view: Ref): ViewControl {
  return session.control[view] ?? { holder: view, requests: [] };
}

const subjectOf = (session: SessionState, config: SessionConfig): Ref => config.subject ?? session.starter;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Structural validation of one intent and its envelope. Runs before anything else is asked. */
export function validIntent(intent: unknown, envelope: Envelope): intent is Intent {
  if (!isRecord(intent) || typeof intent.kind !== "string" || !(INTENT_KINDS as readonly string[]).includes(intent.kind)) return false;
  if (!isRecord(envelope)) return false;
  if (envelope.to !== undefined && (!Array.isArray(envelope.to) || envelope.to.length > 64 || !envelope.to.every(isRef))) return false;
  if (envelope.view !== undefined && !isRef(envelope.view)) return false;
  const kind = intent.kind as IntentKind;
  if (isViewKind(kind) || kind === "control") {
    if (!isRef(envelope.view)) return false;
  }
  if (isViewKind(kind)) {
    if (typeof envelope.revision !== "number" || !Number.isInteger(envelope.revision) || envelope.revision < 0) return false;
  }
  switch (kind) {
    case "visit":
      return typeof intent.url === "string" && intent.url.length >= 1 && intent.url.length <= 2048;
    case "scroll":
      return (
        typeof intent.y === "number" &&
        Number.isFinite(intent.y) &&
        intent.y >= 0 &&
        (intent.anchor === undefined || isHandle(intent.anchor))
      );
    case "field":
      return isHandle(intent.handle) && has(intent, "value");
    case "focus":
    case "click":
    case "submit":
      return isHandle(intent.handle);
    case "control":
      if (!["request", "grant", "release", "revoke"].includes(intent.op as string)) return false;
      if (intent.target !== undefined && !isRef(intent.target)) return false;
      return intent.op !== "grant" || isRef(intent.target);
    case "app":
      return typeof intent.topic === "string" && TOPIC.test(intent.topic) && has(intent, "payload");
  }
}

// ---------------------------------------------------------------------------
// The default middleware
// ---------------------------------------------------------------------------

async function askMembers(host: EngineHost, ref: Ref): Promise<boolean> {
  return (await host.members!(ref)) === true;
}

/** Normalise a host answer. Only `true` or `{ allow: true }` allows; anything else refuses. */
async function askAuthorize(host: EngineHost, ref: Ref, ability: string, intent?: Intent): Promise<Decision> {
  const answer = await host.authorize!(ref, ability, intent);
  if (answer === true) return ALLOW;
  if (isRecord(answer) && answer.allow === true) return ALLOW;
  const reason = isRecord(answer) && typeof answer.reason === "string" && answer.reason ? answer.reason : REASONS.authorize;
  return refuse(reason, 403);
}

const membership: Middleware = async (ctx, intent, next) => {
  const { host, session } = ctx;
  if (!host.members) return refuse(REASONS.unconfiguredMembers, 403);
  const refs = new Set<Ref>([ctx.from]);
  if (ctx.view !== undefined) refs.add(ctx.view);
  for (const ref of ctx.envelope.to ?? []) refs.add(ref);
  if (intent.kind === "control" && intent.target !== undefined) refs.add(intent.target);
  for (const ref of refs) {
    if (!session.participants[ref] || !(await askMembers(host, ref))) return refuse(REASONS.membership, 403);
  }
  return next();
};

const authorize: Middleware = async (ctx, intent, next) => {
  const { host } = ctx;
  if (!host.authorize) return refuse(REASONS.unconfiguredAuthorize, 403);
  const abilities = [`intent:${intent.kind}`];
  if (ctx.view !== undefined) abilities.push(`view:${ctx.view}`);
  if (ctx.view !== undefined && ctx.view !== ctx.from) abilities.push("drive");
  for (const ability of abilities) {
    const decision = await askAuthorize(host, ctx.from, ability, intent);
    if (!decision.allow) return decision;
  }
  return next();
};

const payloadSize: Middleware = (ctx, intent, next) => {
  const { size } = ctx.config;
  if (intent.kind === "app") {
    if (jsonBytes(intent.payload) > size.appBytes) return refuse(REASONS.size, 413);
  } else if (jsonBytes(intent) > size.intentBytes) return refuse(REASONS.size, 413);
  return next();
};

/** A relative same-origin path: `/`, not `//` or `/\`, no backslash, whitespace or control character. */
export function isSameOriginPath(url: string): boolean {
  if (!url.startsWith("/") || url.startsWith("//")) return false;
  if (url.includes("\\")) return false;
  return !/[\s\u0000-\u001f\u007f]/.test(url);
}

const sameOrigin: Middleware = (_ctx, intent, next) => {
  if (intent.kind === "visit" && !isSameOriginPath(intent.url)) return refuse(REASONS.origin, 422);
  return next();
};

const masking: Middleware = (ctx, intent, next) => {
  const { mask, viewOnly } = ctx.config.limits;
  if (intent.kind === "field" && anyGlob(mask, intent.handle)) return refuse(REASONS.masked, 403);
  if ((intent.kind === "field" || intent.kind === "click" || intent.kind === "submit") && anyGlob(viewOnly, intent.handle)) {
    return refuse(REASONS.viewOnly, 403);
  }
  return next();
};

/**
 * One limits rule against one intent. `null` = not applicable (a criterion it
 * names has no value on this intent), else whether it matches. An undefined
 * predicate fails closed: it matches a deny rule and misses an allow rule.
 */
async function ruleMatches(rule: LimitRule, ctx: PipelineContext, intent: Intent, isDeny: boolean): Promise<boolean | null> {
  const handle = handleOf(intent);
  if (rule.handles !== undefined && handle === undefined) return null;
  if (rule.kinds !== undefined && !rule.kinds.includes(intent.kind)) return false;
  if (rule.handles !== undefined && !anyGlob(rule.handles, handle!)) return false;
  if (rule.routes !== undefined) {
    const route = intent.kind === "visit" ? routeOf(intent.url) : (ctx.session.participants[ctx.view!]?.route ?? "");
    if (!anyGlob(rule.routes, route)) return false;
  }
  if (rule.when !== undefined) {
    const answer = ctx.host.predicate ? await ctx.host.predicate(rule.when, ctx, intent) : undefined;
    if (answer === undefined) return isDeny;
    if (answer !== true) return false;
  }
  return true;
}

const limits: Middleware = async (ctx, intent, next) => {
  if (!isViewKind(intent.kind)) return next();
  const { allow, deny } = ctx.config.limits;
  for (const rule of deny) if ((await ruleMatches(rule, ctx, intent, true)) === true) return refuse(REASONS.limit, 403);
  let applicable = false;
  for (const rule of allow) {
    const result = await ruleMatches(rule, ctx, intent, false);
    if (result === null) continue;
    applicable = true;
    if (result) return next();
  }
  if (applicable) return refuse(REASONS.limit, 403);
  return next();
};

const revision: Middleware = (ctx, intent, next) => {
  if (isViewKind(intent.kind)) {
    const view = ctx.session.participants[ctx.view!];
    if (view && (ctx.envelope.revision ?? -1) < view.revision) return refuse(REASONS.stale, 409);
  }
  return next();
};

const rankOf = (config: SessionConfig, ref: Ref): number => {
  if (config.control.mode !== "ranked") return 0;
  const rank = config.control.rank;
  const value = typeof rank === "function" ? rank(ref) : rank?.[ref];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

const control: Middleware = (ctx, intent, next) => {
  const { config, session, from } = ctx;
  const mode = config.control.mode;
  if (intent.kind === "control") {
    if (mode !== "baton") return refuse(REASONS.controlMode, 409);
    const view = ctx.view!;
    const state = holderOf(session, view);
    if ((intent.op === "grant" || intent.op === "release") && from !== state.holder) return refuse(REASONS.control, 409);
    if (intent.op === "revoke" && from !== view) return refuse(REASONS.control, 409);
    return next();
  }
  if (!isViewKind(intent.kind)) return next();
  const view = ctx.view!;
  if (mode === "baton" && holderOf(session, view).holder !== from) return refuse(REASONS.control, 409);
  if (mode === "ranked") {
    const idleMs = config.control.mode === "ranked" ? (config.control.idleMs ?? 3000) : 3000;
    const mine = rankOf(config, from);
    let blockedUntil: number | undefined;
    for (const [ref, at] of Object.entries(session.last[view] ?? {})) {
      if (ref === from || rankOf(config, ref) <= mine || ctx.now - at >= idleMs) continue;
      blockedUntil = Math.max(blockedUntil ?? 0, at + idleMs);
    }
    if (blockedUntil !== undefined) return refuse(REASONS.control, 409, { blockedUntil });
  }
  return next();
};

const within = (times: number[], now: number, windowMs: number) => times.filter((t) => t > now - windowMs).length;

const rateLimit: Middleware = (ctx, intent, next) => {
  const { rate } = ctx.config;
  const mine = ctx.session.rate[ctx.from] ?? { all: [], visit: [], app: [] };
  if (within(mine.all, ctx.now, 1000) >= rate.intentsPerSecond) return refuse(REASONS.rate, 429);
  if (intent.kind === "visit" && within(mine.visit, ctx.now, 1000) >= rate.visitsPerSecond) return refuse(REASONS.rate, 429);
  if (intent.kind === "app" && within(mine.app, ctx.now, 60000) >= rate.appPerMinute) return refuse(REASONS.rate, 429);
  return next();
};

/** Never refuses. Records `IntentRelayed` only when everything after it allowed too. */
const audit: Middleware = async (ctx, intent, next) => {
  const decision = await next();
  if (decision.allow) {
    ctx.events.push({
      type: "IntentRelayed",
      session: ctx.session.id,
      ref: ctx.from,
      ...(ctx.actingFor !== undefined ? { actingFor: ctx.actingFor } : {}),
      ...(ctx.envelope.id !== undefined ? { id: ctx.envelope.id } : {}),
      kind: intent.kind,
      ...(ctx.view !== undefined ? { view: ctx.view } : {}),
      ...(ctx.envelope.to !== undefined ? { to: [...ctx.envelope.to] } : {}),
      at: ctx.now,
    });
  }
  return decision;
};

export const DEFAULTS: Readonly<Record<DefaultMiddlewareName, Middleware>> = Object.freeze({
  membership,
  authorize,
  payloadSize,
  sameOrigin,
  masking,
  limits,
  revision,
  control,
  rateLimit,
  audit,
});

/** Resolve a stack: default names become their middleware; an unknown name is a configuration error. */
export function resolveStack(entries: readonly MiddlewareEntry[] = DEFAULT_MIDDLEWARE): Middleware[] {
  return entries.map((entry) => {
    if (typeof entry === "function") return entry;
    const found = DEFAULTS[entry as DefaultMiddlewareName];
    if (!found) throw new TypeError(`Unknown cowork middleware "${String(entry)}".`);
    return found;
  });
}

async function runStack(stack: Middleware[], ctx: PipelineContext, intent: Intent): Promise<Decision> {
  const dispatch = async (i: number): Promise<Decision> => {
    if (i >= stack.length) return ALLOW;
    const decision = await stack[i]!(ctx, intent, () => dispatch(i + 1));
    return isRecord(decision) && decision.allow === true ? decision : normaliseRefusal(decision);
  };
  return dispatch(0);
}

/** A middleware that returns anything but a well-formed allow refuses. */
function normaliseRefusal(decision: unknown): Decision {
  if (isRecord(decision) && decision.allow === false && typeof decision.reason === "string" && typeof decision.status === "number") {
    return decision as Refusal;
  }
  return refuse("cowork.denied.middleware", 403);
}

// ---------------------------------------------------------------------------
// Results + commits
// ---------------------------------------------------------------------------

export type Result = { decision: Decision; state: SessionState; events: CoworkEvent[] };

const refused = (state: SessionState, decision: Decision): Result => ({ decision, state, events: [] });

function prelude(host: EngineHost): Decision | null {
  if (!host.identity) return refuse(REASONS.unconfiguredIdentity, 403);
  if (!host.config) return refuse(REASONS.unconfiguredConfig, 403);
  return null;
}

function sessionGate(state: SessionState): Decision | null {
  if (state.state === "ended") return refuse(REASONS.ended, 410);
  if (state.state !== "live") return refuse(REASONS.notLive, 409);
  return null;
}

/** Remove a participant and hand back every view it held. Mutates `next`. */
function removeParticipant(next: SessionState, ref: Ref, now: number, events: CoworkEvent[]): void {
  delete next.participants[ref];
  delete next.control[ref];
  delete next.last[ref];
  for (const [view, control] of Object.entries(next.control)) {
    const requests = control.requests.filter((r) => r !== ref);
    if (control.holder === ref) {
      next.control[view] = { holder: view, requests };
      events.push({ type: "ControlChanged", session: next.id, ref, view, holder: view, op: "leave", at: now });
    } else next.control[view] = { holder: control.holder, requests };
  }
  for (const p of Object.values(next.participants)) if (p.follows === ref) p.follows = null;
  for (const times of Object.values(next.last)) delete times[ref];
}

export type IntentInput = { from: Ref; actingFor?: Ref; envelope: Envelope; intent: Intent; now: number };

/** Run one intent through validation, the session gate and the middleware stack. */
export async function evaluateIntent(host: EngineHost, state: SessionState, input: IntentInput): Promise<Result> {
  const early = prelude(host);
  if (early) return refused(state, early);
  const envelope = isRecord(input.envelope) ? input.envelope : {};
  if (!validIntent(input.intent, envelope)) return refused(state, refuse(REASONS.invalid, 422));
  const gate = sessionGate(state);
  if (gate) return refused(state, gate);

  const intent = input.intent;
  const events: CoworkEvent[] = [];
  const ctx: PipelineContext = {
    session: state,
    from: input.from,
    ...(input.actingFor !== undefined ? { actingFor: input.actingFor } : {}),
    envelope,
    ...(envelope.view !== undefined ? { view: envelope.view } : {}),
    config: host.config!,
    now: input.now,
    host,
    events,
  };
  const decision = await runStack(resolveStack(host.middleware), ctx, intent);
  if (!decision.allow) return refused(state, decision);

  const next = clone(state);
  const now = input.now;
  const rate = (next.rate[input.from] ??= { all: [], visit: [], app: [] });
  rate.all = [...rate.all.filter((t) => t > now - 1000), now];
  if (intent.kind === "visit") rate.visit = [...rate.visit.filter((t) => t > now - 1000), now];
  if (intent.kind === "app") rate.app = [...rate.app.filter((t) => t > now - 60000), now];
  const view = envelope.view;
  if (view !== undefined && isViewKind(intent.kind)) {
    (next.last[view] ??= {})[input.from] = now;
    if (intent.kind === "visit") {
      const owner = next.participants[view];
      if (owner) {
        owner.route = routeOf(intent.url);
        owner.revision += 1;
      }
    }
  }
  if (intent.kind === "control" && view !== undefined) {
    const current = holderOf(next, view);
    let changed: Ref | null = null;
    if (intent.op === "request") {
      if (input.from !== current.holder && !current.requests.includes(input.from)) {
        next.control[view] = { holder: current.holder, requests: [...current.requests, input.from] };
      }
    } else if (intent.op === "grant") {
      next.control[view] = { holder: intent.target!, requests: current.requests.filter((r) => r !== intent.target) };
      changed = intent.target!;
    } else if (intent.op === "release") {
      next.control[view] = { holder: view, requests: current.requests };
      changed = view;
    } else {
      next.control[view] = { holder: view, requests: [] };
      changed = view;
    }
    if (changed !== null && intent.op !== "request") {
      events.push({
        type: "ControlChanged",
        session: next.id,
        ref: input.from,
        ...(input.actingFor !== undefined ? { actingFor: input.actingFor } : {}),
        view,
        holder: changed,
        op: intent.op,
        at: now,
      });
    }
  }
  next.revision += 1;
  return { decision: ALLOW, state: next, events };
}

export type OpInput = {
  from: Ref;
  actingFor?: Ref;
  now: number;
  label?: string;
  attributes?: Record<string, unknown>;
  route?: string;
};

function participantFrom(input: OpInput): ParticipantState {
  return {
    ref: input.from,
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.attributes !== undefined ? { attributes: input.attributes } : {}),
    ...(input.actingFor !== undefined ? { actingFor: input.actingFor } : {}),
    route: input.route !== undefined && isSameOriginPath(input.route) ? routeOf(input.route) : "/",
    revision: 0,
    follows: null,
    joinedAt: input.now,
  };
}

const withActor = (input: OpInput) => (input.actingFor !== undefined ? { actingFor: input.actingFor } : {});

async function membersGate(host: EngineHost, ref: Ref): Promise<Decision | null> {
  if (!host.members) return refuse(REASONS.unconfiguredMembers, 403);
  if (!(await askMembers(host, ref))) return refuse(REASONS.membership, 403);
  return null;
}

async function abilityGate(host: EngineHost, ref: Ref, ability: string): Promise<Decision | null> {
  if (!host.authorize) return refuse(REASONS.unconfiguredAuthorize, 403);
  const decision = await askAuthorize(host, ref, ability);
  return decision.allow ? null : decision;
}

/** Join: identity, config, ended, not live, members, ability, already joined, consent, full. */
export async function evaluateJoin(host: EngineHost, state: SessionState, input: OpInput): Promise<Result> {
  const checks = prelude(host) ?? sessionGate(state) ?? (await membersGate(host, input.from)) ?? (await abilityGate(host, input.from, "join"));
  if (checks) return refused(state, checks);
  if (state.participants[input.from]) return { decision: ALLOW, state, events: [] };
  const config = host.config!;
  if (config.consent === "accept" && !state.consented && input.from !== subjectOf(state, config)) {
    return refused(state, refuse(REASONS.consentPending, 403));
  }
  if (Object.keys(state.participants).length >= config.maxParticipants) return refused(state, refuse(REASONS.full, 409));
  const next = clone(state);
  next.participants[input.from] = participantFrom(input);
  next.revision += 1;
  return { decision: ALLOW, state: next, events: [{ type: "PeerJoined", session: next.id, ref: input.from, ...withActor(input), at: input.now }] };
}

/** Activate: identity, config, ended, not requested, members, ability, consent, full. */
export async function evaluateActivate(host: EngineHost, state: SessionState, input: OpInput): Promise<Result> {
  const early = prelude(host);
  if (early) return refused(state, early);
  if (state.state === "ended") return refused(state, refuse(REASONS.ended, 410));
  if (state.state !== "requested") return refused(state, refuse(REASONS.notRequested, 409));
  const checks = (await membersGate(host, input.from)) ?? (await abilityGate(host, input.from, "activate"));
  if (checks) return refused(state, checks);
  const config = host.config!;
  if (config.consent === "accept" && !state.consented && input.from !== subjectOf(state, config)) {
    return refused(state, refuse(REASONS.consentPending, 403));
  }
  const joining = !state.participants[input.from];
  if (joining && Object.keys(state.participants).length >= config.maxParticipants) return refused(state, refuse(REASONS.full, 409));
  const next = clone(state);
  next.state = "live";
  if (joining) next.participants[input.from] = participantFrom(input);
  next.revision += 1;
  const events: CoworkEvent[] = [{ type: "SessionActivated", session: next.id, ref: input.from, ...withActor(input), at: input.now }];
  if (joining) events.push({ type: "PeerJoined", session: next.id, ref: input.from, ...withActor(input), at: input.now });
  return { decision: ALLOW, state: next, events };
}

/** Consent: identity, config, ended, the sender is the subject. */
export async function evaluateConsent(host: EngineHost, state: SessionState, input: OpInput): Promise<Result> {
  const early = prelude(host);
  if (early) return refused(state, early);
  if (state.state === "ended") return refused(state, refuse(REASONS.ended, 410));
  if (input.from !== subjectOf(state, host.config!)) return refused(state, refuse(REASONS.notSubject, 403));
  const next = clone(state);
  next.consented = true;
  next.revision += 1;
  return { decision: ALLOW, state: next, events: [{ type: "ConsentGiven", session: next.id, ref: input.from, ...withActor(input), at: input.now }] };
}

/** End: identity, config, ended, live member, ability `end`. */
export async function evaluateEnd(host: EngineHost, state: SessionState, input: OpInput): Promise<Result> {
  const early = prelude(host);
  if (early) return refused(state, early);
  if (state.state === "ended") return refused(state, refuse(REASONS.ended, 410));
  if (!host.members) return refused(state, refuse(REASONS.unconfiguredMembers, 403));
  if (!state.participants[input.from] || !(await askMembers(host, input.from))) return refused(state, refuse(REASONS.membership, 403));
  const ability = await abilityGate(host, input.from, "end");
  if (ability) return refused(state, ability);
  const next = clone(state);
  next.state = "ended";
  next.endedAt = input.now;
  next.revision += 1;
  return { decision: ALLOW, state: next, events: [{ type: "SessionEnded", session: next.id, ref: input.from, ...withActor(input), at: input.now }] };
}

/** Leave: the sender must be a participant. Nothing else is asked. */
export async function evaluateLeave(_host: EngineHost, state: SessionState, input: OpInput): Promise<Result> {
  if (!state.participants[input.from]) return refused(state, refuse(REASONS.membership, 403));
  const next = clone(state);
  const events: CoworkEvent[] = [{ type: "PeerLeft", session: next.id, ref: input.from, ...withActor(input), at: input.now }];
  removeParticipant(next, input.from, input.now, events);
  next.revision += 1;
  return { decision: ALLOW, state: next, events };
}

/** Follow (or `target: null` to stop): identity, config, ended, not live, members, ability `follow`. */
export async function evaluateFollow(host: EngineHost, state: SessionState, input: OpInput & { target: Ref | null }): Promise<Result> {
  const early = prelude(host) ?? sessionGate(state);
  if (early) return refused(state, early);
  if (!host.members) return refused(state, refuse(REASONS.unconfiguredMembers, 403));
  for (const ref of input.target === null ? [input.from] : [input.from, input.target]) {
    if (!state.participants[ref] || !(await askMembers(host, ref))) return refused(state, refuse(REASONS.membership, 403));
  }
  if (input.target !== null) {
    const ability = await abilityGate(host, input.from, "follow");
    if (ability) return refused(state, ability);
  }
  const next = clone(state);
  next.participants[input.from]!.follows = input.target === input.from ? null : input.target;
  next.revision += 1;
  return { decision: ALLOW, state: next, events: [] };
}

export type NewSessionInput = {
  id: string;
  state: SessionStatus;
  starter: Ref;
  participants?: Array<{ ref: Ref; route?: string; label?: string; actingFor?: Ref }>;
  now: number;
};

/** A fresh session state. Participants given here are already joined. */
export function createSessionState(input: NewSessionInput): SessionState {
  const participants: Record<Ref, ParticipantState> = {};
  for (const p of input.participants ?? []) {
    participants[p.ref] = participantFrom({
      from: p.ref,
      now: input.now,
      ...(p.route !== undefined ? { route: p.route } : {}),
      ...(p.label !== undefined ? { label: p.label } : {}),
      ...(p.actingFor !== undefined ? { actingFor: p.actingFor } : {}),
    });
  }
  return {
    id: input.id,
    state: input.state,
    starter: input.starter,
    consented: false,
    revision: 0,
    createdAt: input.now,
    endedAt: null,
    participants,
    control: {},
    last: {},
    rate: {},
  };
}
