// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { RelayBroker } from "../core";
import { call, openStream, post, register, startRelay, TOKEN, until, type RunningRelay } from "./http";

/**
 * The `events` route keeps the promise docs/relay-server.md makes for EVERY
 * route: a session that has ended answers `410 session_gone`, and only a wrong
 * token on a live session answers `401`.
 *
 * 0.43.0 taught the POST routes that distinction and left `events` behind: its
 * subscribe path still went through the boolean `validate()`, so an agent
 * re-attaching its SSE leg to a closed page was told `401 invalid_token` —
 * precisely the misleading answer 0.43.0 existed to remove, on the one route a
 * reconnecting client hits first.
 */

let running: RunningRelay | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe("GET /{session}/events on a session that is gone", () => {
  it("answers 410 session_gone after the session was unregistered", async () => {
    running = await startRelay();
    await register(running.base, "gone-1");
    await post(`${running.base}/gone-1/unregister?token=${TOKEN}`, "");

    const res = await call(`${running.base}/gone-1/events?token=${TOKEN}&direction=outbound`);

    expect(res.status).toBe(410);
    expect(res.body).toContain("session_gone");
  });

  it("answers 410 for a session that never existed", async () => {
    running = await startRelay();

    const res = await call(`${running.base}/never-1/events?token=${TOKEN}`);

    expect(res.status).toBe(410);
  });

  it("still answers 401 invalid_token for a wrong token on a LIVE session", async () => {
    // Answering session_gone here would tell an unauthenticated caller which
    // sessions exist.
    running = await startRelay();
    await register(running.base, "live-1");

    const res = await call(`${running.base}/live-1/events?token=tok_wrongwrongwrongwrongwrong1`);

    expect(res.status).toBe(401);
    expect(res.body).toContain("invalid_token");
  });

  it("still answers 401 when no token is supplied", async () => {
    running = await startRelay();
    await register(running.base, "live-2");

    const res = await call(`${running.base}/live-2/events`);

    expect(res.status).toBe(401);
  });
});

describe("an open SSE leg when its session ends", () => {
  it("is ended by the server, so the client reconnects and learns 410", async () => {
    // It used to stay open, heartbeating, for a session that no longer existed:
    // unregister dropped the subscriber from the map without waking its stream.
    // A client could not find out the page had closed without timing out.
    running = await startRelay();
    await register(running.base, "end-1");
    const agent = await openStream(`${running.base}/end-1/events?token=${TOKEN}&direction=outbound`);
    expect(agent.status).toBe(200);

    await post(`${running.base}/end-1/unregister?token=${TOKEN}`, "");

    const ended = await Promise.race([agent.ended.then(() => true), new Promise((r) => setTimeout(() => r(false), 2000))]);
    agent.close();
    expect(ended).toBe(true);
  });
});

describe("frames fanned out in the same tick", () => {
  it("all reach a streaming subscriber — none is swallowed", async () => {
    // `fanOut` handed a frame to the waiting generator by calling its resolver,
    // but left the resolver in place until the generator resumed on a later
    // microtask. A second frame in the same tick called the already-settled
    // resolver again, which does nothing — after shifting the frame out of the
    // queue. The frame was simply gone.
    const broker = new RelayBroker({ reapIntervalMs: 0 });
    expect(broker.register("tick-1", TOKEN).ok).toBe(true);
    const page = broker.subscribe("tick-1", TOKEN, "inbound");
    if (!page.ok) throw new Error(page.reason);

    const received: string[] = [];
    void (async () => {
      for await (const frame of page.frames) received.push(frame);
    })();
    await new Promise((r) => setTimeout(r, 10)); // the generator is now parked

    broker.inbox("tick-1", TOKEN, JSON.stringify({ jsonrpc: "2.0", method: "notifications/a" }));
    broker.inbox("tick-1", TOKEN, JSON.stringify({ jsonrpc: "2.0", method: "notifications/b" }));
    broker.inbox("tick-1", TOKEN, JSON.stringify({ jsonrpc: "2.0", method: "notifications/c" }));

    expect(await until(() => received.length === 3, 500)).toBe(true);
    page.unsubscribe();
    broker.dispose();
  });
});
