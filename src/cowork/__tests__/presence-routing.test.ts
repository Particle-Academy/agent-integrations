// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCoworkSession, type CoworkSession, type CoworkSessionOptions } from "../session";
import { createMemoryTransport, createServerTransport, type PresenceChannelLike } from "../transport";

/*
 * Server-routed presence. Sockudo (Genie's WebSockets service) delivers a
 * presence-channel client event WITHOUT the sender's `user_id`, so a whisper
 * cannot be attributed and is dropped. With `presenceRouting: "server"` cursors
 * and the masked-field "activity" indicator go through the intent endpoint
 * instead: the server stamps the sender and relays them.
 */

type Body = Record<string, unknown> & { intent?: { kind?: string } };

/**
 * A Pusher-protocol server double: relays POSTed intents to every OTHER
 * connection as `.cowork.intent`, stamped with the authenticated sender, and
 * delivers whispers either with the protocol's `userId` stamp (`stamps: true`,
 * as Reverb and Pusher do) or without it (`stamps: false`, as Sockudo does).
 */
function fakeServer({ stamps }: { stamps: boolean }) {
  type Conn = {
    ref: string;
    listeners: Map<string, Set<(payload: unknown) => void>>;
    whisperers: Map<string, Set<(data: unknown, meta?: { userId?: string }) => void>>;
    here: Array<(members: unknown[]) => void>;
  };
  const conns = new Map<string, Conn>();
  const posts: Array<{ from: string; url: string; body: Body }> = [];
  const whispers: Array<{ from: string; data: unknown }> = [];
  let answer: { status: number; reason: string } | null = null;

  const channelFor = (ref: string): PresenceChannelLike => {
    const conn: Conn = { ref, listeners: new Map(), whisperers: new Map(), here: [] };
    conns.set(ref, conn);
    const channel: PresenceChannelLike = {
      here(cb) { conn.here.push(cb); return channel; },
      joining() { return channel; },
      leaving() { return channel; },
      whisper(event, data) {
        whispers.push({ from: ref, data });
        for (const other of conns.values()) {
          if (other.ref === ref) continue;
          for (const cb of other.whisperers.get(event) ?? []) cb(data, stamps ? { userId: ref } : {});
        }
        return channel;
      },
      listenForWhisper(event, cb) {
        const set = conn.whisperers.get(event) ?? new Set();
        set.add(cb); conn.whisperers.set(event, set);
        return channel;
      },
      listen(event, cb) {
        const set = conn.listeners.get(event) ?? new Set();
        set.add(cb); conn.listeners.set(event, set);
        return channel;
      },
      stopListening() { return channel; },
    };
    return channel;
  };

  const fetchFor = (ref: string) => async (url: string, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    posts.push({ from: ref, url, body });
    if (answer) {
      const refusal = answer;
      return { ok: false, status: refusal.status, json: async () => ({ reason: refusal.reason }) } as unknown as Response;
    }
    if (url.endsWith("/intents")) {
      const { intent, socketId: _socket, ...envelope } = body;
      for (const other of conns.values()) {
        if (other.ref === ref) continue;
        for (const cb of other.listeners.get(".cowork.intent") ?? []) cb({ ...envelope, from: ref, intent });
      }
    }
    return { ok: true, status: 202, json: async () => ({}) } as unknown as Response;
  };

  return {
    channelFor,
    fetchFor,
    posts,
    whispers,
    refuseWith(status: number, reason: string) { answer = { status, reason }; },
    /** Everyone is here: the presence channel's member list, as the server's channel auth built it. */
    seat(refs: string[]) {
      const members = refs.map((ref) => ({ ref, label: ref.toUpperCase() }));
      for (const conn of conns.values()) for (const cb of conn.here) cb(members);
    },
    wire: () => JSON.stringify({ posts, whispers }),
  };
}

const HTML = '<input data-co-handle="title" /><input data-co-handle="pin" type="password" />';
const sessions: CoworkSession[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
});
afterEach(() => {
  for (const s of sessions.splice(0)) s.destroy();
  vi.useRealTimers();
});
const settle = () => vi.advanceTimersByTimeAsync(0);

