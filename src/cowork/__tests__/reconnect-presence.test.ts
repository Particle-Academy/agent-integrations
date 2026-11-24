// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCoworkSession, type CoworkSession, type CoworkSessionOptions } from "../session";
import { createServerTransport, createWhisperTransport, type PresenceChannelLike, type PeerTransport } from "../transport";

/*
 * Lab test 87, runs 1287 and 1300 (Laravel host, Pusher-protocol WebSockets): both
 * pages' sockets dropped and came back. A cursor move POSTed in the gap was accepted
 * (202) and relayed to nobody, because a Pusher-protocol server keeps no history.
 * After the reconnect each page re-authorized its channel and re-synced the session
 * (GET), but nothing re-sent presence, so the peer kept the stale position until the
 * next move (ivy's cursor at 824896, then nothing until 832832).
 *
 * The double below behaves like such a server: a relayed intent or a whisper reaches
 * only the connections subscribed at that moment, a (re)subscription answers the
 * subscriber with `here` (the members connected now) and tells the others
 * `member_added`, and a drop tells the connected others `member_removed`.
 */

type Conn = {
  ref: string;
  connected: boolean;
  here: Array<(members: unknown[]) => void>;
  joining: Array<(member: unknown) => void>;
  leaving: Array<(member: unknown) => void>;
  listeners: Map<string, Set<(payload: unknown) => void>>;
  whispers: Map<string, Set<(data: unknown, meta?: { userId?: string }) => void>>;
};

function socketServer() {
  const conns = new Map<string, Conn>();
  const participants = new Map<string, { ref: string; label: string; route: string; revision: number; follows: null }>();
  const posts: Array<{ from: string; body: Record<string, unknown> }> = [];
  const member = (ref: string) => ({ ref, label: ref.toUpperCase() });
  const live = () => [...conns.values()].filter((c) => c.connected);

  return {
    posts,
    participants,
    join(ref: string, route = "/doc") {
      participants.set(ref, { ref, label: ref.toUpperCase(), route, revision: 0, follows: null });
    },
    channel(ref: string): PresenceChannelLike {
      const conn: Conn = { ref, connected: false, here: [], joining: [], leaving: [], listeners: new Map(), whispers: new Map() };
      conns.set(ref, conn);
      const channel: PresenceChannelLike = {
        here(cb) { conn.here.push(cb); return channel; },
        joining(cb) { conn.joining.push(cb); return channel; },
        leaving(cb) { conn.leaving.push(cb); return channel; },
        whisper(event, data) {
          // pusher-js drops a client event while it is not connected.
          if (!conn.connected) return channel;
          for (const other of live()) if (other !== conn) other.whispers.get(event)?.forEach((cb) => cb(data, { userId: ref }));
          return channel;
        },
        listenForWhisper(event, cb) {
          const set = conn.whispers.get(event) ?? new Set();
          set.add(cb);
          conn.whispers.set(event, set);
          return channel;
        },
        stopListeningForWhisper(event, cb) { if (cb) conn.whispers.get(event)?.delete(cb); return channel; },
        listen(event, cb) {
          const set = conn.listeners.get(event) ?? new Set();
          set.add(cb);
          conn.listeners.set(event, set);
          return channel;
        },
        stopListening(event, cb) { if (cb) conn.listeners.get(event)?.delete(cb); return channel; },
      };
      return channel;
    },
    /** A (re)subscription: `here` to the subscriber, `member_added` to everyone else connected. */
    connect(ref: string) {
      const conn = conns.get(ref)!;
      conn.connected = true;
      const members = live().map((c) => member(c.ref));
      conn.here.forEach((cb) => cb(members));
      for (const other of live()) if (other !== conn) other.joining.forEach((cb) => cb(member(ref)));
    },
    /** A re-acknowledgement only the subscriber hears (no member_added for the others). */
    reack(ref: string) {
      const conn = conns.get(ref)!;
      const members = live().map((c) => member(c.ref));
      conn.here.forEach((cb) => cb(members));
    },
    /** These sockets drop together: `member_removed` to whoever is still connected. */
    disconnect(...refs: string[]) {
      for (const ref of refs) conns.get(ref)!.connected = false;
      for (const ref of refs) for (const other of live()) other.leaving.forEach((cb) => cb(member(ref)));
    },
    fetchFor(ref: string) {
      return async (url: string, init?: { method?: string; body?: unknown }) => {
        const method = init?.method ?? "GET";
        const ok = (status: number, json: unknown) => ({ ok: true, status, json: async () => json }) as unknown as Response;
        if (method === "GET") return ok(200, { session: { id: "s1", state: "live", control: { mode: "free", views: {} }, participants: [...participants.values()] } });
        if (url.endsWith("/heartbeat")) return ok(204, {});
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        posts.push({ from: ref, body });
        // Accepted even while the poster's socket is down (HTTP is not the socket), and
        // relayed to whoever is subscribed NOW. No history is kept.
        const { intent, socketId: _s, ...envelope } = body;
        for (const other of live()) {
          if (other.ref === ref) continue;
          other.listeners.get(".cowork.intent")?.forEach((cb) => cb({ ...envelope, session: "s1", from: ref, at: Date.now(), intent }));
        }
        return ok(202, { id: body.id });
      };
    },
  };
}

