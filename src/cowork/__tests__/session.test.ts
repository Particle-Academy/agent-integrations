// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCoworkSession, type CoworkSession, type CoworkSessionOptions } from "../session";
import { createMemoryTransport, type MemoryHub, type PeerTransport } from "../transport";
import { globMatch } from "../engine";
import type { NavigationBridgeAdapter } from "../../bridges/navigation";
import type { SessionConfigInput } from "../types";

type Calls = Array<[string, ...unknown[]]>;

/** A navigation adapter that records what was applied to "its" page. */
function fakeAdapter(calls: Calls, guard?: NavigationBridgeAdapter["guard"]): NavigationBridgeAdapter {
  return {
    getLocation: () => ({ url: "/", title: "" }),
    describe: () => ({ url: "/", title: "", actions: [] }),
    visit: (url) => { calls.push(["visit", url]); },
    scrollTo: (opts) => { calls.push(["scrollTo", opts]); },
    scrollBy: (dy) => { calls.push(["scrollBy", dy]); },
    setField: (handle, value) => { calls.push(["setField", handle, value]); return { ok: true }; },
    click: (handle) => { calls.push(["click", handle]); return { ok: true }; },
    submit: (handle) => { calls.push(["submit", handle]); return { ok: true }; },
    ...(guard ? { guard } : {}),
  };
}

