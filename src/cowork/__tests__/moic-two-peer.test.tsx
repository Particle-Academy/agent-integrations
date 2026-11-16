// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { bindCoworkDom } from "../dom-binding";
import { createCoworkSession, type CoworkSession, type CoworkSessionOptions } from "../session";
import { createServerTransport, type PresenceChannelLike } from "../transport";
import { useCoworkSession, type CoworkSessionHandle } from "../use-cowork-session";
import type { NavigationBridgeAdapter } from "../../bridges/navigation";

/*
 * MOIC's two-browser report against fancy-cowork 0.3.0 + agent-integrations
 * 0.63.0, reproduced through the real session, hook and bindCoworkDom against
 * a server double that behaves like fancy-cowork's server and laravel-echo:
 *
 * - the presence channel is joined (Echo.join, memoized) BEFORE the transport
 *   attaches, so its subscription has already succeeded and laravel-echo never
 *   calls a `here` registered afterwards;
 * - POSTed intents are relayed to the other connections stamped with the
 *   server-identified sender; whispers arrive unstamped (Sockudo);
 * - the server knows who joined and where (`GET /cowork/sessions/{id}`).
 *
 * Identities as MOIC sent them: the admin is `user:1` acting for `user:4`,
 * Bob is `user:4`.
 */

type Participant = { ref: string; label: string; route: string; revision: number; follows: string | null; actingFor?: string };
type Conn = {
  ref: string;
  subscribed: boolean;
  listeners: Map<string, Set<(payload: unknown) => void>>;
  here: Array<(members: unknown[]) => void>;
  joining: Array<(member: unknown) => void>;
  leaving: Array<(member: unknown) => void>;
};

function moicServer() {
  const participants = new Map<string, Participant>();
  const conns = new Map<string, Conn>();
  const requests: Array<{ from: string; method: string; url: string; body: Record<string, unknown> }> = [];
  const member = (ref: string) => ({ ref, label: participants.get(ref)?.label ?? ref, view: ref });

  return {
    requests,
    participants,
    /** The host's own POST join, made before the page mounts its session. */
    join(ref: string, route: string, actingFor?: string) {
      participants.set(ref, { ref, label: ref.toUpperCase(), route, revision: 0, follows: null, ...(actingFor ? { actingFor } : {}) });
    },
    /** Echo.join: subscribes at once. Callbacks registered later do not see this acknowledgement. */
    subscribe(ref: string, opts: { announce?: boolean } = {}): PresenceChannelLike {
      const conn: Conn = { ref, subscribed: false, listeners: new Map(), here: [], joining: [], leaving: [] };
      const channel: PresenceChannelLike = {
        here(cb) { conn.here.push(cb); if (conn.subscribed) { /* laravel-echo: already fired, never again */ } return channel; },
        joining(cb) { conn.joining.push(cb); return channel; },
        leaving(cb) { conn.leaving.push(cb); return channel; },
        whisper() { return channel; },
        listenForWhisper() { return channel; },
        listen(event, cb) {
          const set = conn.listeners.get(event) ?? new Set();
          set.add(cb);
          conn.listeners.set(event, set);
          return channel;
        },
        stopListening() { return channel; },
      };
      conns.set(ref, conn);
      // The acknowledgement: only callbacks registered by now see it (none, when Echo.join ran first).
      conn.subscribed = true;
      for (const cb of conn.here) cb([...conns.keys()].map(member));
      if (opts.announce !== false) for (const other of conns.values()) if (other !== conn) for (const cb of other.joining) cb(member(ref));
      return channel;
    },
    fetchFor(ref: string) {
      return async (url: string, init?: { method?: string; body?: unknown }) => {
        const method = init?.method ?? "GET";
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        requests.push({ from: ref, method, url, body });
        const ok = (status: number, json: unknown) => ({ ok: true, status, json: async () => json }) as unknown as Response;
        if (method === "GET" && /\/cowork\/sessions\/s1$/.test(url)) {
          return ok(200, { session: { id: "s1", state: "live", control: { mode: "ranked", views: {} }, participants: [...participants.values()] } });
        }
        if (url.endsWith("/heartbeat")) return ok(204, {});
        if (url.endsWith("/intents")) {
          const intent = body.intent as { kind: string; url?: string };
          const view = body.view as string | undefined;
          if (intent.kind === "visit" && view && participants.has(view)) {
            const p = participants.get(view)!;
            p.route = String(intent.url).split(/[?#]/)[0]!;
            p.revision += 1;
          }
          const { intent: _i, socketId: _s, ...envelope } = body;
          for (const other of conns.values()) {
            if (other.ref === ref) continue;
            // As fancy-cowork-php relays it: id, session, from, view/revision/to, at, intent.
            for (const cb of other.listeners.get(".cowork.intent") ?? []) cb({ ...envelope, session: "s1", from: ref, at: Date.now(), intent });
          }
          return ok(202, { id: body.id });
        }
        return ok(200, {});
      };
    },
  };
}

function page(): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = '<textarea data-co-handle="composer"></textarea><div contenteditable="true" data-co-handle="note"></div>';
  document.body.appendChild(root);
  return root;
}

function recordingAdapter(calls: Array<[string, unknown]>): NavigationBridgeAdapter {
  return {
    getLocation: () => ({ url: "/dashboard", title: "" }),
    describe: () => ({ url: "/dashboard", title: "", actions: [] }),
    visit: (url) => { calls.push(["visit", url]); },
    scrollTo: () => {},
    scrollBy: () => {},
    setField: (handle, value) => { calls.push([handle, value]); return { ok: true }; },
    click: () => ({ ok: true }),
    submit: () => ({ ok: true }),
  };
}

const RANK = (ref: string) => (ref === "user:1" ? 2 : 1);
const sessions: CoworkSession[] = [];
let clock = 10_000;

beforeEach(() => {
  vi.useFakeTimers();
  clock = 10_000;
  document.body.innerHTML = "";
});
afterEach(() => {
  for (const s of sessions.splice(0)) s.destroy();
  cleanup();
  vi.useRealTimers();
});
const settle = async () => { for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0); };