function serverPeer(server: ReturnType<typeof fakeServer>, ref: string, extra: Partial<CoworkSessionOptions> = {}) {
  const root = document.createElement("div");
  root.innerHTML = HTML;
  document.body.appendChild(root);
  const refused: unknown[] = [];
  const session = createCoworkSession({
    sessionId: "s1",
    self: { ref, label: ref.toUpperCase() },
    transport: createServerTransport({ sessionId: "s1", self: ref, channel: server.channelFor(ref), fetch: server.fetchFor(ref) as never }),
    config: { control: { mode: "free" } },
    authorize: () => true,
    root,
    onRefused: (info) => refused.push(info),
    ...extra,
  });
  sessions.push(session);
  return { session, root, refused };
}

const cursorOf = (session: CoworkSession, ref: string) => session.getSnapshot().peers.find((p) => p.ref === ref)?.cursor ?? null;
const activeOf = (session: CoworkSession, ref: string) => session.getSnapshot().peers.find((p) => p.ref === ref)?.activeField ?? null;
const presencePosts = (server: ReturnType<typeof fakeServer>, kind: string) => server.posts.filter((p) => p.body.intent?.kind === kind);
const presenceWhispers = (server: ReturnType<typeof fakeServer>, t: string) =>
  server.whispers.filter((w) => (w.data as { frame?: { t?: string } }).frame?.t === t);

