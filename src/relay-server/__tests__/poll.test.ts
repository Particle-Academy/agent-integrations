// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayBroker } from "../core";
import { pollWaitMs } from "../node";
import { call, openStream, post, register, sleep, startRelay, TOKEN, until, type RunningRelay } from "./http";

/**
 * The long-poll receive leg: `GET /{session}/poll`.
 *
 * Cloudflare's HTTP/3 edge resets long-lived SSE streams, which kills a relay's
 * `events` leg; short requests pass. The PHP relay in px-ui-sandbox grew a
 * bounded long-poll for exactly that, and both clients speak it —
 * `@particle-academy/fancy-cf-relay` (the browser, `direction=inbound`) and
 * `mcp-relay-client` (the agent, `direction=outbound`). The Node relay answered
 * `404`, so either client pointed at it behind Cloudflare had nothing to fall
 * back to.
 *
 * The contract, as the PHP relay and fancy-cf-relay's README define it:
 *
 *   GET {base}/{session}/poll?token=…&direction=inbound|outbound&wait=<ms>&subscriber=<id>
 *     → 200 { "subscriber": "<16 hex>", "frames": ["<raw frame>", …] }
 *
 * The first describe block mirrors px-ui-sandbox's
 * tests/Feature/AgentRelayPollTest.php case for case, so the two relays are held
 * to the same assertions. The rest pins what only a persistent broker can
 * promise (a parked poll returns the moment a frame lands; reply scoping and
 * presence work the same as on SSE) and the one place the Node relay is
 * deliberately stricter: a gone session answers 410, as on every other route.
 */

let running: RunningRelay | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
  vi.useRealTimers();
});

const url = (base: string, session: string, query: string) => `${base}/${session}/poll?token=${TOKEN}&${query}`;

describe("mirrors px-ui-sandbox AgentRelayPollTest", () => {
  it("registers a subscriber and delivers a fanned-out frame on the next poll", async () => {
    running = await startRelay();
    await register(running.base, "poll-p1");

    // First poll (wait=0 → return immediately): hands out a subscriber id, no frames.
    const first = await call(url(running.base, "poll-p1", "direction=inbound&wait=0"));
    expect(first.status).toBe(200);
    const sub = first.json.subscriber;
    expect(sub).toMatch(/^[a-f0-9]{16}$/);
    expect(first.json.frames).toEqual([]);

    // An external client posts an inbound frame → fanned out to our subscriber.
    const frame = { jsonrpc: "2.0", id: 1, method: "tools/list", params: [] };
    expect((await post(`${running.base}/poll-p1/inbox?token=${TOKEN}`, frame)).status).toBe(200);

    // Poll again with the SAME subscriber → drains the queued frame.
    const second = await call(url(running.base, "poll-p1", `direction=inbound&wait=0&subscriber=${sub}`));
    expect(second.status).toBe(200);
    expect(second.json.subscriber).toBe(sub);
    expect(second.json.frames).toHaveLength(1);
    const delivered = JSON.parse(second.json.frames[0]);
    expect(delivered.method).toBe("tools/list");
    expect(delivered.id).toBe(1);
  });

  it("rejects an invalid token", async () => {
    running = await startRelay();
    await register(running.base, "poll-p2");

    const res = await call(`${running.base}/poll-p2/poll?token=wrong&wait=0`);

    expect(res.status).toBe(401);
  });

  it("caps the park window (wait is clamped) and returns a JSON envelope", async () => {
    running = await startRelay();
    await register(running.base, "poll-p3");

    const res = await call(url(running.base, "poll-p3", "wait=0"));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(Object.keys(res.json).sort()).toEqual(["frames", "subscriber"]);
  });
});

