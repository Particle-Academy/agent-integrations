// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { createServerTransport, type PeerTransport, type PresenceChannelLike } from "../transport";
import { useCoworkSession } from "../use-cowork-session";

/*
 * A consumer's receiver (0.65.1): the admin's `cowork.intent` frames reached its socket
 * and NOTHING ran, not even 0.65.1's receive warnings, after its connection was
 * re-established (two `connection_established`, two socket ids). Measured against the
 * real laravel-echo 2.6.3 + pusher-js 8.6.0: a reconnect keeps a channel's bindings, but
 * a re-join (Echo.leave + Echo.join, or a second Echo) makes a NEW pusher channel object,
 * and the transport stays bound to the old, unsubscribed one. useCoworkSession kept the
 * first transport it saw, so sends still worked and every relayed intent went nowhere.
 *
 * Now: the hook restarts its session when the transport's CHANNEL changes (a transport
 * rebuilt inline on the same channel still does not restart it), and a server transport
 * warns once when its laravel-echo channel is no longer the live subscription.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A laravel-echo PusherPresenceChannel's shape, as far as the transport can see it. */
function echoChannel(client: { channels: Map<string, unknown>; state: string }, name = "presence-cowork.session.s1") {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const subscription = { name };
  client.channels.set(name, subscription);
  const channel = {
    name,
    subscription,
    pusher: { channel: (n: string) => client.channels.get(n), connection: { get state() { return client.state; } } },
    here() { return channel; },
    joining() { return channel; },
    leaving() { return channel; },
    whisper() { return channel; },
    listenForWhisper() { return channel; },
    stopListeningForWhisper() { return channel; },
    listen(event: string, cb: (p: unknown) => void) { (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(cb); return channel; },
    stopListening(event: string, cb?: (p: unknown) => void) { if (cb) listeners.get(event)?.delete(cb); return channel; },
    emit(event: string, payload: unknown) { for (const cb of listeners.get(event) ?? []) cb(payload); },
  };
  return channel;
}
const okFetch = (async () => ({ ok: true, status: 202, json: async () => ({}) })) as never;
const relay = (value: string) => ({ id: `e${value}`, session: "s1", from: "user:1", view: "user:1", revision: 0, at: 1, intent: { kind: "field", handle: "composer", value } });

describe("a server transport on a dead laravel-echo channel", () => {
  let warn: { mock: { calls: unknown[][] } };
  beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}) as never; });
  const warned = (text: string) => warn.mock.calls.filter((c) => String(c[0]).includes(text));

  it("warns once when the channel was left or re-joined (no longer the client's live subscription)", async () => {
    const client = { channels: new Map<string, unknown>(), state: "connected" };
    const channel = echoChannel(client);
    const t = createServerTransport({ sessionId: "s1", self: "user:4", channel: channel as unknown as PresenceChannelLike, fetch: okFetch });
    await t.send({ t: "intent", envelope: { id: "a", view: "user:4", revision: 0 }, intent: { kind: "scroll", y: 1 } });
    expect(warned("no longer")).toHaveLength(0);

    echoChannel(client); // Echo.leave + Echo.join: the client now holds a NEW channel object under that name
    await t.send({ t: "intent", envelope: { id: "b", view: "user:4", revision: 0 }, intent: { kind: "scroll", y: 2 } });
    await t.heartbeat!();
    expect(warned("no longer")).toHaveLength(1);
    expect(String(warned("no longer")[0]![0])).toContain("presence-cowork.session.s1");
  });

  it("warns when its client was disconnected (a second Echo replaced the first)", async () => {
    const client = { channels: new Map<string, unknown>(), state: "connected" };
    const t = createServerTransport({ sessionId: "s1", self: "user:4", channel: echoChannel(client) as unknown as PresenceChannelLike, fetch: okFetch });
    client.state = "disconnected";
    await t.heartbeat!();
    expect(warned("no longer")).toHaveLength(1);
  });

  it("says nothing for a channel without laravel-echo internals (fancy-query's own client, a double)", async () => {
    const { channel } = { channel: { here() { return this; }, joining() { return this; }, leaving() { return this; }, whisper() { return this; }, listenForWhisper() { return this; }, listen() { return this; }, stopListening() { return this; } } };
    const t = createServerTransport({ sessionId: "s1", self: "user:4", channel: channel as unknown as PresenceChannelLike, fetch: okFetch });
    await t.heartbeat!();
    expect(warn.mock.calls).toHaveLength(0);
  });
});

describe("useCoworkSession follows its transport's channel", () => {
  function Page(props: { transport: PeerTransport; onReady: (ready: boolean, blocked: unknown) => void }) {
    const s = useCoworkSession({
      sessionId: "s1", self: { ref: "user:4" }, transport: props.transport,
      config: { consent: "notify", control: { mode: "ranked", scope: "session", rank: { "user:1": 2, "user:4": 1 } } },
      authorize: () => true, presenceRouting: "server", sharedFields: ["composer"], heartbeatMs: 60_000,
    } as never);
    props.onReady(s.ready, s.blocked);
    return null;
  }
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  it("restarts on a NEW channel, so the session hears the channel the page now listens on", async () => {
    const client = { channels: new Map<string, unknown>(), state: "connected" };
    const first = echoChannel(client);
    const t1 = createServerTransport({ sessionId: "s1", self: "user:4", channel: first as unknown as PresenceChannelLike, fetch: okFetch });
    let blocked: unknown = null;
    const view = render(<Page transport={t1} onReady={(_r, b) => { blocked = b; }} />);
    await settle();

    const second = echoChannel(client); // the page re-joined
    const t2 = createServerTransport({ sessionId: "s1", self: "user:4", channel: second as unknown as PresenceChannelLike, fetch: okFetch });
    view.rerender(<Page transport={t2} onReady={(_r, b) => { blocked = b; }} />);
    await settle();

    await act(async () => { second.emit(".cowork.intent", relay("Hello")); await new Promise((r) => setTimeout(r, 0)); });
    await settle();
    expect(blocked).toMatchObject({ by: "user:1", mode: "ranked" });
  });

  it("does NOT restart for a transport rebuilt inline on the SAME channel", async () => {
    const client = { channels: new Map<string, unknown>(), state: "connected" };
    const channel = echoChannel(client);
    const listen = vi.spyOn(channel, "listen");
    const make = () => createServerTransport({ sessionId: "s1", self: "user:4", channel: channel as unknown as PresenceChannelLike, fetch: okFetch });
    const view = render(<Page transport={make()} onReady={() => {}} />);
    await settle();
    const bound = listen.mock.calls.filter((c) => c[0] === ".cowork.intent").length;
    for (let i = 0; i < 3; i++) {
      view.rerender(<Page transport={make()} onReady={() => {}} />);
      await settle();
    }
    // Every inline transport binds once as it is CREATED; none restarted the session, so
    // the session's own listener is still the first one, and it still hears the channel.
    let blocked: unknown = null;
    view.rerender(<Page transport={make()} onReady={(_r, b) => { blocked = b; }} />);
    await settle();
    await act(async () => { channel.emit(".cowork.intent", relay("Hi")); await new Promise((r) => setTimeout(r, 0)); });
    await settle();
    expect(bound).toBeGreaterThan(0);
    expect(blocked).toMatchObject({ by: "user:1" });
  });
});