function peer(server: ReturnType<typeof moicServer>, ref: string, channel: PresenceChannelLike, extra: Partial<CoworkSessionOptions> = {}) {
  const calls: Array<[string, unknown]> = [];
  const refused: Array<{ reason: string }> = [];
  const root = page();
  const session = createCoworkSession({
    sessionId: "s1",
    self: { ref, label: ref.toUpperCase() },
    transport: createServerTransport({ sessionId: "s1", self: ref, channel, fetch: server.fetchFor(ref) as never }),
    adapter: recordingAdapter(calls),
    config: { consent: "notify", control: { mode: "ranked", scope: "session", rank: RANK, idleMs: 3000 } } as never,
    authorize: () => true,
    presenceRouting: "server",
    sharedFields: ["composer", "note"],
    root,
    now: () => clock,
    onRefused: (r) => refused.push(r),
    blockInput: { isUserEvent: (e) => (e as Event & { user?: boolean }).user === true },
    ...extra,
  });
  sessions.push(session);
  return { session, calls, refused, root };
}

/** MOIC's setup: both joined and subscribed (Echo.join) before either page mounts its session. */
function moic() {
  const server = moicServer();
  server.join("user:1", "/dashboard", "user:4");
  server.join("user:4", "/dashboard");
  const adminChannel = server.subscribe("user:1");
  const bobChannel = server.subscribe("user:4");
  return { server, adminChannel, bobChannel };
}