type Kind = "server" | "direct";
const sessions: CoworkSession[] = [];

function open(server: ReturnType<typeof socketServer>, ref: string, kind: Kind, extra: Partial<CoworkSessionOptions> = {}): CoworkSession {
  const channel = server.channel(ref);
  const transport: PeerTransport = kind === "server"
    ? createServerTransport({ sessionId: "s1", self: ref, channel, fetch: server.fetchFor(ref) as never })
    : createWhisperTransport({ channel, self: ref });
  const session = createCoworkSession({
    sessionId: "s1",
    self: { ref, label: ref.toUpperCase() },
    transport,
    config: { consent: "none", control: { mode: "free" }, routing: kind, limits: { mask: ["secret"] } } as never,
    authorize: () => true,
    presenceRouting: kind,
    heartbeatMs: 600_000,
    idleAfterMs: 5_000,
    blockInput: false,
    ...extra,
  });
  sessions.push(session);
  server.connect(ref);
  return session;
}

const peer = (session: CoworkSession, ref: string) => session.getSnapshot().peers.find((p) => p.ref === ref);
const cursorPosts = (server: ReturnType<typeof socketServer>, from: string) =>
  server.posts.filter((p) => p.from === from && (p.body.intent as { kind?: string }).kind === "cursor").map((p) => {
    const { kind: _k, route: _r, ...at } = p.body.intent as Record<string, unknown>;
    return at;
  });

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
});
afterEach(() => {
  for (const s of sessions.splice(0)) s.destroy();
  vi.useRealTimers();
});

