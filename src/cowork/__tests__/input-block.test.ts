// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInputBlocker, BLOCKED_EVENTS } from "../input-block";
import { createCoworkSession, type CoworkSession } from "../session";
import { createMemoryTransport, type MemoryHub } from "../transport";
import type { NavigationBridgeAdapter } from "../../bridges/navigation";

/*
 * Ranked control has to stop the lower-ranked person for real (MOIC's core
 * requirement), not only show a banner. jsdom marks every dispatched event
 * untrusted, so these tests mark "the person did this" themselves through
 * `isUserEvent`; the fancy-labs co-work benchmark checks the real-browser path
 * with trusted input.
 */
const USER = "__coworkTestUser";
const asUser = <E extends Event>(event: E): E => Object.assign(event, { [USER]: true });
const isUserEvent = (event: Event) => (event as Event & { [USER]?: boolean })[USER] === true;

function fire(target: EventTarget, event: Event): { defaultPrevented: boolean; reached: boolean } {
  let reached = false;
  const spy = () => { reached = true; };
  target.addEventListener(event.type, spy);
  target.dispatchEvent(event);
  target.removeEventListener(event.type, spy);
  return { defaultPrevented: event.defaultPrevented, reached };
}

const keydown = () => asUser(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
const pointerdown = () => asUser(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
const pointermove = () => asUser(new MouseEvent("pointermove", { bubbles: true, cancelable: true }));

describe("createInputBlocker", () => {
  let root: HTMLElement;
  let input: HTMLInputElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"><input id="field" /></div>';
    root = document.getElementById("root")!;
    input = document.getElementById("field") as HTMLInputElement;
  });

  it("swallows the person's keyboard, press, wheel, paste and drop input while blocked", () => {
    const blocker = createInputBlocker({ target: root, isBlocked: () => true, isUserEvent });
    for (const type of BLOCKED_EVENTS) {
      const result = fire(input, asUser(new Event(type, { bubbles: true, cancelable: true })));
      expect({ type, ...result }).toEqual({ type, defaultPrevented: true, reached: false });
    }
    blocker.destroy();
  });

  it("leaves pointer movement free while blocked, so the person's cursor still moves", () => {
    const blocker = createInputBlocker({ target: root, isBlocked: () => true, isUserEvent });
    for (const type of ["pointermove", "mousemove", "pointerover", "pointerout", "mouseenter", "mouseleave"]) {
      const result = fire(input, asUser(new MouseEvent(type, { bubbles: true, cancelable: true })));
      expect({ type, ...result }).toEqual({ type, defaultPrevented: false, reached: true });
    }
    blocker.destroy();
  });

  it("lets everything through while not blocked", () => {
    const blocker = createInputBlocker({ target: root, isBlocked: () => false, isUserEvent });
    expect(fire(input, keydown())).toEqual({ defaultPrevented: false, reached: true });
    expect(fire(input, pointerdown())).toEqual({ defaultPrevented: false, reached: true });
    blocker.destroy();
  });

  it("never blocks events the page dispatches itself, which is how the controlling peer's intents land", () => {
    const blocker = createInputBlocker({ target: root, isBlocked: () => true, isUserEvent });
    const synthetic = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    expect(fire(input, synthetic)).toEqual({ defaultPrevented: false, reached: true });
    blocker.destroy();
  });

  it("defaults to the browser's own trust flag", () => {
    const blocker = createInputBlocker({ target: root, isBlocked: () => true });
    // A script-dispatched event is untrusted, so the default lets it through.
    expect(fire(input, new KeyboardEvent("keydown", { bubbles: true, cancelable: true }))).toEqual({ defaultPrevented: false, reached: true });
    blocker.destroy();
  });

  it("reads isBlocked on every event, and stops entirely on destroy", () => {
    let blocked = true;
    const onBlocked = vi.fn();
    const blocker = createInputBlocker({ target: root, isBlocked: () => blocked, isUserEvent, onBlocked });
    expect(fire(input, keydown()).reached).toBe(false);
    expect(onBlocked).toHaveBeenCalledOnce();
    blocked = false;
    expect(fire(input, keydown()).reached).toBe(true);
    blocked = true;
    blocker.destroy();
    expect(fire(input, keydown()).reached).toBe(true);
  });

  it("exempts the session's own controls, so a blocked owner can still revoke or release", () => {
    root.innerHTML = '<div data-cowork-control><button id="revoke">Revoke</button></div><button id="page">Page</button>';
    const blocker = createInputBlocker({ target: root, isBlocked: () => true, isUserEvent });
    const click = () => asUser(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(fire(document.getElementById("revoke")!, click()).reached).toBe(true);
    expect(fire(document.getElementById("page")!, click()).reached).toBe(false);
    blocker.destroy();
  });

  it("an isBlocked that throws fails closed", () => {
    const blocker = createInputBlocker({ target: root, isBlocked: () => { throw new Error("boom"); }, isUserEvent });
    expect(fire(input, keydown()).reached).toBe(false);
    blocker.destroy();
  });
});

describe("a cowork session blocks the lower-ranked person for real", () => {
  let hub: MemoryHub;
  let clock: number;
  const sessions: CoworkSession[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    hub = createMemoryTransport();
    clock = 1_000;
    document.body.innerHTML = "";
  });
  afterEach(() => {
    for (const s of sessions.splice(0)) s.destroy();
    vi.useRealTimers();
  });

  const config = { control: { mode: "ranked" as const, rank: { admin: 10, user: 1 }, idleMs: 3000 } };
  const settle = () => vi.advanceTimersByTimeAsync(0);

  function peer(ref: string, extra: Record<string, unknown> = {}) {
    const root = document.createElement("div");
    root.innerHTML = '<input data-co-handle="email" />';
    document.body.appendChild(root);
    const calls: unknown[] = [];
    const adapter: NavigationBridgeAdapter = {
      getLocation: () => ({ url: "/", title: "" }),
      describe: () => ({ url: "/", title: "", actions: [] }),
      visit: () => {},
      scrollTo: () => {},
      scrollBy: () => {},
      setField: (handle, value) => { calls.push(["setField", handle, value]); return { ok: true }; },
      click: () => ({ ok: true }),
      submit: () => ({ ok: true }),
    };
    const session = createCoworkSession({
      sessionId: "s",
      self: { ref, label: ref.toUpperCase() },
      transport: hub.connect({ ref, label: ref.toUpperCase() }),
      adapter,
      config,
      authorize: () => true,
      root,
      now: () => clock,
      blockInput: { isUserEvent },
      ...extra,
    });
    sessions.push(session);
    return { session, root, input: root.querySelector("input")!, calls };
  }

  it("blocks keyboard and presses while the admin is active, keeps the cursor free, and hands back at exactly idleMs", async () => {
    const user = peer("user");
    const admin = peer("admin");
    await admin.session.sendIntent({ kind: "field", handle: "email", value: "a@example.com" }, { view: "user" });
    await settle();
    // The admin's write still lands in the user's page while the user is blocked.
    expect(user.calls).toEqual([["setField", "email", "a@example.com"]]);
    expect(user.root.getAttribute("data-cowork-blocked")).toBe("ranked");

    expect(fire(user.input, keydown()).reached).toBe(false);
    expect(fire(user.input, pointerdown()).reached).toBe(false);
    expect(fire(user.input, pointermove()).reached).toBe(true);

    clock = 3_999; // admin acted at 1000; idleMs 3000
    expect(fire(user.input, keydown()).reached).toBe(false);
    clock = 4_000;
    expect(fire(user.input, keydown()).reached).toBe(true);
    expect(fire(user.input, pointerdown()).reached).toBe(true);
  });

  it("refreshes itself at the hand-back, so the banner state and the attribute clear without a poll", async () => {
    const user = peer("user");
    const admin = peer("admin");
    const seen: Array<unknown> = [];
    user.session.subscribe(() => seen.push(user.session.getSnapshot().blocked));
    await admin.session.sendIntent({ kind: "field", handle: "email", value: "x" }, { view: "user" });
    await settle();
    expect(user.session.getSnapshot().blocked).toMatchObject({ by: "admin", until: 4000 });
    clock = 4_000;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(user.session.getSnapshot().blocked).toBeNull();
    expect(user.root.hasAttribute("data-cowork-blocked")).toBe(false);
    expect(seen.at(-1)).toBeNull();
  });

  it("re-blocks when the admin acts again, measured from the newest action", async () => {
    const user = peer("user");
    const admin = peer("admin");
    await admin.session.sendIntent({ kind: "field", handle: "email", value: "1" }, { view: "user" });
    await settle();
    clock = 4_000;
    expect(fire(user.input, keydown()).reached).toBe(true);
    clock = 5_000;
    await admin.session.sendIntent({ kind: "field", handle: "email", value: "2" }, { view: "user" });
    await settle();
    clock = 7_999;
    expect(fire(user.input, keydown()).reached).toBe(false);
    clock = 8_000;
    expect(fire(user.input, keydown()).reached).toBe(true);
  });

  it("never blocks the higher-ranked peer", async () => {
    const user = peer("user");
    const admin = peer("admin");
    await admin.session.sendIntent({ kind: "field", handle: "email", value: "1" }, { view: "user" });
    await settle();
    await user.session.reportField("email", "ignored"); // refused at the sender while blocked
    await settle();
    expect(fire(admin.input, keydown()).reached).toBe(true);
    expect(admin.root.hasAttribute("data-cowork-blocked")).toBe(false);
  });

  it("can be turned off by the host, which then gets only the banner state", async () => {
    const user = peer("user", { blockInput: false });
    const admin = peer("admin");
    await admin.session.sendIntent({ kind: "field", handle: "email", value: "1" }, { view: "user" });
    await settle();
    expect(user.session.getSnapshot().blocked).not.toBeNull();
    expect(fire(user.input, asUser(new KeyboardEvent("keydown", { bubbles: true, cancelable: true }))).reached).toBe(true);
  });

  it("removes its listeners and the attribute on destroy", async () => {
    const user = peer("user");
    const admin = peer("admin");
    await admin.session.sendIntent({ kind: "field", handle: "email", value: "1" }, { view: "user" });
    await settle();
    const removed = vi.spyOn(user.root, "removeEventListener");
    user.session.destroy();
    // A leftover listener would be inert, but it is still a leak on every session: remove each one.
    const removedTypes = new Set(removed.mock.calls.map(([type]) => type));
    for (const type of BLOCKED_EVENTS) expect(removedTypes.has(type)).toBe(true);
    expect(user.root.hasAttribute("data-cowork-blocked")).toBe(false);
    expect(fire(user.input, keydown()).reached).toBe(true);
  });
});