describe("MOIC two-browser report, reproduced", () => {
  it("sees the other person although laravel-echo's `here` fired before the transport attached (late join / '1 person')", async () => {
    const { server, adminChannel, bobChannel } = moic();
    const admin = peer(server, "user:1", adminChannel);
    const bob = peer(server, "user:4", bobChannel);
    await settle();

    expect(admin.session.getSnapshot().peers.map((p) => p.ref).sort()).toEqual(["user:1", "user:4"]);
    expect(bob.session.getSnapshot().peers.map((p) => p.ref).sort()).toEqual(["user:1", "user:4"]);
  });

  it("applies a shared field typed by the admin in Bob's page, and the reverse", async () => {
    const { server, adminChannel, bobChannel } = moic();
    const admin = peer(server, "user:1", adminChannel);
    const bob = peer(server, "user:4", bobChannel);
    await settle();

    await admin.session.reportField("composer", "Hello");
    await settle();
    expect(bob.calls).toContainEqual(["composer", "Hello"]);

    clock += 5_000; // past idleMs, so Bob is free to type
    await bob.session.reportField("note", "Hi admin");
    await settle();
    expect(admin.calls).toContainEqual(["note", "Hi admin"]);
  });

  it("trusts the server's verdict for a relayed intent from a peer it has not heard of yet, then learns the peer", async () => {
    const server = moicServer();
    server.join("user:4", "/dashboard");
    const bobChannel = server.subscribe("user:4");
    const bob = peer(server, "user:4", bobChannel);
    await settle();
    // The admin joins and subscribes AFTER Bob's re-sync; Bob hears only the relayed intent.
    server.join("user:1", "/dashboard", "user:4");
    // member_added missed (a reconnect, say): Bob learns of the admin only from the relayed intent.
    const adminChannel = server.subscribe("user:1", { announce: false });
    const admin = peer(server, "user:1", adminChannel);
    await settle();

    await admin.session.reportField("composer", "first");
    await settle();
    expect(bob.calls).toContainEqual(["composer", "first"]);
    expect(bob.session.getSnapshot().peers.map((p) => p.ref)).toContain("user:1");
  });

  it("re-syncs on a member join, so it learns where the joiner really is (a presence event carries no route)", async () => {
    const server = moicServer();
    server.join("user:4", "/dashboard");
    const bob = peer(server, "user:4", server.subscribe("user:4"));
    await settle();
    server.join("user:1", "/orders/7", "user:4");
    server.subscribe("user:1"); // announced: Bob's channel sees member_added
    await settle();
    expect(bob.session.getSnapshot().peers.find((p) => p.ref === "user:1")?.view.route).toBe("/orders/7");
  });

  it("drops a participant the server no longer lists (expired or left) on the next re-sync", async () => {
    const { server, adminChannel, bobChannel } = moic();
    const admin = peer(server, "user:1", adminChannel);
    peer(server, "user:4", bobChannel);
    await settle();
    expect(admin.session.getSnapshot().peers.map((p) => p.ref)).toContain("user:4");
    server.participants.delete("user:4"); // the server expired Bob
    server.join("user:9", "/dashboard");
    server.subscribe("user:9"); // a member join triggers the admin's re-sync
    await settle();
    expect(admin.session.getSnapshot().peers.map((p) => p.ref)).not.toContain("user:4");
  });

  it("session-scoped ranking holds Bob for real after the admin types (data-cowork-blocked, keys swallowed, his field refused at the sender)", async () => {
    const { server, adminChannel, bobChannel } = moic();
    const admin = peer(server, "user:1", adminChannel);
    const bob = peer(server, "user:4", bobChannel);
    await settle();

    await admin.session.reportField("composer", "typing");
    await settle();

    expect(bob.session.getSnapshot().blocked).toMatchObject({ by: "user:1", mode: "ranked", until: clock + 3000 });
    expect(bob.root.getAttribute("data-cowork-blocked")).toBe("ranked");
    const key = Object.assign(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }), { user: true });
    bob.root.querySelector("textarea")!.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);

    const before = server.requests.filter((r) => r.from === "user:4" && r.url.endsWith("/intents")).length;
    clock += 1_000;
    const decision = await bob.session.reportField("composer", "mine");
    expect(decision).toMatchObject({ allow: false, reason: "cowork.denied.control" });
    expect(server.requests.filter((r) => r.from === "user:4" && r.url.endsWith("/intents")).length).toBe(before);

    clock += 2_000; // exactly idleMs after the admin's intent
    expect((await bob.session.reportField("composer", "mine")).allow).toBe(true);
  });

  it("marks who is online and sends a heartbeat on a server transport", async () => {
    const { server, adminChannel, bobChannel } = moic();
    const admin = peer(server, "user:1", adminChannel, { heartbeatMs: 30_000 });
    peer(server, "user:4", bobChannel);
    await settle();

    expect(admin.session.getSnapshot().peers.every((p) => p.online === true)).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.requests.some((r) => r.from === "user:1" && r.method === "POST" && r.url.endsWith("/cowork/sessions/s1/heartbeat"))).toBe(true);
  });
});