/** Each peer gets its own page root, so DOM-side masking is per browser. */
function page(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

const FORM = `
  <input data-co-handle="name" />
  <input data-co-handle="pin" type="password" />
  <input data-co-handle="card.number" autocomplete="cc-number" />
  <section data-cowork="view-only"><input data-co-handle="terms" /></section>
  <button data-co-handle="save">Save</button>
  <form data-co-handle="checkout"></form>`;

type Peer = { session: CoworkSession; calls: Calls; transport: PeerTransport; apps: unknown[]; refused: unknown[] };

let hub: MemoryHub;
let clock = 0;
const sessions: CoworkSession[] = [];

beforeEach(() => {
  hub = createMemoryTransport();
  clock = 1_000;
  document.body.innerHTML = "";
});
afterEach(() => {
  for (const s of sessions.splice(0)) s.destroy();
  vi.useRealTimers();
});

const grants = (map: Record<string, string[]>) => (ref: string, ability: string) =>
  (map[ref] ?? []).some((glob) => globMatch(glob, ability));

function peer(ref: string, options: Partial<CoworkSessionOptions> & { config?: SessionConfigInput | null; html?: string } = {}): Peer {
  const calls: Calls = [];
  const apps: unknown[] = [];
  const refused: unknown[] = [];
  const transport = hub.connect({ ref, label: ref.toUpperCase() });
  const { html, ...rest } = options;
  const session = createCoworkSession({
    sessionId: "s1",
    self: { ref, label: ref.toUpperCase() },
    transport,
    adapter: fakeAdapter(calls),
    config: { control: { mode: "free" } },
    authorize: () => true,
    root: page(html ?? FORM),
    now: () => clock,
    onAppMessage: (message) => apps.push(message),
    onRefused: (info) => refused.push(info),
    ...rest,
  });
  sessions.push(session);
  return { session, calls, transport, apps, refused };
}

/** A raw endpoint with no session: it can put anything on the wire, as a hostile peer could. */
function rogue(ref: string) {
  return hub.connect({ ref });
}

const wireText = () => JSON.stringify(hub.wire);
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("co-work session over the memory transport", () => {
  it("shows two peers to each other through presence", async () => {
    const a = peer("a");
    const b = peer("b");
    await settle();
    expect(a.session.getSnapshot().peers.map((p) => p.ref).sort()).toEqual(["a", "b"]);
    expect(b.session.getSnapshot().peers.find((p) => p.ref === "a")).toMatchObject({ label: "A", self: false });
    expect(b.session.getSnapshot().peers.find((p) => p.ref === "b")).toMatchObject({ self: true });
  });

  it("never puts a masked, sensitive or view-only value on the wire; only that the field is active", async () => {
    const a = peer("a", { config: { control: { mode: "free" }, limits: { mask: ["secret.*"] } } });
    const b = peer("b");
    await a.session.reportField("pin", "SECRET-PIN-0000");
    await a.session.reportField("card.number", "SECRET-CARD-4242");
    await a.session.reportField("terms", "SECRET-TERMS");
    await a.session.reportField("secret.note", "SECRET-NOTE");
    await a.session.sendIntent({ kind: "field", handle: "secret.cvc", value: "SECRET-CVC" }, { view: "b" });
    await a.session.sendIntent({ kind: "field", handle: "pin", value: "SECRET-DRIVE" }, { view: "b" });
    await a.session.reportField("name", "Ada Lovelace");
    await settle();

    expect(wireText()).not.toContain("SECRET");
    const activity = hub.wire.filter((m) => m.frame.t === "activity").map((m) => m.frame);
    expect(activity).toEqual([
      { t: "activity", view: "a", handle: "pin", active: true },
      { t: "activity", view: "a", handle: "card.number", active: true },
      { t: "activity", view: "a", handle: "terms", active: true },
      { t: "activity", view: "a", handle: "secret.note", active: true },
    ]);
    expect(wireText()).toContain("Ada Lovelace");
    expect(b.session.getSnapshot().peers.find((p) => p.ref === "a")?.activeField).toBe("secret.note");
  });

  it("applies a peer's drive into its own view through the guard and the adapter", async () => {
    const a = peer("a");
    const b = peer("b");
    expect((await a.session.sendIntent({ kind: "field", handle: "name", value: "Ada" }, { view: "b" })).allow).toBe(true);
    await a.session.sendIntent({ kind: "click", handle: "save" }, { view: "b" });
    await a.session.sendIntent({ kind: "submit", handle: "checkout" }, { view: "b" });
    await settle();
    expect(b.calls).toEqual([["setField", "name", "Ada"], ["click", "save"], ["submit", "checkout"]]);
    expect(a.calls).toEqual([]);
  });

  it("refuses at the receiver what a hostile sender skipped: masked, view-only, off-origin, stale", async () => {
    const b = peer("b", { config: { control: { mode: "free" }, limits: { mask: ["secret.*"] } } });
    const m = rogue("m");
    const send = (intent: unknown, revision = 0) =>
      m.send({ t: "intent", envelope: { view: "b", revision }, intent: intent as never });
    await send({ kind: "field", handle: "secret.cvc", value: "123" });
    await send({ kind: "field", handle: "terms", value: "x" });
    await send({ kind: "click", handle: "terms" });
    await send({ kind: "field", handle: "pin", value: "0000" });
    await send({ kind: "visit", url: "https://evil.example/" });
    await settle();
    expect(b.calls).toEqual([]);

    await b.session.reportVisit("/next");
    clock += 1_000;
    await send({ kind: "field", handle: "name", value: "late" }, 0);
    await settle();
    expect(b.calls).toEqual([]);
    const reasons = b.refused.map((r) => (r as { reason: string }).reason);
    expect(reasons).toEqual([
      "cowork.denied.masked",
      "cowork.denied.view-only",
      "cowork.denied.view-only",
      "cowork.denied.masked",
      "cowork.denied.origin",
      "cowork.denied.stale",
    ]);
  });

  it("asks the page's own guard before applying, and a refused guard stops it", async () => {
    const calls: Calls = [];
    const a = peer("a");
    peer("b", { adapter: fakeAdapter(calls, (_action, handle) => ({ ok: handle !== "name" })) });
    await a.session.sendIntent({ kind: "field", handle: "name", value: "x" }, { view: "b" });
    await a.session.sendIntent({ kind: "click", handle: "save" }, { view: "b" });
    await settle();
    expect(calls).toEqual([["click", "save"]]);
  });

  it("performs a side effect only in the view owner's browser", async () => {
    const a = peer("a");
    const b = peer("b");
    const c = peer("c");
    await c.session.follow("b");
    await a.session.sendIntent({ kind: "submit", handle: "checkout" }, { view: "b" });
    await settle();
    expect(b.calls).toEqual([["submit", "checkout"]]);
    expect(c.calls).toEqual([]);
    expect(a.calls).toEqual([]);
  });

  it("refuses at the receiver a submit from someone who does not hold the baton", async () => {
    const b = peer("b", { config: { control: { mode: "baton" } } });
    const m = rogue("m");
    await m.send({ t: "intent", envelope: { view: "b", revision: 0 }, intent: { kind: "submit", handle: "checkout" } });
    await settle();
    expect(b.calls).toEqual([]);
    expect(b.refused).toMatchObject([{ reason: "cowork.denied.control", from: "m" }]);
  });

  it("baton across three peers: the grant is seen by everyone and only the holder drives", async () => {
    const cfg = { config: { control: { mode: "baton" as const } } };
    const a = peer("a", cfg);
    const b = peer("b", cfg);
    const c = peer("c", cfg);
    expect((await a.session.sendIntent({ kind: "field", handle: "name", value: "x" }, { view: "b" })).allow).toBe(false);
    await a.session.requestControl("b");
    await settle();
    expect(b.session.getSnapshot().control.b).toMatchObject({ holder: "b", requests: ["a"] });
    await b.session.grant("a");
    await settle();
    for (const p of [a, b, c]) expect(p.session.getSnapshot().control.b).toMatchObject({ mode: "baton", holder: "a" });
    expect(a.session.getSnapshot().peers.find((p) => p.ref === "a")?.drives).toBe(true);
    expect((await a.session.sendIntent({ kind: "field", handle: "name", value: "Ada" }, { view: "b" })).allow).toBe(true);
    expect((await c.session.sendIntent({ kind: "field", handle: "name", value: "Cy" }, { view: "b" })).allow).toBe(false);
    await settle();
    expect(b.calls).toEqual([["setField", "name", "Ada"]]);
    expect(b.session.getSnapshot().blocked).toMatchObject({ view: "b", by: "a" });
    await a.session.release("b");
    await settle();
    expect(c.session.getSnapshot().control.b).toMatchObject({ holder: "b" });
  });

  it("shows a cursor only to peers on the same route, throttled to 20 Hz", async () => {
    vi.useFakeTimers();
    const a = peer("a");
    const b = peer("b");
    const c = peer("c");
    await a.session.reportVisit("/doc/1");
    clock += 1_000;
    await b.session.reportVisit("/doc/1");
    clock += 1_000;
    await c.session.reportVisit("/doc/2");
    const before = hub.wire.filter((m) => m.frame.t === "cursor").length;
    a.session.moveCursor({ anchor: "name", fx: 0.5, fy: 0.25 });
    a.session.moveCursor({ x: 10, y: 20 });
    a.session.moveCursor({ x: 30, y: 40 });
    expect(hub.wire.filter((m) => m.frame.t === "cursor").length - before).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    const cursors = hub.wire.filter((m) => m.frame.t === "cursor").map((m) => m.frame);
    expect(cursors.slice(before)).toEqual([
      { t: "cursor", route: "/doc/1", anchor: "name", fx: 0.5, fy: 0.25 },
      { t: "cursor", route: "/doc/1", x: 30, y: 40 },
    ]);
    expect(b.session.getSnapshot().peers.find((p) => p.ref === "a")?.cursor).toEqual({ x: 30, y: 40 });
    expect(c.session.getSnapshot().peers.find((p) => p.ref === "a")?.cursor).toBeNull();
    expect(a.session.getSnapshot().peers.find((p) => p.ref === "c")?.cursor).toBeNull();
  });

  it("a follower tracks its leader's visits and scrolls, and reports its own new route", async () => {
    const a = peer("a");
    const b = peer("b");
    expect((await b.session.follow("a")).allow).toBe(true);
    await settle();
    expect(a.session.getSnapshot().peers.find((p) => p.ref === "b")?.follows).toBe("a");
    await a.session.reportVisit("/orders/7?tab=items");
    await settle();
    expect(b.calls[0]).toEqual(["visit", "/orders/7?tab=items"]);
    expect(a.session.getSnapshot().peers.find((p) => p.ref === "b")?.view.route).toBe("/orders/7");
    clock += 1_000;
    await a.session.reportScroll(320, "items");
    await settle();
    expect(b.calls).toContainEqual(["scrollTo", { y: 320, handle: "items" }]);
    await b.session.unfollow();
    await settle();
    clock += 1_000;
    await a.session.reportVisit("/elsewhere");
    await settle();
    expect(b.calls.filter((c) => c[0] === "visit")).toHaveLength(1);
  });

  it("delivers an app message unchanged and drops an oversize or over-rate one", async () => {
    const a = peer("a");
    const b = peer("b");
    const payload = { cart: [{ sku: "A-1", qty: 2 }], note: "ünïcödé", nested: { deep: [1, null, true] } };
    expect((await a.session.sendIntent({ kind: "app", topic: "cart.updated", payload })).allow).toBe(true);
    await settle();
    expect(b.apps).toEqual([{ from: "a", topic: "cart.updated", payload }]);

    const m = rogue("m");
    await m.send({ t: "intent", envelope: {}, intent: { kind: "app", topic: "big", payload: "x".repeat(16383) } });
    await settle();
    expect(b.apps).toHaveLength(1);
    expect(b.refused.at(-1)).toMatchObject({ reason: "cowork.denied.size", from: "m" });

    for (let i = 0; i < 31; i++) {
      clock += 200;
      await m.send({ t: "intent", envelope: {}, intent: { kind: "app", topic: "tick", payload: i } });
      await settle();
    }
    expect(b.apps.filter((x) => (x as { topic: string }).topic === "tick")).toHaveLength(30);
    expect(b.refused.at(-1)).toMatchObject({ reason: "cowork.denied.rate", from: "m" });
  });

  it("delivers an addressed app message only to its addressees", async () => {
    const a = peer("a");
    const b = peer("b");
    const c = peer("c");
    await a.session.sendIntent({ kind: "app", topic: "note", payload: 1 }, { to: ["b"] });
    await settle();
    expect(b.apps).toHaveLength(1);
    expect(c.apps).toHaveLength(0);
  });

  it("denies everything until the host configures it: no authorize, no config", async () => {
    const a = peer("a", { authorize: null });
    const b = peer("b", { config: null });
    const before = hub.wire.length;
    expect(await a.session.reportField("name", "x")).toEqual({ allow: false, reason: "cowork.unconfigured.authorize", status: 403 });
    expect(await b.session.reportVisit("/x")).toEqual({ allow: false, reason: "cowork.unconfigured.config", status: 403 });
    expect(hub.wire.slice(before).filter((m) => m.frame.t === "intent")).toEqual([]);
  });

  it("ranked control: the local user is blocked while a higher rank acted, until exactly idleMs", async () => {
    const config = { control: { mode: "ranked" as const, rank: { admin: 10, user: 1 }, idleMs: 3000 } };
    const user = peer("user", { config });
    const admin = peer("admin", { config });
    await admin.session.sendIntent({ kind: "field", handle: "name", value: "a@example.com" }, { view: "user" });
    await settle();
    expect(user.calls).toEqual([["setField", "name", "a@example.com"]]);
    expect(user.session.getSnapshot().blocked).toEqual({ view: "user", by: "admin", label: "ADMIN", until: 4000, mode: "ranked" });
    expect(user.session.getSnapshot().control.user).toMatchObject({ mode: "ranked", blockedUntil: 4000 });
    clock = 3_999;
    expect((await user.session.reportField("name", "mine")).allow).toBe(false);
    clock = 4_000;
    user.session.refresh();
    expect(user.session.getSnapshot().blocked).toBeNull();
    expect((await user.session.reportField("name", "mine")).allow).toBe(true);
  });

  it("drops a peer on leave and returns the baton it held", async () => {
    const cfg = { config: { control: { mode: "baton" as const } } };
    const a = peer("a", cfg);
    const b = peer("b", cfg);
    await b.session.grant("a");
    expect(b.session.getSnapshot().control.b?.holder).toBe("a");
    a.session.leave();
    await settle();
    expect(b.session.getSnapshot().peers.map((p) => p.ref)).toEqual(["b"]);
    expect(b.session.getSnapshot().control.b?.holder).toBe("b");
  });

  it("tells a newcomer where everyone already is", async () => {
    const a = peer("a");
    await a.session.reportVisit("/doc/9");
    const b = peer("b");
    await settle();
    expect(b.session.getSnapshot().peers.find((p) => p.ref === "a")?.view).toEqual({ route: "/doc/9", revision: 1 });
  });

  it("never lets a hello roll a view's revision back, so a stale intent stays stale", async () => {
    const b = peer("b");
    const m = rogue("m");
    await settle();
    await m.send({ t: "intent", envelope: { view: "m", revision: 0 }, intent: { kind: "visit", url: "/m/next" } });
    await settle();
    expect(b.session.getSnapshot().peers.find((p) => p.ref === "m")?.view).toEqual({ route: "/m/next", revision: 1 });
    await m.send({ t: "hello", route: "/m/old", revision: 0, follows: null });
    await settle();
    expect(b.session.getSnapshot().peers.find((p) => p.ref === "m")?.view).toEqual({ route: "/m/next", revision: 1 });
  });

  it("notifies subscribers on change, and the snapshot is stable between changes", async () => {
    const a = peer("a");
    const seen = vi.fn();
    a.session.subscribe(seen);
    const first = a.session.getSnapshot();
    expect(a.session.getSnapshot()).toBe(first);
    peer("b");
    await settle();
    expect(seen).toHaveBeenCalled();
    expect(a.session.getSnapshot()).not.toBe(first);
  });
});
