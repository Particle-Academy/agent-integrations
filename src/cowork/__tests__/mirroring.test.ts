// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bindCoworkDom } from "../dom-binding";
import { createCoworkSession, type CoworkSession, type CoworkSessionOptions } from "../session";
import { createMemoryTransport, type MemoryHub } from "../transport";
import { attributeHandle, setEditableText, setNativeValue } from "../../dom-navigation/agent";
import type { NavigationBridgeAdapter } from "../../bridges/navigation";
import type { SessionConfigInput } from "../types";

/*
 * Symmetric mirroring (MOIC): two people on the same account, each following
 * the other, each seeing the other's navigation and typing; while the admin is
 * active the user is held, ranked across the whole session.
 *
 * jsdom marks every event untrusted, so these tests mark "the person did this"
 * through `isUserEvent`, and the adapter's writes stay unmarked, exactly as a
 * browser's script-dispatched events are untrusted.
 */
const USER = "__coworkPerson";
const byPerson = <E extends Event>(event: E): E => Object.assign(event, { [USER]: true });
const isUserEvent = (event: Event) => (event as Event & { [USER]?: boolean })[USER] === true;

let hub: MemoryHub;
let clock = 1_000;
const sessions: CoworkSession[] = [];
const unbinds: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  hub = createMemoryTransport();
  clock = 1_000;
  document.body.innerHTML = "";
});
afterEach(() => {
  for (const off of unbinds.splice(0)) off();
  for (const s of sessions.splice(0)) s.destroy();
  vi.useRealTimers();
});
const settle = async (times = 6) => {
  for (let i = 0; i < times; i++) await vi.advanceTimersByTimeAsync(0);
};

const HTML = `
  <input data-co-handle="name" />
  <textarea data-co-handle="bio"></textarea>
  <input data-co-handle="agree" type="checkbox" />
  <select data-co-handle="size"><option value="s">S</option><option value="m">M</option></select>
  <div contenteditable="true" data-co-handle="composer"></div>
  <input data-co-handle="pin" type="password" />`;

type Peer = {
  session: CoworkSession;
  root: HTMLElement;
  el: (handle: string) => HTMLElement;
  applied: Array<[string, ...unknown[]]>;
  refused: unknown[];
};

/**
 * A peer whose adapter writes into its OWN page and, like a real host, re-reports
 * every navigation and scroll its page makes, including the ones the session applied.
 */
function peer(ref: string, extra: Partial<CoworkSessionOptions> & { config?: SessionConfigInput; hostReports?: boolean } = {}): Peer {
  const root = document.createElement("div");
  root.innerHTML = HTML;
  document.body.appendChild(root);
  const el = (handle: string) => Array.from(root.querySelectorAll<HTMLElement>("[data-co-handle]")).find((e) => attributeHandle(e) === handle)!;
  const applied: Peer["applied"] = [];
  const refused: unknown[] = [];
  const { hostReports = true, ...rest } = extra;
  let session!: CoworkSession;
  const adapter: NavigationBridgeAdapter = {
    getLocation: () => ({ url: "/", title: "" }),
    describe: () => ({ url: "/", title: "", actions: [] }),
    visit: (url) => {
      applied.push(["visit", url]);
      if (hostReports) void session.reportVisit(url);
    },
    scrollTo: (opts) => {
      applied.push(["scrollTo", opts.y]);
      if (hostReports && typeof opts.y === "number") void session.reportScroll(opts.y);
    },
    scrollBy: () => {},
    setField: (handle, value) => {
      applied.push(["setField", handle, value]);
      const target = el(handle);
      if (target.getAttribute("contenteditable") !== null) setEditableText(target, value);
      else setNativeValue(target as HTMLInputElement, value);
      return { ok: true };
    },
    click: () => ({ ok: true }),
    submit: () => ({ ok: true }),
  };
  session = createCoworkSession({
    sessionId: "s",
    self: { ref, label: ref.toUpperCase() },
    transport: hub.connect({ ref, label: ref.toUpperCase() }),
    adapter,
    config: { control: { mode: "free" } },
    authorize: () => true,
    root,
    now: () => clock,
    blockInput: { isUserEvent },
    onRefused: (r) => refused.push(r),
    ...rest,
  });
  sessions.push(session);
  return { session, root, el, applied, refused };
}

const intents = (kind: string, from?: string) =>
  hub.wire.filter((m) => {
    const frame = m.frame as { t?: string; intent?: { kind?: string } };
    return frame.t === "intent" && frame.intent?.kind === kind && (from === undefined || m.from === from);
  });
const routeOf = (s: CoworkSession, ref: string) => s.getSnapshot().peers.find((p) => p.ref === ref)?.view.route;