describe("MOIC's mirror sequence: a contenteditable composer mounted after the session is ready", () => {
  /** Keydown, then the editing host's text, then an InputEvent on the host: what a browser does per key. */
  async function typeInto(host: HTMLElement, text: string, every = 40) {
    for (const ch of text) {
      host.dispatchEvent(Object.assign(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }), { user: true }));
      host.textContent = (host.textContent ?? "") + ch;
      host.dispatchEvent(Object.assign(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }), { user: true }));
      await vi.advanceTimersByTimeAsync(every);
    }
  }
  const fieldPosts = (server: ReturnType<typeof moicServer>, from: string) =>
    server.requests.filter((r) => r.from === from && r.url.endsWith("/intents") && (r.body.intent as { kind?: string })?.kind === "field");

  it("reports the admin's typing and lands it in Bob's composer, with Bob held meanwhile", async () => {
    const { server, adminChannel, bobChannel } = moic();
    const admin = peer(server, "user:1", adminChannel);
    const bob = peer(server, "user:4", bobChannel);
    await settle();
    const isUser = (e: Event) => (e as Event & { user?: boolean }).user === true;
    // Bound once the session is ready, on the panel; the composer mounts later (New Chat).
    const unbindAdmin = bindCoworkDom(admin.session, { root: admin.root, isUserEvent: isUser });
    const unbindBob = bindCoworkDom(bob.session, { root: bob.root, isUserEvent: isUser });
    const composerFor = (root: HTMLElement) => {
      const el = document.createElement("div");
      el.setAttribute("contenteditable", "true");
      el.setAttribute("data-co-handle", "composer");
      root.querySelector("textarea")?.remove();
      root.appendChild(el);
      return el;
    };
    const adminComposer = composerFor(admin.root);
    composerFor(bob.root);
    await settle();

    adminComposer.dispatchEvent(Object.assign(new MouseEvent("click", { bubbles: true }), { user: true }));
    await typeInto(adminComposer, "Hello from support");
    adminComposer.dispatchEvent(Object.assign(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }), { user: true }));
    adminComposer.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(800);
    await settle();

    // Instrument: the admin's serial queue still answers a direct call.
    const direct = await Promise.race([
      admin.session.reportField("note", "probe").then(() => "settled"),
      vi.advanceTimersByTimeAsync(5_000).then(() => "stuck"),
    ]);
    expect(direct).toBe("settled");

    expect(fieldPosts(server, "user:1").length).toBeGreaterThan(0);
    expect(fieldPosts(server, "user:1").at(-1 - 1)?.body.intent).toMatchObject({ handle: "composer", value: "Hello from support" });
    expect(bob.calls).toContainEqual(["composer", "Hello from support"]);
    expect(bob.root.getAttribute("data-cowork-blocked")).toBe("ranked");
    unbindAdmin();
    unbindBob();
  });

  // MOIC's re-test on 0.4.0 / 0.64.0: they now report the current URL once the session
  // is ready, and follow each other. After that change the admin's typing sent NO field
  // intent (only visit, cursor, heartbeat), and Bob was not held until the server's 409.
  it("with reportVisit on ready and mutual follow: the admin's typing still posts, lands in Bob's composer, and holds Bob before he types", async () => {
    const { server, adminChannel, bobChannel } = moic();
    const admin = peer(server, "user:1", adminChannel);
    const bob = peer(server, "user:4", bobChannel);
    await settle();
    const isUser = (e: Event) => (e as Event & { user?: boolean }).user === true;
    const unbindAdmin = bindCoworkDom(admin.session, { root: admin.root, isUserEvent: isUser });
    const unbindBob = bindCoworkDom(bob.session, { root: bob.root, isUserEvent: isUser });
    // Once ready: report where each page is, then follow each other.
    await admin.session.reportVisit("/dashboard");
    await bob.session.reportVisit("/dashboard");
    await settle();
    await admin.session.follow("user:4");
    await bob.session.follow("user:1");
    await vi.advanceTimersByTimeAsync(1_500);
    await settle();

    const composerFor = (root: HTMLElement) => {
      const el = document.createElement("div");
      el.setAttribute("contenteditable", "true");
      el.setAttribute("data-co-handle", "composer");
      root.querySelector("textarea")?.remove();
      root.appendChild(el);
      return el;
    };
    const adminComposer = composerFor(admin.root);
    const bobComposer = composerFor(bob.root);
    await settle();

    adminComposer.dispatchEvent(Object.assign(new MouseEvent("click", { bubbles: true }), { user: true }));
    await typeInto(adminComposer, "Hello from support");
    await vi.advanceTimersByTimeAsync(400);
    await settle();

    expect(fieldPosts(server, "user:1").map((r) => (r.body.intent as { value?: unknown }).value)).toContain("Hello from support");
    // Bob is held BEFORE he types: the relayed admin intent alone sets the hold.
    expect(bob.root.getAttribute("data-cowork-blocked")).toBe("ranked");
    // ...and his keys are swallowed locally, so nothing of his is posted.
    const bobPostsBefore = fieldPosts(server, "user:4").length;
    await typeInto(bobComposer, "zz");
    await settle();
    expect(fieldPosts(server, "user:4").length).toBe(bobPostsBefore);
    expect(bob.calls).toContainEqual(["composer", "Hello from support"]);
    unbindAdmin();
    unbindBob();
  });

  // MOIC's next re-test: a new chat AUTOFOCUSES Bob's composer. The admin's value must
  // be applied into that focused field, because the relayed admin intent holds Bob, and
  // a held person cannot type, so there is nothing of his to protect.
  for (const kind of ["textarea", "contenteditable"] as const) {
    it(`a relayed admin value lands in Bob's FOCUSED ${kind} composer, and holds Bob, without waiting for his blur`, async () => {
      const { server, adminChannel, bobChannel } = moic();
      const admin = peer(server, "user:1", adminChannel, { now: () => Date.now() });
      const bob = peer(server, "user:4", bobChannel, { now: () => Date.now() });
      await settle();
      const isUser = (e: Event) => (e as Event & { user?: boolean }).user === true;
      const unbindAdmin = bindCoworkDom(admin.session, { root: admin.root, isUserEvent: isUser });
      await admin.session.reportVisit("/dashboard");
      await bob.session.reportVisit("/dashboard");
      await admin.session.follow("user:4");
      await bob.session.follow("user:1");
      await vi.advanceTimersByTimeAsync(4_000);
      await settle();

      const make = (root: HTMLElement) => {
        root.querySelector("textarea")?.remove();
        const el = document.createElement(kind === "textarea" ? "textarea" : "div");
        if (kind === "contenteditable") el.setAttribute("contenteditable", "true");
        el.setAttribute("data-co-handle", "composer");
        el.tabIndex = 0;
        root.appendChild(el);
        return el;
      };
      const adminComposer = make(admin.root);
      const bobComposer = make(bob.root);
      bobComposer.focus(); // the new chat's autofocus
      expect(document.activeElement).toBe(bobComposer);

      for (const ch of "Hello") {
        if (kind === "textarea") (adminComposer as HTMLTextAreaElement).value += ch;
        else adminComposer.textContent = (adminComposer.textContent ?? "") + ch;
        adminComposer.dispatchEvent(Object.assign(new InputEvent("input", { bubbles: true }), { user: true }));
        await vi.advanceTimersByTimeAsync(40);
      }
      await vi.advanceTimersByTimeAsync(400);
      await settle();

      expect(document.activeElement).toBe(bobComposer);
      expect(bob.session.getSnapshot().blocked).toMatchObject({ by: "user:1", mode: "ranked" });
      expect(bob.root.getAttribute("data-cowork-blocked")).toBe("ranked");
      expect(bob.calls).toContainEqual(["composer", "Hello"]);
      unbindAdmin();
    });
  }
});