describe("presenceRouting: server", () => {
  it("relays a cursor through the server on a socket server that does not stamp senders", async () => {
    const server = fakeServer({ stamps: false });
    const a = serverPeer(server, "a", { presenceRouting: "server" });
    const b = serverPeer(server, "b", { presenceRouting: "server" });
    server.seat(["a", "b"]);
    await settle();

    a.session.moveCursor({ x: 5, y: 6 });
    await settle();

    expect(presencePosts(server, "cursor")).toHaveLength(1);
    expect(presencePosts(server, "cursor")[0]!.body.intent).toEqual({ kind: "cursor", route: "/", x: 5, y: 6 });
    expect(presenceWhispers(server, "cursor")).toEqual([]);
    expect(cursorOf(b.session, "a")).toEqual({ x: 5, y: 6 });
  });

  it("relays the masked field's activity, and the value never leaves the browser", async () => {
    const server = fakeServer({ stamps: false });
    const a = serverPeer(server, "a", { presenceRouting: "server" });
    const b = serverPeer(server, "b", { presenceRouting: "server" });
    server.seat(["a", "b"]);
    await settle();

    await a.session.reportField("pin", "4242");
    await settle();

    expect(activeOf(b.session, "a")).toBe("pin");
    expect(presencePosts(server, "activity").map((p) => p.body.intent)).toEqual([{ kind: "activity", handle: "pin", active: true }]);
    expect(presenceWhispers(server, "activity")).toEqual([]);
    expect(server.wire()).not.toContain("4242");
  });

  it("throttles cursors to 10 per second by default, and to the host's interval when set", async () => {
    const server = fakeServer({ stamps: false });
    const a = serverPeer(server, "a", { presenceRouting: "server" });
    serverPeer(server, "b", { presenceRouting: "server" });
    server.seat(["a", "b"]);
    await settle();
    for (let t = 0; t < 250; t += 10) {
      a.session.moveCursor({ x: t, y: t });
      await vi.advanceTimersByTimeAsync(10);
    }
    await settle();
    expect(presencePosts(server, "cursor")).toHaveLength(3); // 0, 100 and 200 ms

    const slow = fakeServer({ stamps: false });
    const c = serverPeer(slow, "c", { presenceRouting: "server", cursorIntervalMs: 250 });
    serverPeer(slow, "d", { presenceRouting: "server" });
    slow.seat(["c", "d"]);
    await settle();
    for (let t = 0; t < 240; t += 10) {
      c.session.moveCursor({ x: t, y: t });
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(presencePosts(slow, "cursor")).toHaveLength(1);
  });

  it("shows a relayed cursor only to a peer on the same route", async () => {
    const server = fakeServer({ stamps: false });
    const a = serverPeer(server, "a", { presenceRouting: "server" });
    const b = serverPeer(server, "b", { presenceRouting: "server" });
    server.seat(["a", "b"]);
    await settle();
    await b.session.reportVisit("/elsewhere");
    await settle();

    a.session.moveCursor({ x: 1, y: 1 });
    await settle();

    expect(presencePosts(server, "cursor")).toHaveLength(1);
    expect(cursorOf(b.session, "a")).toBeNull();
  });

  it("drops a refused presence intent quietly: reported once, never retried", async () => {
    const server = fakeServer({ stamps: false });
    const a = serverPeer(server, "a", { presenceRouting: "server" });
    serverPeer(server, "b", { presenceRouting: "server" });
    server.seat(["a", "b"]);
    await settle();
    server.refuseWith(429, "cowork.denied.rate");

    for (let i = 0; i < 5; i += 1) {
      a.session.moveCursor({ x: i, y: i });
      await vi.advanceTimersByTimeAsync(100);
    }
    await settle();

    expect(presencePosts(server, "cursor")).toHaveLength(5); // one per throttle tick, no retries
    const rate = a.refused.filter((r) => (r as { reason?: string }).reason === "cowork.denied.rate");
    expect(rate).toHaveLength(1);
  });

  it("is refused at the sender like any intent when the host does not authorise it", async () => {
    const server = fakeServer({ stamps: false });
    const a = serverPeer(server, "a", { presenceRouting: "server", authorize: (_ref, ability) => ability !== "intent:cursor" });
    serverPeer(server, "b", { presenceRouting: "server" });
    server.seat(["a", "b"]);
    await settle();
    a.session.moveCursor({ x: 1, y: 1 });
    await settle();
    expect(presencePosts(server, "cursor")).toEqual([]);
    expect(a.refused).toEqual([expect.objectContaining({ reason: "cowork.denied.authorize", kind: "cursor" })]);
  });
});

describe("presenceRouting: auto and direct", () => {
  it("auto routes presence through the server on a server transport", async () => {
    const server = fakeServer({ stamps: false });
    const a = serverPeer(server, "a");
    const b = serverPeer(server, "b");
    server.seat(["a", "b"]);
    await settle();
    a.session.moveCursor({ x: 2, y: 2 });
    await settle();
    expect(presencePosts(server, "cursor")).toHaveLength(1);
    expect(presenceWhispers(server, "cursor")).toEqual([]);
    expect(cursorOf(b.session, "a")).toEqual({ x: 2, y: 2 });
  });

  it("auto whispers on a direct transport, exactly as before", async () => {
    const hub = createMemoryTransport();
    const mk = (ref: string) => {
      const root = document.createElement("div");
      document.body.appendChild(root);
      const session = createCoworkSession({ sessionId: "s", self: { ref }, transport: hub.connect({ ref }), config: { control: { mode: "free" } }, authorize: () => true, root });
      sessions.push(session);
      return session;
    };
    const a = mk("a");
    const b = mk("b");
    await settle();
    a.moveCursor({ x: 3, y: 3 });
    await settle();
    expect(hub.wire.filter((m) => (m.frame as { t?: string }).t === "cursor")).toHaveLength(1);
    expect(hub.wire.some((m) => (m.frame as { intent?: { kind?: string } }).intent?.kind === "cursor")).toBe(false);
    expect(cursorOf(b, "a")).toEqual({ x: 3, y: 3 });
  });

  it("direct on a server transport whispers, and a stamping server attributes it", async () => {
    const server = fakeServer({ stamps: true });
    const a = serverPeer(server, "a", { presenceRouting: "direct" });
    const b = serverPeer(server, "b", { presenceRouting: "direct" });
    server.seat(["a", "b"]);
    await settle();
    a.session.moveCursor({ x: 4, y: 4 });
    await settle();
    expect(presencePosts(server, "cursor")).toEqual([]);
    expect(presenceWhispers(server, "cursor")).toHaveLength(1);
    expect(cursorOf(b.session, "a")).toEqual({ x: 4, y: 4 });
  });

  it("still drops a whisper whose sender the server did not stamp", async () => {
    const server = fakeServer({ stamps: false });
    const a = serverPeer(server, "a", { presenceRouting: "direct" });
    const b = serverPeer(server, "b", { presenceRouting: "direct" });
    server.seat(["a", "b"]);
    await settle();
    a.session.moveCursor({ x: 4, y: 4 });
    await settle();
    expect(presenceWhispers(server, "cursor")).toHaveLength(1);
    expect(cursorOf(b.session, "a")).toBeNull();
  });
});