describe("ranked control across the whole session", () => {
  const ranked = { control: { mode: "ranked" as const, scope: "session" as const, rank: { admin: 2, user: 1 }, idleMs: 3000 } };

  it("the admin typing in its OWN view holds the user's input until exactly idleMs", async () => {
    const user = peer("user", { config: ranked });
    const admin = peer("admin", { config: ranked });
    await settle();
    await admin.session.reportField("name", "a@example.com");
    await settle();

    expect(user.session.getSnapshot().blocked).toEqual({ view: "user", by: "admin", label: "ADMIN", until: 4000, mode: "ranked" });
    expect(user.root.getAttribute("data-cowork-blocked")).toBe("ranked");
    const key = () => byPerson(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
    expect(user.el("name").dispatchEvent(key())).toBe(false);
    expect(admin.session.getSnapshot().blocked).toBeNull();

    clock = 4_000;
    expect(user.el("name").dispatchEvent(key())).toBe(true);
  });

  it("per-view scope (the default) does not hold the user for the admin's own view", async () => {
    const perView = { control: { mode: "ranked" as const, rank: { admin: 2, user: 1 }, idleMs: 3000 } };
    const user = peer("user", { config: perView });
    const admin = peer("admin", { config: perView });
    await settle();
    await admin.session.reportField("name", "x");
    await settle();
    expect(user.session.getSnapshot().blocked).toBeNull();
  });
});

describe("shared fields while the person is held", () => {
  it("applies a peer's value to a FOCUSED field when the local person is blocked and cannot type", async () => {
    const config = { control: { mode: "ranked" as const, scope: "session" as const, rank: { admin: 2, user: 1 }, idleMs: 3000 } };
    const user = peer("user", { config, sharedFields: ["composer"] });
    const admin = peer("admin", { config, sharedFields: ["composer"] });
    await settle();
    user.el("composer").focus();
    await admin.session.reportField("composer", "hello from admin");
    await settle();
    expect(user.applied).toContainEqual(["setField", "composer", "hello from admin"]);
    expect(user.el("composer").textContent).toBe("hello from admin");
  });

  it("still waits for blur when the person is free to type", async () => {
    const user = peer("user", { sharedFields: ["composer"] });
    const admin = peer("admin", { sharedFields: ["composer"] });
    await settle();
    user.el("composer").focus();
    await admin.session.reportField("composer", "later");
    await settle();
    expect(user.applied).toEqual([]);
  });
});

describe("mutual follow does not ping-pong", () => {
  it("each follows the other; a visit and a scroll travel once each way and stop", async () => {
    const a = peer("a");
    const b = peer("b");
    await settle();
    await a.session.follow("b");
    await b.session.follow("a");
    await settle();
    const visitsBefore = intents("visit").length;
    const scrollsBefore = intents("scroll").length;

    await a.session.reportVisit("/orders/7");
    await settle(12);
    clock += 200;
    await a.session.reportScroll(240);
    await settle(12);

    // a's own visit, and b's one re-report of where it now is; b's host listener echo is suppressed.
    expect(intents("visit").length - visitsBefore).toBe(2);
    expect(intents("visit", "b").length).toBe(1);
    // a's scroll only: b applied it, and b's host listener's echo did not go out.
    expect(intents("scroll").length - scrollsBefore).toBe(1);
    expect(b.applied).toEqual([["visit", "/orders/7"], ["scrollTo", 240]]);
    expect(a.applied).toEqual([]);
    expect(routeOf(a.session, "a")).toBe("/orders/7");
    expect(routeOf(a.session, "b")).toBe("/orders/7");
    // No echo was even attempted: a duplicate would be refused by the visit rate and reported.
    expect(a.refused).toEqual([]);
    expect(b.refused).toEqual([]);
  });

  it("a genuinely new local navigation after the echo window still goes out", async () => {
    const a = peer("a");
    const b = peer("b");
    await settle();
    await a.session.follow("b");
    await b.session.follow("a");
    await a.session.reportVisit("/orders/7");
    await settle(12);
    clock += 1_001;
    await b.session.reportVisit("/orders/8");
    await settle(12);
    expect(intents("visit", "b").map((m) => (m.frame as { intent: { url: string } }).intent.url)).toEqual(["/orders/7", "/orders/8"]);
    // Once the window has passed, reporting the route a is ALREADY on is still not a
    // navigation: it is not sent (and bumps no revision). MOIC 0.64.0: an effect keyed on
    // the snapshot re-reported its URL on every change, and each report was a revision.
    clock += 1_001;
    await a.session.reportVisit("/orders/8");
    await a.session.reportVisit("/orders/8?tab=2");
    await settle(12);
    // a: its own visit and its re-report after following b; nothing for the same route.
    expect(intents("visit", "a").map((m) => (m.frame as { intent: { url: string } }).intent.url)).toEqual(["/orders/7", "/orders/8"]);
    // A different route still goes out.
    await a.session.reportVisit("/orders/9");
    await settle(12);
    expect(intents("visit", "a").map((m) => (m.frame as { intent: { url: string } }).intent.url)).toEqual(["/orders/7", "/orders/8", "/orders/9"]);
    expect(a.applied).toContainEqual(["visit", "/orders/8"]);
  });

  it("the echo window is the host's to set", async () => {
    const a = peer("a", { followEchoMs: 0 });
    const b = peer("b", { followEchoMs: 0 });
    await settle();
    await a.session.follow("b");
    await b.session.follow("a");
    await a.session.reportScroll(10);
    await settle(12);
    // With no window, b's host echo goes out (and a, following b, applies it).
    expect(intents("scroll", "b").length).toBeGreaterThan(0);
  });
});

describe("bindCoworkDom", () => {
  const field = (p: Peer, kind: "input" | "change", handle: string, set: (el: HTMLElement) => void, person = true) => {
    const target = p.el(handle);
    set(target);
    const event = new Event(kind, { bubbles: true });
    target.dispatchEvent(person ? byPerson(event) : event);
  };
  const sentFields = (from: string) =>
    intents("field", from).map((m) => {
      const intent = (m.frame as { intent: { handle: string; value: unknown } }).intent;
      return [intent.handle, intent.value];
    });

  it("reports what the person types in inputs, textareas, checkboxes, selects and contenteditables", async () => {
    const a = peer("a");
    peer("b");
    unbinds.push(bindCoworkDom(a.session, { root: a.root, isUserEvent }));
    await settle();

    field(a, "input", "name", (e) => { (e as HTMLInputElement).value = "Ada"; });
    field(a, "input", "bio", (e) => { (e as HTMLTextAreaElement).value = "hi"; });
    field(a, "change", "agree", (e) => { (e as HTMLInputElement).checked = true; });
    field(a, "change", "size", (e) => { (e as HTMLSelectElement).value = "m"; });
    field(a, "input", "composer", (e) => { e.textContent = "typing…"; });
    await vi.advanceTimersByTimeAsync(200);
    await settle();

    expect(sentFields("a")).toEqual([["name", "Ada"], ["bio", "hi"], ["agree", true], ["size", "m"], ["composer", "typing…"]]);
  });

  it("throttles per handle and always sends the final value", async () => {
    const a = peer("a");
    peer("b");
    unbinds.push(bindCoworkDom(a.session, { root: a.root, isUserEvent, throttleMs: 150 }));
    await settle();
    for (const text of ["h", "he", "hel", "hell", "hello"]) {
      field(a, "input", "composer", (e) => { e.textContent = text; });
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    const sent = sentFields("a").filter(([h]) => h === "composer").map(([, v]) => v);
    expect(sent.length).toBeLessThanOrEqual(3);
    expect(sent.at(-1)).toBe("hello");
  });

  it("ignores events the page dispatched itself, so a peer's applied write is never echoed", async () => {
    const a = peer("a", { sharedFields: ["composer"] });
    const b = peer("b", { sharedFields: ["composer"] });
    unbinds.push(bindCoworkDom(a.session, { root: a.root, isUserEvent }));
    unbinds.push(bindCoworkDom(b.session, { root: b.root, isUserEvent }));
    await settle();
    field(a, "input", "composer", (e) => { e.textContent = "from a"; });
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(b.el("composer").textContent).toBe("from a");
    expect(sentFields("b")).toEqual([]);
    // An untrusted event on a's own page is ignored too.
    field(a, "input", "name", (e) => { (e as HTMLInputElement).value = "scripted"; }, false);
    await vi.advanceTimersByTimeAsync(200);
    expect(sentFields("a").map(([h]) => h)).toEqual(["composer"]);
  });

  it("a masked field's value never reaches the wire", async () => {
    const a = peer("a");
    peer("b");
    unbinds.push(bindCoworkDom(a.session, { root: a.root, isUserEvent }));
    await settle();
    field(a, "input", "pin", (e) => { (e as HTMLInputElement).value = "4242"; });
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(JSON.stringify(hub.wire)).not.toContain("4242");
  });

  it("unbinding stops reporting", async () => {
    const a = peer("a");
    peer("b");
    const off = bindCoworkDom(a.session, { root: a.root, isUserEvent });
    off();
    field(a, "input", "name", (e) => { (e as HTMLInputElement).value = "late"; });
    await vi.advanceTimersByTimeAsync(200);
    expect(sentFields("a")).toEqual([]);
  });
});
