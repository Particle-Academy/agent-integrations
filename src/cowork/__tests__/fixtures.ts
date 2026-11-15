import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createSessionState, globMatch, resolveConfig, type EngineHost, type MiddlewareEntry } from "../engine";
import type { Decision, SessionStatus } from "../types";

// Not `new URL("./x", import.meta.url)`: Vite rewrites that pattern into an asset URL.
export const FIXTURES_PATH = join(dirname(fileURLToPath(import.meta.url)), "cowork-v1.json");

// Pinned in EVERY leg: particle-academy/fancy-cowork (PHP), @particle-academy/fancy-cowork
// (Node) and this client engine. A copy that drifts in one repository fails that
// repository's suite, so "byte-identical" is a test result rather than a promise.
export const FIXTURES_SHA256 = "bcf40fb69bf9d1ce03bdc2dd426bc42f1dd890dc7a6716314f3bdccb6b7c7106";

export const RAW = readFileSync(FIXTURES_PATH);
export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

type HostEntry =
  | { host: "refuse"; reason: string; status: number }
  | { host: "refuseKind"; kind: string; reason: string; status: number };

export interface Step {
  op: "intent" | "join" | "activate" | "consent" | "end" | "leave" | "expectView" | "expectHolder";
  at?: number;
  repeat?: number;
  every?: number;
  from?: string;
  envelope?: { view?: string; revision?: number; to?: string[] };
  intent?: Record<string, unknown>;
  expect?: Decision;
  view?: string;
  route?: string;
  revision?: number;
  holder?: string;
  requests?: string[];
}

export interface Case {
  name: string;
  host: {
    identify: boolean;
    config: boolean;
    members: string[] | null;
    authorize: Record<string, string[]> | null;
    predicates?: Record<string, boolean>;
  };
  config?: Record<string, unknown>;
  middleware?: Array<string | HostEntry> | null;
  session: { state: SessionStatus; starter: string; participants: { ref: string; route: string }[] };
  steps: Step[];
}

export interface Fixtures {
  contract: string;
  defaults: { middleware: string[]; config: Record<string, unknown> };
  cases: Case[];
}

export const FX = JSON.parse(RAW.toString("utf8")) as Fixtures;

/** `{ $repeat: s, count: n }` anywhere in a value is s repeated n times. */
export function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.$repeat === "string" && typeof record.count === "number") return record.$repeat.repeat(record.count);
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, expand(v)]));
  }
  return value;
}

/** Steps with `repeat` become that many steps, `every` ms apart. */
export function steps(c: Case): Step[] {
  return c.steps.flatMap((s) => {
    if (!s.repeat) return [s];
    return Array.from({ length: s.repeat }, (_, i) => ({ ...s, repeat: undefined, at: (s.at ?? 0) + i * (s.every ?? 0) }));
  });
}

export function hostFor(c: Case): EngineHost {
  const h = c.host;
  const middleware: MiddlewareEntry[] | undefined = c.middleware?.map((entry) => {
    if (typeof entry === "string") return entry as MiddlewareEntry;
    if (entry.host === "refuse") return () => ({ allow: false, reason: entry.reason, status: entry.status });
    return (_ctx, intent, next) =>
      intent.kind === entry.kind ? { allow: false, reason: entry.reason, status: entry.status } : next();
  });
  return {
    identity: h.identify,
    config: h.config ? resolveConfig(c.config ?? {}) : null,
    members: h.members === null ? null : (ref) => h.members!.includes(ref),
    authorize:
      h.authorize === null ? null : (ref, ability) => (h.authorize![ref] ?? []).some((glob) => globMatch(glob, ability)),
    predicate: (name) => h.predicates?.[name],
    middleware,
  };
}

export function stateFor(c: Case) {
  return createSessionState({
    id: "s1",
    state: c.session.state,
    starter: c.session.starter,
    participants: c.session.participants.map((p) => ({ ref: p.ref, route: p.route })),
    now: 0,
  });
}