describe.each<Kind>(["server", "direct"])("after a reconnect, a page re-publishes its latest presence (%s routing)", (kind) => {
  it.each([
    ["the watcher reconnects first", ["jon", "ivy"]],
    ["the mover reconnects first", ["ivy", "jon"]],
  ])("a cursor moved during the gap reaches the peer once both are back: %s", async (_label, order) => {
    const server = socketServer();
    server.join("ivy");
    server.join("jon");
    const ivy = open(server, "ivy", kind);
    const jon = open(server, "jon", kind);
    await vi.advanceTimersByTimeAsync(50);

    ivy.moveCursor({ x: 10, y: 10 });
    await vi.advanceTimersByTimeAsync(200);
    expect(peer(jon, "ivy")?.cursor).toEqual({ x: 10, y: 10 });

    // Both sockets drop together, as in runs 1287 and 1300.
    server.disconnect("ivy", "jon");
    ivy.moveCursor({ x: 200, y: 200 });
    await vi.advanceTimersByTimeAsync(200);
    ivy.moveCursor({ x: 300, y: 400 });
    await vi.advanceTimersByTimeAsync(200);
    // Delivered to nobody: the server keeps no history.
    expect(peer(jon, "ivy")?.cursor).toEqual({ x: 10, y: 10 });
    const beforeReconnect = cursorPosts(server, "ivy").length;

    for (const ref of order) server.connect(ref);
    await vi.advanceTimersByTimeAsync(200);

    expect(peer(jon, "ivy")?.cursor).toEqual({ x: 300, y: 400 });
    if (kind === "server") {
      // Only the latest position is re-sent, never the history.
      const resent = cursorPosts(server, "ivy").slice(beforeReconnect);
      expect(resent.length).toBeGreaterThan(0);
      for (const at of resent) expect(at).toEqual({ x: 300, y: 400 });
    }
  });

  it("re-publishes the masked-field activity indicator too", async () => {
    const server = socketServer();
    server.join("ivy");
    server.join("jon");
    const root = document.createElement("div");
    root.innerHTML = '<input data-co-handle="secret">';
    document.body.appendChild(root);
    const ivy = open(server, "ivy", kind, { root });
    const jon = open(server, "jon", kind);
    await vi.advanceTimersByTimeAsync(50);

    server.disconnect("ivy", "jon");
    await ivy.reportField("secret", "hunter2");
    await vi.advanceTimersByTimeAsync(200);
    expect(peer(jon, "ivy")?.activeField).toBeNull();

    server.connect("jon");
    server.connect("ivy");
    await vi.advanceTimersByTimeAsync(200);
    expect(peer(jon, "ivy")?.activeField).toBe("secret");
    // The value itself never left ivy's browser.
    expect(JSON.stringify(server.posts)).not.toContain("hunter2");
  });

  it("a re-sent cursor or activity is idempotent at the peer: not a new move, not a new event", async () => {
    const server = socketServer();
    server.join("ivy");
    server.join("jon");
    const root = document.createElement("div");
    root.innerHTML = '<input data-co-handle="secret">';
    document.body.appendChild(root);
    const ivy = open(server, "ivy", kind, { root });
    const jon = open(server, "jon", kind);
    await vi.advanceTimersByTimeAsync(50);

    ivy.moveCursor({ x: 10, y: 10 });
    await ivy.reportField("secret", "x");
    await vi.advanceTimersByTimeAsync(200);
    expect(peer(jon, "ivy")).toMatchObject({ cursor: { x: 10, y: 10 }, activeField: "secret" });

    // Ivy does nothing for longer than idleAfterMs: jon shows her idle.
    await vi.advanceTimersByTimeAsync(6_000);
    jon.refresh();
    expect(peer(jon, "ivy")?.idle).toBe(true);
    let notified = 0;
    jon.subscribe(() => { notified += 1; });

    // The same position and the same activity arrive again (what a re-publish sends).
    ivy.moveCursor({ x: 10, y: 10 });
    await ivy.reportField("secret", "y");
    await vi.advanceTimersByTimeAsync(200);
    jon.refresh();
    expect(peer(jon, "ivy")).toMatchObject({ cursor: { x: 10, y: 10 }, activeField: "secret", idle: true });
    expect(notified).toBe(0);

    // Ivy's channel re-acknowledges (a resubscribe the server does not announce as a
    // new member): she re-publishes, and jon, who already has it, sees nothing new.
    const posted = server.posts.length;
    server.reack("ivy");
    await vi.advanceTimersByTimeAsync(200);
    jon.refresh();
    if (kind === "server") expect(server.posts.length).toBeGreaterThan(posted);
    expect(peer(jon, "ivy")).toMatchObject({ cursor: { x: 10, y: 10 }, activeField: "secret", idle: true });
    expect(notified).toBe(0);
  });
});

describe("membership after a reconnect (already handled by the presence channel's `here`)", () => {
  it("a member_removed or member_added missed during the gap is corrected from the `here` list", async () => {
    const server = socketServer();
    const ivy = open(server, "ivy", "direct");
    const jon = open(server, "jon", "direct");
    await vi.advanceTimersByTimeAsync(50);
    expect(jon.getSnapshot().peers.map((p) => p.ref).sort()).toEqual(["ivy", "jon"]);

    server.disconnect("jon");
    // While jon is away, ivy leaves and kim arrives: jon hears neither.
    server.disconnect("ivy");
    ivy.destroy();
    open(server, "kim", "direct");
    await vi.advanceTimersByTimeAsync(50);
    expect(jon.getSnapshot().peers.map((p) => p.ref).sort()).toEqual(["ivy", "jon"]);

    server.connect("jon");
    await vi.advanceTimersByTimeAsync(50);
    expect(jon.getSnapshot().peers.map((p) => p.ref).sort()).toEqual(["jon", "kim"]);
  });
});
