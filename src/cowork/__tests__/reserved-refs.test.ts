import { describe, expect, it } from "vitest";

import { createSessionState, evaluateIntent, evaluateJoin, resolveConfig, type EngineHost } from "../engine";
import { peerFromMember, readFrame } from "../transport";

/*
 * Code scanning alert 4 (js/prototype-polluting-assignment, src/cowork/engine.ts):
 * a peer-supplied `view` keyed the session's state maps, so `view: "__proto__"`
 * resolved to Object.prototype and the commit wrote onto it. Refs are now refused
 * at every boundary, and the maps are null-prototype.
 */
const RESERVED = ["__proto__", "constructor", "prototype"] as const;

const host = (mode: "free" | "baton" = "free"): EngineHost => ({
  identity: true,
  config: resolveConfig({ control: { mode } }),
  members: () => true,
  authorize: () => true,
});
const twoPeers = () =>
  createSessionState({ id: "s", state: "live", starter: "a", participants: [{ ref: "a", route: "/" }, { ref: "b", route: "/" }], now: 0 });
const clean = () => {
  for (const key of ["a", "b", "polluted", "holder", "requests", "route", "revision"]) expect(Object.prototype).not.toHaveProperty(key);
};

describe("reserved names are never a ref on the client", () => {
  for (const ref of RESERVED) {
    it(`the engine refuses ${ref} as view, recipient, grant target and sender, and writes nothing`, async () => {
      const asView = await evaluateIntent(host(), twoPeers(), { from: "a", envelope: { view: ref, revision: 0 }, intent: { kind: "scroll", y: 1 }, now: 0 });
      expect(asView.decision).toEqual({ allow: false, reason: "cowork.invalid.intent", status: 422 });
      const asRecipient = await evaluateIntent(host(), twoPeers(), { from: "a", envelope: { to: [ref] }, intent: { kind: "app", topic: "t", payload: 1 }, now: 0 });
      expect(asRecipient.decision).toEqual({ allow: false, reason: "cowork.invalid.intent", status: 422 });
      const asTarget = await evaluateIntent(host("baton"), twoPeers(), { from: "a", envelope: { view: "a" }, intent: { kind: "control", op: "grant", target: ref }, now: 0 });
      expect(asTarget.decision).toEqual({ allow: false, reason: "cowork.invalid.intent", status: 422 });
      const asSender = await evaluateIntent(host(), twoPeers(), { from: ref, envelope: { view: "a", revision: 0 }, intent: { kind: "scroll", y: 1 }, now: 0 });
      expect(asSender.decision).toEqual({ allow: false, reason: "cowork.unidentified", status: 401 });
      const joining = await evaluateJoin(host(), twoPeers(), { from: ref, now: 0 });
      expect(joining.decision).toEqual({ allow: false, reason: "cowork.unidentified", status: 401 });
      clean();
    });

    it(`a presence member or a frame naming ${ref} is dropped before it reaches the session`, () => {
      expect(peerFromMember({ ref })).toBeNull();
      expect(peerFromMember({ id: ref })).toBeNull();
      expect(readFrame({ t: "activity", view: ref, handle: "h", active: true })).toBeNull();
      expect(readFrame({ t: "hello", route: "/", revision: 0, follows: ref })).toBeNull();
      expect(readFrame({ t: "follow", target: ref })).toBeNull();
      // Handles are not refs and keep their own rule.
      expect(readFrame({ t: "activity", view: "a", handle: ref, active: true })).not.toBeNull();
    });
  }

  it("keeps the ref-keyed maps null-prototype, including after a commit from an ordinary-object state", async () => {
    const plain = JSON.parse(JSON.stringify(twoPeers()));
    const after = await evaluateIntent(host(), plain, { from: "b", envelope: { view: "a", revision: 0 }, intent: { kind: "field", handle: "h", value: 1 }, now: 5 });
    expect(after.decision).toEqual({ allow: true });
    for (const map of [after.state.participants, after.state.control, after.state.last, after.state.rate, ...Object.values(after.state.last)]) {
      expect(Object.getPrototypeOf(map)).toBeNull();
    }
    clean();
  });
});