describe("the park window", () => {
  it("is clamped to 0..25000 ms, the PHP relay's cap, and defaults to 20000", () => {
    expect(pollWaitMs(null)).toBe(20000);
    expect(pollWaitMs("0")).toBe(0);
    expect(pollWaitMs("1500")).toBe(1500);
    expect(pollWaitMs("999999")).toBe(25000);
    expect(pollWaitMs("-5")).toBe(0);
    expect(pollWaitMs("abc")).toBe(0);
  });

  it("ends the moment a frame lands, not when the window runs out", async () => {
    running = await startRelay();
    await register(running.base, "park-1");
    const opened = await call(url(running.base, "park-1", "direction=inbound&wait=0"));
    const sub = opened.json.subscriber;

    const parked = call(url(running.base, "park-1", `direction=inbound&wait=10000&subscriber=${sub}`));
    await sleep(100);
    await post(`${running.base}/park-1/inbox?token=${TOKEN}`, { jsonrpc: "2.0", id: 9, method: "tools/list" });
    const res = await parked;

    expect(res.status).toBe(200);
    expect(res.json.frames).toHaveLength(1);
    expect(res.ms).toBeLessThan(5000);
  });

  it("returns an empty envelope when the window runs out", async () => {
    running = await startRelay();
    await register(running.base, "park-2");

    const res = await call(url(running.base, "park-2", "direction=inbound&wait=150"));

    expect(res.status).toBe(200);
    expect(res.json.frames).toEqual([]);
    expect(res.ms).toBeGreaterThanOrEqual(100);
  });

  it("loses nothing when the client gives up mid-park", async () => {
    // A poll the client aborted must not have taken frames with it: a frame
    // "delivered" into a closed socket is a frame nobody receives.
    running = await startRelay();
    await register(running.base, "park-3");
    const sub = (await call(url(running.base, "park-3", "direction=inbound&wait=0"))).json.subscriber;

    const ctrl = new AbortController();
    const abandoned = call(url(running.base, "park-3", `direction=inbound&wait=10000&subscriber=${sub}`), {
      signal: ctrl.signal,
    }).catch(() => null);
    await sleep(100);
    ctrl.abort();
    await abandoned;
    await sleep(50);

    await post(`${running.base}/park-3/inbox?token=${TOKEN}`, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    const next = await call(url(running.base, "park-3", `direction=inbound&wait=0&subscriber=${sub}`));

    expect(next.json.subscriber).toBe(sub);
    expect(next.json.frames).toHaveLength(1);
  });

  it("sends no-store, so no cache between the client and the relay replays an answer", async () => {
    running = await startRelay();
    await register(running.base, "park-4");

    const res = await call(url(running.base, "park-4", "wait=0"));

    expect(String(res.headers["cache-control"])).toMatch(/no-store/);
  });
});

describe("a poll subscriber is a subscriber like any other", () => {
  it("an agent polling outbound gets the reply to its request, the page polling inbound gets the request", async () => {
    running = await startRelay();
    await register(running.base, "rt-1");
    const page = (await call(url(running.base, "rt-1", "direction=inbound&wait=0"))).json.subscriber;
    const agent = (await call(url(running.base, "rt-1", "direction=outbound&wait=0"))).json.subscriber;

    await post(`${running.base}/rt-1/inbox?token=${TOKEN}`, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const atPage = await call(url(running.base, "rt-1", `direction=inbound&wait=0&subscriber=${page}`));
    const request = atPage.json.frames.map((f: string) => JSON.parse(f)).find((f: { id?: number }) => f.id === 1);
    expect(request?.method).toBe("tools/list");

    await post(`${running.base}/rt-1/outbox?token=${TOKEN}`, { jsonrpc: "2.0", id: 1, result: { tools: [] } });
    const atAgent = await call(url(running.base, "rt-1", `direction=outbound&wait=0&subscriber=${agent}`));
    expect(atAgent.json.frames.map((f: string) => JSON.parse(f))).toEqual([{ jsonrpc: "2.0", id: 1, result: { tools: [] } }]);
  });

  it("tells the page an agent joined — an outbound poller is a peer, as on SSE", async () => {
    running = await startRelay();
    await register(running.base, "rt-2");
    const page = await openStream(`${running.base}/rt-2/events?token=${TOKEN}&direction=inbound`);

    const agent = await call(url(running.base, "rt-2", "direction=outbound&wait=0"));

    const joined = await until(() =>
      page.frames().some((f) => (f as { method?: string; params?: { subscriberId?: string } }).method === "notifications/peer_joined"
        && (f as { params: { subscriberId: string } }).params.subscriberId === agent.json.subscriber),
    );
    page.close();
    expect(joined).toBe(true);
  });

  it("announces the agent ONCE, not on every poll", async () => {
    running = await startRelay();
    await register(running.base, "rt-3");
    const page = await openStream(`${running.base}/rt-3/events?token=${TOKEN}&direction=inbound`);

    const sub = (await call(url(running.base, "rt-3", "direction=outbound&wait=0"))).json.subscriber;
    await call(url(running.base, "rt-3", `direction=outbound&wait=0&subscriber=${sub}`));
    await call(url(running.base, "rt-3", `direction=outbound&wait=0&subscriber=${sub}`));
    await sleep(100);

    const joins = page.frames().filter((f) => (f as { method?: string }).method === "notifications/peer_joined");
    page.close();
    expect(joins).toHaveLength(1);
  });

  it("scopes a reply to the polling client that asked, when clients label themselves", async () => {
    running = await startRelay();
    await register(running.base, "rt-4");
    const alice = (await call(url(running.base, "rt-4", "direction=outbound&wait=0&client=alice"))).json.subscriber;
    const mallory = (await call(url(running.base, "rt-4", "direction=outbound&wait=0&client=mallory"))).json.subscriber;

    await post(`${running.base}/rt-4/inbox?token=${TOKEN}&client=alice`, { jsonrpc: "2.0", id: 7, method: "tools/call" });
    await post(`${running.base}/rt-4/outbox?token=${TOKEN}`, { jsonrpc: "2.0", id: 7, result: { secret: true } });

    const atAlice = await call(url(running.base, "rt-4", `direction=outbound&wait=0&subscriber=${alice}`));
    const atMallory = await call(url(running.base, "rt-4", `direction=outbound&wait=0&subscriber=${mallory}`));
    expect(atAlice.json.frames).toHaveLength(1);
    expect(atMallory.json.frames).toEqual([]);
  });

  it("does not let a poll adopt an SSE subscriber's id", async () => {
    // The ids share one map. Reading a streaming subscriber's queue through a
    // poll would split its frames between two consumers.
    running = await startRelay();
    await register(running.base, "rt-5");
    const page = await openStream(`${running.base}/rt-5/events?token=${TOKEN}&direction=inbound`);
    const agent = await openStream(`${running.base}/rt-5/events?token=${TOKEN}&direction=outbound`);

    // The page learns the streaming agent's subscriber id from peer_joined.
    type Joined = { method?: string; params?: { subscriberId?: string } };
    const joinedFrame = () => page.frames().find((f) => (f as Joined).method === "notifications/peer_joined") as Joined | undefined;
    expect(await until(() => joinedFrame() !== undefined)).toBe(true);
    const sseId = joinedFrame()!.params!.subscriberId!;
    expect(sseId).toMatch(/^[a-f0-9]{16}$/);

    const res = await call(url(running.base, "rt-5", `direction=outbound&wait=0&subscriber=${sseId}`));

    page.close();
    agent.close();
    expect(res.status).toBe(200);
    expect(res.json.subscriber).not.toBe(sseId);
  });
});

describe("a gone session", () => {
  it("answers 410 session_gone, as every other route does", async () => {
    running = await startRelay();
    await register(running.base, "pg-1");
    await post(`${running.base}/pg-1/unregister?token=${TOKEN}`, "");

    const res = await call(url(running.base, "pg-1", "wait=0"));

    expect(res.status).toBe(410);
    expect(res.json).toEqual({ error: "session_gone" });
  });

  it("releases a parked poll when the session ends under it", async () => {
    running = await startRelay();
    await register(running.base, "pg-2");

    const parked = call(url(running.base, "pg-2", "direction=outbound&wait=10000"));
    await sleep(100);
    await post(`${running.base}/pg-2/unregister?token=${TOKEN}`, "");
    const res = await parked;

    expect(res.ms).toBeLessThan(5000);
  });
});

describe("a poller that stops polling", () => {
  it("is pruned after the idle window, and the page is told the agent left", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const broker = new RelayBroker({ reapIntervalMs: 1000, pollIdleMs: 60_000 });
    expect(broker.register("idle-1", TOKEN).ok).toBe(true);

    const page = broker.subscribe("idle-1", TOKEN, "inbound");
    if (!page.ok) throw new Error(page.reason);
    const seen: string[] = [];
    void (async () => {
      for await (const f of page.frames) seen.push(JSON.parse(f).method);
    })();

    const agent = broker.poll("idle-1", TOKEN, "outbound");
    if (!agent.ok) throw new Error(agent.reason);
    await agent.wait(0);

    vi.advanceTimersByTime(30_000);
    await Promise.resolve();
    expect(seen).not.toContain("notifications/peer_left");

    vi.advanceTimersByTime(40_000);
    await vi.waitFor(() => expect(seen).toContain("notifications/peer_left"));

    // Pruned means gone: the same id comes back as a NEW subscriber.
    const again = broker.poll("idle-1", TOKEN, "outbound", { subscriber: agent.subscriberId });
    expect(again.ok && again.created).toBe(true);

    page.unsubscribe();
    broker.dispose();
  });

  it("is never pruned while a poll is parked on it", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const broker = new RelayBroker({ reapIntervalMs: 1000, pollIdleMs: 60_000 });
    expect(broker.register("idle-2", TOKEN).ok).toBe(true);

    const agent = broker.poll("idle-2", TOKEN, "inbound");
    if (!agent.ok) throw new Error(agent.reason);
    const ctrl = new AbortController();
    const parked = agent.wait(25_000, ctrl.signal);

    vi.advanceTimersByTime(120_000);
    const again = broker.poll("idle-2", TOKEN, "inbound", { subscriber: agent.subscriberId });
    expect(again.ok && again.created).toBe(false);

    ctrl.abort();
    await parked;
    broker.dispose();
  });
});
