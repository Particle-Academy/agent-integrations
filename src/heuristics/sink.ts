/**
 * In-browser heuristics analytics sink for agent traffic.
 *
 * Agent bridge mutations emit `AutoActivityEvent`s into the in-page
 * `@particle-academy/fancy-auto-common` activity bus (presence / cursors).
 * This sink — living in THIS package so it shares the SAME bundled
 * `fancy-auto-common` module instance the bridges emit into — subscribes to
 * that bus and POSTs each event to the `fancy-heuristics` `/collect` endpoint
 * as `actor:"agent"`, so agent traffic shows up in the heuristics dashboard.
 *
 * It does NOT depend on `fancy-heuristics` / `fancy-heuristics-js`: it only
 * emits the frozen wire shape over HTTP. The mapping mirrors
 * `fancy-heuristics-js/src/agent.ts` `mapActivityToEvent` — keep parity.
 */
import { onActivity, type AgentActivityEvent } from "../presence";

/** What kind of interaction an event captures (mirrors fancy-heuristics-js). */
type HeuristicsEventKind = "pageview" | "click" | "scroll" | "pointer" | "dwell";

/** Who produced the interaction. */
type HeuristicsActor = "human" | "agent";

/**
 * A single interaction event — mirrors `fancy-heuristics-js` `HeuristicsEvent`.
 * Optional fields are omitted (never `null`) when not relevant to the `kind`.
 */
export interface HeuristicsEvent {
  kind: HeuristicsEventKind;
  actor: HeuristicsActor;
  /** location.pathname at capture time. */
  path: string;
  /** ms epoch. */
  ts: number;
  x?: number;
  y?: number;
  vw?: number;
  vh?: number;
  scrollPct?: number;
  dwellMs?: number;
  targetId?: string;
  label?: string;
  meta?: Record<string, unknown>;
}

/** The batched POST body sent to `${endpoint}/collect`. */
export interface CollectBatch {
  siteKey: string;
  sessionId: string;
  events: HeuristicsEvent[];
}

export interface AttachHeuristicsSinkOptions {
  /** Base URL, e.g. "/heuristics". POSTs to `${endpoint}/collect`. */
  endpoint: string;
  /** Identifies the site to the ingestion endpoint. */
  siteKey: string;
  /** Stable session id. Default: a generated "agent-<rand>" per attach. */
  sessionId?: string;
  /** Resolves the current path. Default: `() => location.pathname`. */
  path?: () => string;
  /** Which activity sources to record. Default "all". */
  source?: "agent" | "flow" | "all";
  /** Flush interval in ms. Default 2000. */
  batchMs?: number;
}

function numericMeta(
  meta: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const v = meta?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Map one activity event to an `actor:"agent"` HeuristicsEvent. Activities
 * carrying a finite `meta.dwellMs` become `kind:"dwell"`; everything else is a
 * discrete `kind:"click"` with x/y/vw/vh pulled from numeric meta (default 0).
 * Mirrors `fancy-heuristics-js/src/agent.ts` `mapActivityToEvent`.
 */
export function mapActivityToEvent(
  e: AgentActivityEvent,
  path: string,
): HeuristicsEvent {
  const source = e.source ?? "agent";
  const targetId = e.target?.elementId;
  const label = e.target?.label;
  const meta: Record<string, unknown> = {
    action: e.action,
    agentId: e.agentId,
    source,
    kind: e.target?.kind,
  };
  const dwellMs = numericMeta(e.meta, "dwellMs");

  if (dwellMs !== undefined) {
    const ev: HeuristicsEvent = {
      kind: "dwell",
      actor: "agent",
      path,
      ts: e.timestamp,
      dwellMs,
      meta,
    };
    if (targetId !== undefined) ev.targetId = targetId;
    if (label !== undefined) ev.label = label;
    return ev;
  }

  const ev: HeuristicsEvent = {
    kind: "click",
    actor: "agent",
    path,
    ts: e.timestamp,
    x: numericMeta(e.meta, "x") ?? 0,
    y: numericMeta(e.meta, "y") ?? 0,
    vw: numericMeta(e.meta, "vw") ?? 0,
    vh: numericMeta(e.meta, "vh") ?? 0,
    meta,
  };
  if (targetId !== undefined) ev.targetId = targetId;
  if (label !== undefined) ev.label = label;
  return ev;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Subscribe to the in-page agent activity bus and forward each matching event
 * to the heuristics `/collect` endpoint as `actor:"agent"`. SSR-safe (returns a
 * no-op when there is no `window`). Returns an unsubscribe that flushes the
 * buffer and detaches all listeners/timers.
 */
export function attachHeuristicsSink(
  opts: AttachHeuristicsSinkOptions,
): () => void {
  // Browser guard — SSR-safe no-op.
  if (typeof window === "undefined") return () => {};

  const endpoint = opts.endpoint.replace(/\/$/, "");
  const url = `${endpoint}/collect`;
  const siteKey = opts.siteKey;
  const sessionId = opts.sessionId ?? `agent-${randomId()}`;
  const getPath = opts.path ?? (() => location.pathname);
  const source = opts.source ?? "all";
  const batchMs = opts.batchMs ?? 2000;

  // onActivity's `source` filter is strict-equality; only set it when we want a
  // single source. "all" subscribes unfiltered.
  const filter = source === "all" ? undefined : { source };

  let buffer: HeuristicsEvent[] = [];

  function flush(): void {
    if (buffer.length === 0) return;
    const events = buffer;
    buffer = [];
    const batch: CollectBatch = { siteKey, sessionId, events };
    const body = JSON.stringify(batch);
    try {
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.sendBeacon === "function"
      ) {
        const blob = new Blob([body], { type: "application/json" });
        navigator.sendBeacon(url, blob);
        return;
      }
    } catch {
      // fall through to fetch
    }
    try {
      void fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      });
    } catch {
      // never throw from a flush
    }
  }

  const unsubscribeActivity = onActivity((e) => {
    try {
      buffer.push(mapActivityToEvent(e, getPath()));
    } catch {
      // never let a malformed event break the bus
    }
  }, filter);

  const timer: ReturnType<typeof setInterval> = setInterval(flush, batchMs);

  const onPageHide = () => flush();
  const onVisibility = () => {
    if (document.visibilityState === "hidden") flush();
  };
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    unsubscribeActivity();
    window.removeEventListener("pagehide", onPageHide);
    document.removeEventListener("visibilitychange", onVisibility);
    clearInterval(timer);
    flush();
  };
}
