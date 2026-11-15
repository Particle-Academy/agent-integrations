import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  DEFAULT_MIDDLEWARE,
  evaluateActivate,
  evaluateConsent,
  evaluateEnd,
  evaluateIntent,
  evaluateJoin,
  evaluateLeave,
  holderOf,
  rankedSummary,
  type Result,
} from "../engine";
import type { Envelope, Intent, SessionState } from "../types";
import { FIXTURES_SHA256, FX, RAW, expand, hostFor, sha256, stateFor, steps } from "./fixtures";

/*
 * The client engine is what `direct` routing runs at the sender and again at
 * every receiver, so it must decide exactly as the servers do. These are the
 * same fixtures the PHP and Node legs run.
 */
describe("co-work client engine: shared conformance fixtures", () => {
  it("is the pinned file, byte for byte", () => {
    expect(sha256(RAW)).toBe(FIXTURES_SHA256);
  });

  it("names the contract this leg implements", () => {
    expect(FX.contract).toBe("fancy-cowork/v1");
  });

  it("pins the same default stack and config this leg ships", () => {
    expect(FX.defaults.middleware).toEqual([...DEFAULT_MIDDLEWARE]);
    expect(FX.defaults.config).toEqual(DEFAULT_CONFIG);
  });

  for (const c of FX.cases) {
    it(c.name, async () => {
      const host = hostFor(c);
      let state: SessionState = stateFor(c);
      for (const [i, step] of steps(c).entries()) {
        const now = step.at ?? 0;
        const from = step.from ?? "";
        const actor = step.actingFor !== undefined ? { actingFor: step.actingFor } : {};
        if (step.op === "expectView") {
          const view = state.participants[step.view!];
          expect({ step: i, route: view?.route, revision: view?.revision }).toEqual({
            step: i,
            route: step.route,
            revision: step.revision,
          });
          continue;
        }
        if (step.op === "expectRanked") {
          const summary = rankedSummary(state, host.config!);
          expect({ step: i, ...summary, ranks: { ...summary?.ranks } }).toEqual({ step: i, ranks: step.ranks, scope: step.scope, idleMs: step.idleMs });
          continue;
        }
        if (step.op === "expectHolder") {
          const control = holderOf(state, step.view!);
          expect({ step: i, holder: control.holder }).toEqual({ step: i, holder: step.holder });
          if (step.requests) expect({ step: i, requests: control.requests }).toEqual({ step: i, requests: step.requests });
          continue;
        }
        let result: Result;
        if (step.op === "intent") {
          const envelope = { ...(step.envelope ?? {}) } as Envelope;
          result = await evaluateIntent(host, state, { from, ...actor, envelope, intent: expand(step.intent) as Intent, now });
        } else if (step.op === "join") result = await evaluateJoin(host, state, { from, ...actor, now });
        else if (step.op === "activate") result = await evaluateActivate(host, state, { from, ...actor, now });
        else if (step.op === "consent") result = await evaluateConsent(host, state, { from, ...actor, now });
        else if (step.op === "end") result = await evaluateEnd(host, state, { from, ...actor, now });
        else result = await evaluateLeave(host, state, { from, ...actor, now });
        expect({ step: i, op: step.op, at: now, decision: result.decision }).toEqual({
          step: i,
          op: step.op,
          at: now,
          decision: step.expect,
        });
        state = result.state;
      }
    });
  }
});