describe("the hook and bindCoworkDom under MOIC's inline props", () => {
  function Room({ server, channel, refName, sharedFields, onHandle }: {
    server: ReturnType<typeof moicServer>;
    channel: PresenceChannelLike;
    refName: string;
    sharedFields: string[];
    onHandle: (h: CoworkSessionHandle, root: HTMLElement | null) => void;
  }) {
    // Memoized as MOIC does: transport on channel + sessionId + self.ref.
    const transport = useMemo(
      () => createServerTransport({ sessionId: "s1", self: refName, channel, fetch: server.fetchFor(refName) as never }),
      [channel, refName, server],
    );
    // Rebuilt on EVERY render, as MOIC does: self, config with a rank FUNCTION, authorize, sharedFields.
    const session = useCoworkSession({
      sessionId: "s1",
      self: { ref: refName, label: refName },
      transport,
      config: { consent: "notify", control: { mode: "ranked", scope: "session", rank: (r: string) => RANK(r), idleMs: 3000 } } as never,
      authorize: () => true,
      sharedFields,
      presenceRouting: "server",
      now: () => clock,
      adapter: recordingAdapter([]),
    });
    useEffect(() => (session.ready ? bindCoworkDom(session, { root: document.getElementById(`root-${refName.replace(":", "")}`) ?? undefined, isUserEvent: () => true }) : undefined), [session.ready, session.reportField]);
    onHandle(session, document.getElementById(`root-${refName.replace(":", "")}`));
    return (
      <div id={`root-${refName.replace(":", "")}`}>
        <textarea data-co-handle="composer" />
        <span data-testid="count">{session.peers.length}</span>
      </div>
    );
  }

  it("keeps ONE session across renders with inline self, config, authorize and sharedFields, and reads sharedFields live", async () => {
    const { server, adminChannel } = moic();
    let handle!: CoworkSessionHandle;
    const reportFields = new Set<unknown>();
    const view = render(<Room server={server} channel={adminChannel} refName="user:1" sharedFields={["composer"]} onHandle={(h) => { handle = h; reportFields.add(h.reportField); }} />);
    await act(async () => { await settle(); });
    for (let i = 0; i < 5; i++) {
      view.rerender(<Room server={server} channel={adminChannel} refName="user:1" sharedFields={["composer"]} onHandle={(h) => { handle = h; reportFields.add(h.reportField); }} />);
      await act(async () => { await settle(); });
    }
    expect(handle.ready).toBe(true);
    // One live session: reportField never changed identity after it became ready.
    expect([...reportFields].filter((f) => f !== undefined).length).toBeLessThanOrEqual(2);
    expect(server.requests.filter((r) => r.method === "GET").length).toBeLessThanOrEqual(3);
  });

  it("a transport OBJECT rebuilt on every render (no useMemo) does not restart the session", async () => {
    const { server, adminChannel } = moic();
    const fetchAdmin = server.fetchFor("user:1");
    function Inline({ tick }: { tick: number }) {
      const session = useCoworkSession({
        sessionId: "s1",
        self: { ref: "user:1" },
        // A new object every render, as the earlier recipe snippet built it.
        transport: createServerTransport({ sessionId: "s1", self: "user:1", channel: adminChannel, fetch: fetchAdmin as never }),
        config: { control: { mode: "free" } },
        authorize: () => true,
        now: () => clock,
      });
      return <span data-tick={tick}>{session.ready ? "ready" : "not"}</span>;
    }
    const view = render(<Inline tick={0} />);
    await act(async () => { await settle(); });
    const startsAfterFirst = server.requests.filter((r) => r.method === "GET").length;
    for (let i = 1; i <= 5; i++) {
      view.rerender(<Inline tick={i} />);
      await act(async () => { await settle(); });
    }
    // Every session start re-syncs once; five renders must not have started five more.
    expect(server.requests.filter((r) => r.method === "GET").length).toBe(startsAfterFirst);
  });

  it("reads sharedFields live: a list passed on a later render applies, with no restart", async () => {
    const { server, adminChannel, bobChannel } = moic();
    const bobCalls: Array<[string, unknown]> = [];
    let handle!: CoworkSessionHandle;
    function Bob({ shared }: { shared: string[] }) {
      const transport = useMemo(() => createServerTransport({ sessionId: "s1", self: "user:4", channel: bobChannel, fetch: server.fetchFor("user:4") as never }), []);
      const adapter = useMemo(() => recordingAdapter(bobCalls), []);
      handle = useCoworkSession({ sessionId: "s1", self: { ref: "user:4" }, transport, adapter, config: { control: { mode: "free" } }, authorize: () => true, sharedFields: shared, presenceRouting: "server", now: () => clock });
      return null;
    }
    const view = render(<Bob shared={[]} />);
    const admin = peer(server, "user:1", adminChannel, { config: { control: { mode: "free" } } });
    await act(async () => { await settle(); });

    await act(async () => { await admin.session.reportField("composer", "not shared yet"); await settle(); });
    expect(bobCalls).toEqual([]);

    view.rerender(<Bob shared={["composer"]} />);
    await act(async () => { await settle(); });
    await act(async () => { await admin.session.reportField("composer", "now shared"); await settle(); });
    expect(bobCalls).toContainEqual(["composer", "now shared"]);
    expect(handle.ready).toBe(true);
  });

  it("still sees typing in an editor that stops its own input events from bubbling (a React onInput stopPropagation)", async () => {
    const root = page();
    const reports: unknown[] = [];
    const session = { reportField: async (_h: string, v: unknown) => { reports.push(v); return { allow: true } as const; } };
    const host = root.querySelector<HTMLElement>('[data-co-handle="note"]')!;
    // The editor swallows its own input/change at the target, as many composers do.
    for (const type of ["input", "change"]) host.addEventListener(type, (e) => e.stopPropagation());
    const unbind = bindCoworkDom(session, { root: document, isUserEvent: () => true });
    host.textContent = "Hello from support";
    host.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "t" }));
    await vi.advanceTimersByTimeAsync(200);
    unbind();
    expect(reports.at(-1)).toBe("Hello from support");
  });

  it("sends the FINAL typed value: the trailing edge fires, and an unbind flushes rather than drops", async () => {
    const root = page();
    const reports: unknown[] = [];
    const session = { reportField: async (_h: string, v: unknown) => { reports.push(v); return { allow: true } as const; } };
    const unbind = bindCoworkDom(session, { root, isUserEvent: () => true });
    const area = root.querySelector("textarea")!;
    for (const value of ["H", "He", "Hel", "Hell", "Hello"]) {
      area.value = value;
      area.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(20);
    }
    unbind(); // a re-bind or unmount before the trailing edge
    expect(reports.at(-1)).toBe("Hello");
  });
});

