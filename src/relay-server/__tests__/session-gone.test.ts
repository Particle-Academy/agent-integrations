import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RelayBroker } from "../core";

const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz01";

/**
 * "The surface is gone" must be REPORTABLE, and distinct from "your token is wrong".
 *
 * `validate()` returned a bare boolean for three different states — no
 * credentials supplied, the session does not exist, and the token does not
 * match — and the HTTP layer mapped all three to `401 invalid_token`.
 *
 * So an agent holding a perfectly good token, attaching to a session whose page
 * has closed or expired, is told **its credentials are wrong**. It is not a
 * missing signal; it is an actively misleading one, and it sends the reader to
 * check an auth path that was never the problem.
 *
 * This matters more here than it looks, because of what a relay session IS.
 * There is no durability by design: the browser is the server, and no state
 * persists across restarts. A session ending is therefore the NORMAL end of a
 * lifecycle, not an exceptional case — the one outcome every server-side
 * consumer must be able to recognise and handle.
 *
 * Requested by the Prism harness while designing a non-Node relay client, in
 * their words: attaching to a dead session must fail clearly "rather than
 * looking like a page with no tools". The reality was one notch worse than the
 * shape they were guarding against.
 *
 * The same absent-versus-wrong collapse as an unresolvable path yielding `''`,
 * one layer out: several states, one value, and the reader sent somewhere
 * useless.
 */
describe("a gone session is distinguishable from a bad token", () => {
  let broker: RelayBroker;

  beforeEach(() => {
    broker = new RelayBroker();
    expect(broker.register("sess", TOKEN).ok).toBe(true);
  });
  afterEach(() => broker.dispose());

  it("reports a live session with a good token as ok", () => {
    expect(broker.check("sess", TOKEN)).toEqual({ ok: true });
  });

  it("reports a WRONG TOKEN on a live session as invalid_token", () => {
    // Unchanged, and it must stay that way: widening the new reason to cover
    // this would tell an attacker which half of the pair was wrong.
    expect(broker.check("sess", "tok_wrongwrongwrongwrongwrong1")).toEqual({
      ok: false,
      reason: "invalid_token",
    });
  });

  it("reports a session that never existed as session_gone", () => {
    expect(broker.check("nope", TOKEN)).toEqual({ ok: false, reason: "session_gone" });
  });

  it("reports an EXPIRED session as session_gone, not as a bad token", () => {
    // The case that actually bites: the token is correct, the page has simply
    // closed. Answering `invalid_token` here sends the operator to debug auth.
    broker.dropSession("sess");

    expect(broker.check("sess", TOKEN)).toEqual({ ok: false, reason: "session_gone" });
  });

  it("still reports missing credentials as invalid_token", () => {
    // Absent credentials are a caller error, not a lifecycle event. Folding
    // them into `session_gone` would report a dead page for a request that
    // never named one.
    // Narrowed rather than reached for: `check()` returns a DISCRIMINATED
    // UNION, so a bare `.reason` would not compile -- which is the type system
    // enforcing exactly the distinction this change is about.
    expect(broker.check("", TOKEN)).toEqual({ ok: false, reason: "invalid_token" });
    expect(broker.check("sess", "")).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("keeps validate() answering a boolean for existing callers", () => {
    // `check()` is additive. `validate()` is the shipped surface and its
    // contract does not change -- a consumer on 0.42 keeps working, and this
    // pins that rather than trusting it.
    expect(broker.validate("sess", TOKEN)).toBe(true);
    expect(broker.validate("sess", "tok_wrongwrongwrongwrongwrong1")).toBe(false);
    expect(broker.validate("nope", TOKEN)).toBe(false);
  });
});
