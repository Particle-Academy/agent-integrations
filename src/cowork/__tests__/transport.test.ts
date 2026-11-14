import { describe, expect, it, vi } from "vitest";

import {
  createMemoryTransport,
  createServerTransport,
  createWhisperTransport,
  type CoworkFrame,
  type PresenceChannelLike,
  type PresenceEvent,
  type ReceivedFrame,
} from "../transport";

/** A presence channel the way fancy-query/socket and laravel-echo shape one. */
function fakeChannel() {
  const whispers = new Map<string, Set<(data: unknown, meta?: { userId?: string }) => void>>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const presence = { here: [] as Array<(m: unknown[]) => void>, joining: [] as Array<(m: unknown) => void>, leaving: [] as Array<(m: unknown) => void> };
  const sent: Array<{ event: string; data: unknown }> = [];
  const channel: PresenceChannelLike = {
    here(cb) { presence.here.push(cb); return channel; },
    joining(cb) { presence.joining.push(cb); return channel; },
    leaving(cb) { presence.leaving.push(cb); return channel; },
    whisper(event, data) { sent.push({ event, data }); return channel; },
    listenForWhisper(event, cb) {
      const set = whispers.get(event) ?? new Set(); set.add(cb); whispers.set(event, set); return channel;
    },
    stopListeningForWhisper(event, cb) { if (cb) whispers.get(event)?.delete(cb); else whispers.delete(event); return channel; },
    listen(event, cb) { const set = listeners.get(event) ?? new Set(); set.add(cb); listeners.set(event, set); return channel; },
    stopListening(event, cb) { if (cb) listeners.get(event)?.delete(cb); else listeners.delete(event); return channel; },
  };
  return {
    channel,
    sent,
    here: (members: unknown[]) => presence.here.forEach((cb) => cb(members)),
    joining: (member: unknown) => presence.joining.forEach((cb) => cb(member)),
    leaving: (member: unknown) => presence.leaving.forEach((cb) => cb(member)),
    peerWhisper: (event: string, data: unknown, meta?: { userId?: string }) => whispers.get(event)?.forEach((cb) => cb(data, meta)),
    broadcast: (event: string, payload: unknown) => listeners.get(event)?.forEach((cb) => cb(payload)),
    listenerCount: () => [...whispers.values(), ...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

const cursor: CoworkFrame = { t: "cursor", route: "/doc/1", x: 10, y: 20 };

describe("memory transport", () => {
  it("delivers a frame to every OTHER endpoint, stamped with the sender's identity", async () => {
    const hub = createMemoryTransport();
    const a = hub.connect({ ref: "a" });
    const b = hub.connect({ ref: "b" });
    const c = hub.connect({ ref: "c" });
    const got = { a: [] as ReceivedFrame[], b: [] as ReceivedFrame[], c: [] as ReceivedFrame[] };
    a.onFrame((m) => got.a.push(m)); b.onFrame((m) => got.b.push(m)); c.onFrame((m) => got.c.push(m));
    expect(await a.send(cursor)).toEqual({ allow: true });
    expect(got.a).toEqual([]);
    expect(got.b).toEqual([{ from: "a", frame: cursor }]);
    expect(got.c).toEqual([{ from: "a", frame: cursor }]);
    expect(hub.wire).toEqual([{ from: "a", frame: cursor }]);
  });

  it("reports presence: here on connect, joining to the others, leaving on close", () => {
    const hub = createMemoryTransport();
    const a = hub.connect({ ref: "a", label: "Ada" });
    const events: PresenceEvent[] = [];
    a.onPresence((e) => events.push(e));
    expect(events).toEqual([{ type: "here", peers: [{ ref: "a", label: "Ada" }] }]);
    const b = hub.connect({ ref: "b" });
    expect(events.at(-1)).toEqual({ type: "joining", peer: { ref: "b" } });
    b.close();
    expect(events.at(-1)).toEqual({ type: "leaving", peer: { ref: "b" } });
    expect(hub.peers()).toEqual([{ ref: "a", label: "Ada" }]);
  });

  it("sends nothing after close", async () => {
    const hub = createMemoryTransport();
    const a = hub.connect({ ref: "a" });
    const b = hub.connect({ ref: "b" });
    const got: ReceivedFrame[] = [];
    b.onFrame((m) => got.push(m));
    a.close();
    expect((await a.send(cursor)).allow).toBe(false);
    expect(got).toEqual([]);
  });
});

describe("whisper transport (direct routing)", () => {
  const members = [{ ref: "a", label: "Ada" }, { ref: "b", label: "Bea" }];

  it("maps the channel's members to peers", () => {
    const fake = fakeChannel();
    const t = createWhisperTransport({ channel: fake.channel, self: "a" });
    const events: PresenceEvent[] = [];
    t.onPresence((e) => events.push(e));
    fake.here(members);
    fake.joining({ ref: "c" });
    fake.leaving({ ref: "c" });
    expect(events).toEqual([
      { type: "here", peers: [{ ref: "a", label: "Ada" }, { ref: "b", label: "Bea" }] },
      { type: "joining", peer: { ref: "c" } },
      { type: "leaving", peer: { ref: "c" } },
    ]);
  });

  it("whispers frames under one event and never puts a sender in the payload", async () => {
    const fake = fakeChannel();
    const t = createWhisperTransport({ channel: fake.channel, self: "a" });
    expect(await t.send(cursor)).toEqual({ allow: true });
    expect(fake.sent).toEqual([{ event: "cowork", data: { v: 1, frame: cursor } }]);
  });

  it("takes the sender from the SERVER-stamped userId, never from the frame", () => {
    const fake = fakeChannel();
    const t = createWhisperTransport({ channel: fake.channel, self: "a" });
    const got: ReceivedFrame[] = [];
    t.onFrame((m) => got.push(m));
    fake.here(members);
    fake.peerWhisper("cowork", { v: 1, from: "admin", frame: { ...cursor, from: "admin" } }, { userId: "b" });
    expect(got).toHaveLength(1);
    expect(got[0]!.from).toBe("b");
  });

  it("drops a whisper it cannot attribute: no stamped sender, a non-member, or itself", () => {
    const fake = fakeChannel();
    const t = createWhisperTransport({ channel: fake.channel, self: "a" });
    const got: ReceivedFrame[] = [];
    t.onFrame((m) => got.push(m));
    fake.here(members);
    fake.peerWhisper("cowork", { v: 1, frame: cursor });
    fake.peerWhisper("cowork", { v: 1, frame: cursor }, {});
    fake.peerWhisper("cowork", { v: 1, frame: cursor }, { userId: "mallory" });
    fake.peerWhisper("cowork", { v: 1, frame: cursor }, { userId: "a" });
    fake.peerWhisper("cowork", { v: 2, frame: cursor }, { userId: "b" });
    fake.peerWhisper("cowork", "not a frame", { userId: "b" });
    fake.peerWhisper("cowork", { v: 1, frame: { t: "teleport" } }, { userId: "b" });
    expect(got).toEqual([]);
  });

  it("stops listening on close", () => {
    const fake = fakeChannel();
    const t = createWhisperTransport({ channel: fake.channel, self: "a" });
    expect(fake.listenerCount()).toBeGreaterThan(0);
    t.close();
    expect(fake.listenerCount()).toBe(0);
  });
});

describe("server transport (server routing)", () => {
  const envelope = { view: "b", revision: 3, to: ["b"] };
  const intent = { kind: "field" as const, handle: "name", value: "Ada" };

  it("POSTs an intent to the session's intents endpoint and reads 202 as allowed", async () => {
    const fake = fakeChannel();
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ id: "i1", revision: 4 }), { status: 202 }));
    const t = createServerTransport({ sessionId: "s 1", endpoint: "/app", fetch, channel: fake.channel, self: "a", socketId: () => "12.34" });
    expect(await t.send({ t: "intent", envelope, intent })).toEqual({ allow: true });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/app/cowork/sessions/s%201/intents");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ intent, view: "b", revision: 3, to: ["b"], socketId: "12.34" });
    expect(fake.sent).toEqual([]);
  });

  it("hands back the server's refusal, reason and all", async () => {
    const fake = fakeChannel();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ reason: "cowork.denied.control", blockedUntil: 900 }), { status: 409 }));
    const t = createServerTransport({ sessionId: "s1", fetch, channel: fake.channel, self: "a" });
    expect(await t.send({ t: "intent", envelope, intent })).toEqual({ allow: false, reason: "cowork.denied.control", status: 409, blockedUntil: 900 });
  });

  it("refuses with a named reason when the request itself fails", async () => {
    const fake = fakeChannel();
    const t = createServerTransport({ sessionId: "s1", fetch: async () => { throw new Error("offline"); }, channel: fake.channel, self: "a" });
    expect(await t.send({ t: "intent", envelope, intent })).toEqual({ allow: false, reason: "cowork.transport.failed", status: 0 });
  });

  it("delivers the server's relayed intents with the server-stamped sender", () => {
    const fake = fakeChannel();
    const t = createServerTransport({ sessionId: "s1", fetch: vi.fn(), channel: fake.channel, self: "b" });
    const got: ReceivedFrame[] = [];
    t.onFrame((m) => got.push(m));
    fake.broadcast(".cowork.intent", { id: "i1", session: "s1", from: "a", view: "b", revision: 3, at: 5, intent });
    expect(got).toEqual([{ from: "a", frame: { t: "intent", envelope: { id: "i1", session: "s1", view: "b", revision: 3, at: 5 }, intent } }]);
  });

  it("never accepts an intent that arrives as a peer whisper, only what the server relayed", () => {
    const fake = fakeChannel();
    const t = createServerTransport({ sessionId: "s1", fetch: vi.fn(), channel: fake.channel, self: "b" });
    const got: ReceivedFrame[] = [];
    t.onFrame((m) => got.push(m));
    fake.here([{ ref: "a" }, { ref: "b" }]);
    fake.peerWhisper("cowork", { v: 1, frame: { t: "intent", envelope, intent } }, { userId: "a" });
    fake.peerWhisper("cowork", { v: 1, frame: cursor }, { userId: "a" });
    expect(got).toEqual([{ from: "a", frame: cursor }]);
  });

  it("sends lossy frames (cursors) as whispers, not through the server", async () => {
    const fake = fakeChannel();
    const fetch = vi.fn();
    const t = createServerTransport({ sessionId: "s1", fetch, channel: fake.channel, self: "a" });
    await t.send(cursor);
    expect(fetch).not.toHaveBeenCalled();
    expect(fake.sent).toEqual([{ event: "cowork", data: { v: 1, frame: cursor } }]);
  });
});