describe("MOIC's page, mirrored (0.64.0 live report: no field intents in one run)", () => {
  // As MOIC builds it: useCoworkSession with the same config on both pages, effects that
  // read the session through a ref and are keyed on `ready`, bindCoworkDom keyed on
  // [ready, reportField], the composer mounted on "New Chat" (a controlled textarea, or a
  // contenteditable whose tags are inserted through a Range), and mutual follow.
  // Both pages share ONE jsdom document, so each gets its own root (the session's, for the
  // input blocker and masking, and the binding's): with `document` for both, Bob's hold
  // would swallow the admin's keys too, which no real pair of browsers can do.
  const isUser = (e: Event) => (e as Event & { user?: boolean }).user === true;
  function MoicPage(props: { server: ReturnType<typeof moicServer>; channel: PresenceChannelLike; me: string; other: string; field: "textarea" | "editable"; calls: Array<[string, unknown]>; root: HTMLElement; onHandle: (h: CoworkSessionHandle) => void }) {
    const transport = useMemo(() => createServerTransport({ sessionId: "s1", self: props.me, channel: props.channel, fetch: props.server.fetchFor(props.me) as never }), []);
    const session = useCoworkSession({
      sessionId: "s1",
      self: { ref: props.me, label: props.me },
      transport,
      adapter: recordingAdapter(props.calls),
      config: { consent: "notify", control: { mode: "ranked", scope: "session", idleMs: 3000, rank: (ref: string) => (ref === "user:4" ? 1 : 2) } },
      authorize: () => true,
      presenceRouting: "server",
      sharedFields: ["composer"],
      now: () => Date.now(),
      blockInput: { isUserEvent: isUser },
      root: props.root,
    } as never);
    props.onHandle(session);
    const live = useRef(session);
    live.current = session;
    const [chat, setChat] = useState(false);
    const [text, setText] = useState("");
    useEffect(() => (session.ready ? bindCoworkDom(session, { root: props.root, isUserEvent: isUser }) : undefined), [session.ready, session.reportField]);
    useEffect(() => { if (session.ready) void live.current.reportVisit("/dashboard"); }, [session.ready]);
    useEffect(() => { if (session.ready) void live.current.follow(props.other); }, [session.ready, props.other]);
    return (
      <div data-page={props.me}>
        <button type="button" data-new-chat="" onClick={() => setChat(true)}>New Chat</button>
        {chat && (props.field === "textarea"
          ? <textarea data-co-handle="composer" autoFocus value={text} onChange={(e) => setText(e.target.value)} />
          : <div data-co-handle="composer" contentEditable suppressContentEditableWarning autoFocus onInput={(e) => setText((e.target as HTMLElement).textContent ?? "")} />)}
      </div>
    );
  }

  for (const field of ["textarea", "editable"] as const) {
    it(`${field}: the admin's typing posts field intents, lands in Bob's focused composer, and holds Bob`, async () => {
      const { server, adminChannel, bobChannel } = moic();
      const adminCalls: Array<[string, unknown]> = [];
      const bobCalls: Array<[string, unknown]> = [];
      let admin: CoworkSessionHandle | undefined;
      let bob: CoworkSessionHandle | undefined;
      const adminRoot = document.body.appendChild(document.createElement("section"));
      const bobRoot = document.body.appendChild(document.createElement("section"));
      render(<MoicPage server={server} channel={adminChannel} me="user:1" other="user:4" field={field} calls={adminCalls} root={adminRoot} onHandle={(h) => { admin = h; }} />, { container: adminRoot });
      render(<MoicPage server={server} channel={bobChannel} me="user:4" other="user:1" field={field} calls={bobCalls} root={bobRoot} onHandle={(h) => { bob = h; }} />, { container: bobRoot });
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
      expect(admin?.ready && bob?.ready).toBe(true);

      // New Chat on both pages; Bob's composer autofocuses.
      for (const page of ["user:1", "user:4"]) {
        await act(async () => { (document.querySelector(`[data-page="${page}"] [data-new-chat]`) as HTMLButtonElement).click(); });
      }
      const adminComposer = document.querySelector('[data-page="user:1"] [data-co-handle="composer"]') as HTMLElement;
      const bobComposer = document.querySelector('[data-page="user:4"] [data-co-handle="composer"]') as HTMLElement;
      bobComposer.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;

      const typeKey = async (ch: string) => {
        await act(async () => {
          if (field === "textarea") setter.call(adminComposer, (adminComposer as HTMLTextAreaElement).value + ch);
          else adminComposer.appendChild(document.createTextNode(ch));
          adminComposer.dispatchEvent(Object.assign(new InputEvent("input", { bubbles: true }), { user: true }));
          await vi.advanceTimersByTimeAsync(40);
        });
      };
      for (const ch of "Hi ") await typeKey(ch);
      if (field === "editable") {
        // InputTag's contentEditableAdapter: a tag marker inserted through a Range, then an input event.
        await act(async () => {
          const range = document.createRange();
          range.selectNodeContents(adminComposer);
          range.collapse(false);
          const tag = document.createElement("span");
          tag.setAttribute("data-tag", "order");
          tag.textContent = "#order";
          range.insertNode(tag);
          adminComposer.dispatchEvent(Object.assign(new InputEvent("input", { bubbles: true }), { user: true }));
        });
      }
      for (const ch of " Bob") await typeKey(ch);
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });

      const finalText = field === "textarea" ? (adminComposer as HTMLTextAreaElement).value : adminComposer.textContent;
      const posted = server.requests.filter((r) => r.from === "user:1" && r.url.endsWith("/intents") && (r.body.intent as { kind: string }).kind === "field");
      expect(posted.length).toBeGreaterThan(0);
      expect((posted.at(-1)!.body.intent as { value: unknown }).value).toBe(finalText);
      expect(document.activeElement).toBe(bobComposer);
      expect(bob!.blocked).toMatchObject({ by: "user:1", mode: "ranked" });
      expect(bobCalls).toContainEqual(["composer", finalText]);
    });
  }
});

