import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RelayBroker } from "../core";

const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz01";

/**
 * A tool reply must reach the agent that ASKED, not everyone holding the token.
 *
 * ## The composition, which nobody chose
 *
 * Two decisions, each defensible alone:
 *
 *   1. `fanOut` pushes every frame to every subscriber on that direction.
 *   2. The session token is bearer authority with no per-agent identity — the
 *      broker cannot tell two holders apart.
 *
 * Together they mean a second holder of the token does not merely gain the
 * ability to CALL tools. **They passively receive the results of everyone
 * else's calls, without making one.** The surface is a live application page,
 * so those results carry whatever the bridges expose — records, message bodies,
 * anything the app can read.
 *
 * That turns the token from *authority to act on this surface* into *authority
 * to watch everyone acting on this surface*. A share link granting action is a
 * thing a host can reason about; one granting surveillance of other
 * participants is a different offer, and it falls out of two sensible decisions
 * meeting rather than from anyone deciding it.
 *
 * Found by the Prism harness, composing two answers I had given separately —
 * each piece defensible, the composition the defect, and nothing looking at
 * compositions.
 *
 * ## And it contradicts our own spec
 *
 * `docs/relay-protocol.md` already says: *"tool-call replies go back on the
 * transport that originated the call."* The relay never implemented that. So
 * this is a defect against a written contract, not a design trade-off — which
 * is why the fix restores the documented behaviour rather than inventing one.
 */
describe("replies route to the caller, not to every token holder", () => {
  let broker: RelayBroker;

  beforeEach(() => {
    broker = new RelayBroker();
    expect(broker.register("sess", TOKEN).ok).toBe(true);
  });
  afterEach(() => broker.dispose());

  /**
   * Read whatever is waiting for a subscriber, without blocking.
   *
   * `subscribe()` returns an async generator, not the subscriber object -- so
   * this races each `next()` against a zero timer. A generator with nothing
   * queued simply never resolves, and awaiting it directly would hang the test
   * rather than assert an empty delivery, which is the case that matters most
   * here.
   */
  async function drain(sub: { frames: AsyncGenerator<string, void, void> }): Promise<string[]> {
    const out: string[] = [];

    for (;;) {
      const frame = await Promise.race([
        sub.frames.next().then((r) => (r.done ? null : r.value)),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 10)),
      ]);

      if (frame === null) return out;
      out.push(frame);
    }
  }

  function ok(result: ReturnType<RelayBroker["subscribe"]>) {
    if (!result.ok) throw new Error("subscribe failed: " + result.reason);
    return result;
  }

  it("delivers a RESPONSE only to the client whose request it answers", async () => {
    const alice = ok(broker.subscribe("sess", TOKEN, "outbound", { client: "alice" }));
    const mallory = ok(broker.subscribe("sess", TOKEN, "outbound", { client: "mallory" }));
        // Alice asks. Mallory does nothing at all.
    broker.inbox("sess", TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" }), {
      client: "alice",
    });

    // The page answers.
    broker.outbox(
      "sess",
      TOKEN,
      JSON.stringify({ jsonrpc: "2.0", id: 7, result: { secret: "customer records" } }),
    );

    expect(await drain(alice)).toHaveLength(1);

    // THE POINT. Mallory made no call and must learn nothing from Alice's.
    expect(await drain(mallory)).toEqual([]);
  });

  it("still broadcasts NOTIFICATIONS to every subscriber", async () => {
    // A notification has no `id` and answers nobody. Presence, activity and
    // server-pushed state are meant for every attached client -- narrowing
    // those would break the collaboration model this exists to serve.
    const alice = ok(broker.subscribe("sess", TOKEN, "outbound", { client: "alice" }));
    const bob = ok(broker.subscribe("sess", TOKEN, "outbound", { client: "bob" }));

    broker.outbox(
      "sess",
      TOKEN,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { hi: true } }),
    );

    expect(await drain(alice)).toHaveLength(1);
    expect(await drain(bob)).toHaveLength(1);
  });

  it("delivers a response to an UNCORRELATED id to nobody, rather than to everyone", async () => {
    // An id the broker never saw asked for cannot be routed. Broadcasting it
    // "just in case" is the exact leak -- fail closed.
    const alice = ok(broker.subscribe("sess", TOKEN, "outbound", { client: "alice" }));

    broker.outbox("sess", TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 999, result: { x: 1 } }));

    expect(await drain(alice)).toEqual([]);
  });

  it("routes to the right client when two ask at once", async () => {
    const alice = ok(broker.subscribe("sess", TOKEN, "outbound", { client: "alice" }));
    const bob = ok(broker.subscribe("sess", TOKEN, "outbound", { client: "bob" }));

    broker.inbox("sess", TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "a" }), { client: "alice" });
    broker.inbox("sess", TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "b" }), { client: "bob" });

    broker.outbox("sess", TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 2, result: { forBob: true } }));
    broker.outbox("sess", TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { forAlice: true } }));

    expect((await drain(alice)).join()).toContain("forAlice");
    expect((await drain(bob)).join()).toContain("forBob");
  });

  it("still reaches the page: inbound requests go to the browser subscriber", async () => {
    // The inbound direction is unchanged -- the browser is the single consumer
    // and must receive every request regardless of who sent it.
    const page = ok(broker.subscribe("sess", TOKEN, "inbound"));

    broker.inbox("sess", TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call" }), {
      client: "alice",
    });

    expect(await drain(page)).toHaveLength(1);
  });

  it("an id is consumed once, so a replayed response reaches nobody", async () => {
    // Correlation is not a standing subscription. Leaving the mapping in place
    // would let a second frame carrying the same id be delivered again -- and
    // it also bounds the map, which is otherwise a slow leak on a long session.
    const alice = ok(broker.subscribe("sess", TOKEN, "outbound", { client: "alice" }));

    broker.inbox("sess", TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 5, method: "x" }), { client: "alice" });
    broker.outbox("sess", TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 5, result: { first: true } }));
    expect(await drain(alice)).toHaveLength(1);

    broker.outbox("sess", TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 5, result: { replayed: true } }));
    expect(await drain(alice)).toEqual([]);
  });
});