describe("MOIC on 0.65.0 / fancy-cowork 0.4.1: Bob is not the starter, cursors are anchored", () => {
  // Their report: the admin's field posts (202) and Bob's socket receives the relayed
  // `cowork.intent` frames, yet Bob's page never applies the value, is never held and
  // logs nothing. Bob's session has no `starter` (he is not the starter), and both pages
  // now move ANCHORED cursors ({ anchor, fx, fy }) through the server at 10 Hz.
  it("Bob, with no starter, commits the admin's relayed field among anchored cursors: held at once, value applied", async () => {
    const { server, adminChannel, bobChannel } = moic();
    const admin = peer(server, "user:1", adminChannel, { starter: "user:1", now: () => Date.now() });
    const bob = peer(server, "user:4", bobChannel, { starter: undefined, now: () => Date.now() });
    await settle();
    await admin.session.follow("user:4");
    await bob.session.follow("user:1");
    await vi.advanceTimersByTimeAsync(4_000);
    await settle();

    // Both move anchored cursors while the admin types.
    const text = "Hello Bob";
    for (let i = 1; i <= text.length; i++) {
      admin.session.moveCursor({ anchor: "composer", fx: 0.1 * (i % 10), fy: 0.5 });
      bob.session.moveCursor({ anchor: "composer", fx: 0.5, fy: 0.05 * i });
      void admin.session.reportField("composer", text.slice(0, i));
      await vi.advanceTimersByTimeAsync(40);
    }
    await vi.advanceTimersByTimeAsync(400);
    await settle();

    expect(server.requests.filter((r) => r.from === "user:1" && (r.body.intent as { kind?: string })?.kind === "cursor").length).toBeGreaterThan(0);
    expect(bob.refused).toEqual([]);
    expect(bob.session.getSnapshot().blocked).toMatchObject({ by: "user:1", mode: "ranked" });
    expect(bob.root.getAttribute("data-cowork-blocked")).toBe("ranked");
    expect(bob.calls).toContainEqual(["composer", text]);
    // And the admin's anchored cursor is shown on Bob's page.
    expect(bob.session.getSnapshot().peers.find((p) => p.ref === "user:1")?.cursor).toMatchObject({ anchor: "composer" });
  });
});
