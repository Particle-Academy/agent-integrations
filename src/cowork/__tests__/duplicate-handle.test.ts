// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDomNavigationAgent } from "../../dom-navigation/agent";
import { createCoworkSession, type CoworkSession } from "../session";
import { createServerTransport, type PresenceChannelLike } from "../transport";

/*
 * A consumer's 0.65.3 trace: the admin's field was committed and held the subject, the
 * apply decision said shared and same route, and then nothing: the visible
 * contentEditable composer stayed "" with no warning. Their page also renders a TEXTAREA
 * variant of the composer, hidden, with the same data-co-handle="composer", earlier in
 * the document. Both the agent and the session took the FIRST match, so the text went into
 * the hidden textarea, the "did not change" check read that textarea, and nothing was said.
 * Now the rendered element wins when several carry a handle, the duplicate is warned once,
 * and `debug` traces the apply result and the send side.
 */

const rendered = (el: Element) => {
  (el as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [{ width: 100, height: 20 }];
};

function setupDom() {
  document.body.innerHTML = '<textarea data-co-handle="composer" style="display:none"></textarea><div contenteditable="true" data-co-handle="composer"></div>';
  const textarea = document.querySelector("textarea")!;
  const editable = document.querySelector("div[contenteditable]") as HTMLElement;
  rendered(editable); // jsdom has no layout: the visible one is marked by hand
  return { textarea, editable };
}

let sessions: CoworkSession[] = [];
beforeEach(() => { document.body.innerHTML = ""; });
afterEach(() => { for (const s of sessions) s.destroy(); sessions = []; vi.restoreAllMocks(); });

describe("createDomNavigationAgent with two elements on one handle", () => {
  it("writes the RENDERED one, not the first in the document", () => {
    const { textarea, editable } = setupDom();
    const agent = createDomNavigationAgent();
    expect(agent.setField("composer", "Hello from support")).toMatchObject({ ok: true });
    expect(editable.textContent).toBe("Hello from support");
    expect(textarea.value).toBe("");
  });

  it("with one element it behaves as before (no layout needed)", () => {
    document.body.innerHTML = '<textarea data-co-handle="composer"></textarea>';
    const agent = createDomNavigationAgent();
    expect(agent.setField("composer", "x")).toMatchObject({ ok: true });
    expect(document.querySelector("textarea")!.value).toBe("x");
  });
});

function channelDouble() {
  const listeners = new Set<(p: unknown) => void>();
  const channel: PresenceChannelLike = {
    here() { return channel; }, joining() { return channel; }, leaving() { return channel; },
    whisper() { return channel; }, listenForWhisper() { return channel; },
    listen(_e, cb) { listeners.add(cb); return channel; }, stopListening() { return channel; },
  };
  return { channel, relay: (p: unknown) => { for (const cb of listeners) cb(p); } };
}
const sync = (async (_u: string, init?: { method?: string }) => ((init?.method ?? "GET") === "GET"
  ? { ok: true, status: 200, json: async () => ({ session: { control: { mode: "ranked", scope: "session", idleMs: 3000, views: {} }, participants: [
      { ref: "user:1", route: "/dashboard", revision: 0, follows: null, rank: 2 },
      { ref: "user:4", route: "/dashboard", revision: 0, follows: null, rank: 1 },
    ] } }) }
  : { ok: true, status: 202, json: async () => ({}) })) as never;

function subject(debug = false) {
  const { channel, relay } = channelDouble();
  const s = createCoworkSession({
    sessionId: "s1", self: { ref: "user:4" }, debug,
    transport: createServerTransport({ sessionId: "s1", self: "user:4", channel, fetch: sync }),
    config: { consent: "notify", control: { mode: "ranked", scope: "session", rank: (r: string) => (r === "user:4" ? 1 : 2), idleMs: 3000 } },
    authorize: () => true, presenceRouting: "server", sharedFields: ["composer"],
    adapter: { ...createDomNavigationAgent(), visit: () => {} },
  } as never);
  sessions.push(s);
  return { s, relay };
}
const field = { id: "f", session: "s1", from: "user:1", view: "user:1", revision: 0, intent: { kind: "field", handle: "composer", value: "Hello from support" } };
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("the session with two elements on one handle", () => {
  it("applies to the rendered composer and warns once that the handle is not unique", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { editable, textarea } = setupDom();
    const { relay } = subject();
    await wait();
    relay(field);
    relay({ ...field, id: "g", intent: { ...field.intent, value: "Hello again" } });
    await wait(400);
    expect(editable.textContent).toBe("Hello again");
    expect(textarea.value).toBe("");
    const dup = warn.mock.calls.filter((c) => String(c[0]).includes("carry"));
    expect(dup).toHaveLength(1);
    expect(String(dup[0]![0])).toContain("composer");
  });
});

describe("debug traces the apply result and the send side", () => {
  it("logs the element applied to, and reportField's post and result", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    setupDom();
    const { s, relay } = subject(true);
    await wait();
    relay(field);
    await wait(50);
    // Still held by the admin's write: refused at the sender, traced with its reason.
    await s.reportField("composer", "Hello from support - thanks");
    await wait(20);
    // Once the hold has passed, the same report is posted, with its result.
    await wait(3_100);
    await s.reportField("composer", "Hello from support - thanks!");
    await wait(20);
    const lines = log.mock.calls.map((c) => String(c[0]));
    for (const l of lines) expect(typeof l).toBe("string");
    expect(lines.some((l) => l.includes("applied") && l.includes("DIV[contenteditable]"))).toBe(true);
    expect(lines.some((l) => l.includes("refused at the sender") && l.includes("cowork.denied.control"))).toBe(true);
    for (const step of ["send", "posted", "result"]) expect(lines.some((l) => l.includes(step)), step).toBe(true);
  }, 10_000);
});

describe("a page that reverts the written field", () => {
  it("is caught: the field changing back after our write is warned once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    document.body.innerHTML = '<div contenteditable="true" data-co-handle="composer"></div>';
    const { relay } = subject();
    await wait();
    relay(field);
    await wait(20);
    const composer = document.querySelector("[data-co-handle]") as HTMLElement;
    expect(composer.textContent).toBe("Hello from support");
    // The page re-renders the composer from its own state, which never saw the write.
    composer.textContent = "";
    await wait(20);
    const w = warn.mock.calls.filter((c) => String(c[0]).includes("changed the field back"));
    expect(w).toHaveLength(1);
  });
});

describe("our own write on a HELD receiver with bindCoworkDom on (the coordinator's theory)", () => {
  it("is not blocked, reverted or reported back as the held person's edit", async () => {
    const { bindCoworkDom } = await import("../dom-binding");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    document.body.innerHTML = '<div contenteditable="true" data-co-handle="composer"></div>';
    const posts: Array<{ kind: string; value?: unknown }> = [];
    const { channel, relay } = channelDouble();
    const fetchFn = (async (url: string, init?: { method?: string; body?: string }) => {
      if ((init?.method ?? "GET") !== "GET" && String(url).endsWith("/intents")) posts.push(JSON.parse(String(init?.body)).intent);
      return (sync as unknown as (u: string, i?: unknown) => Promise<unknown>)(url, init);
    }) as never;
    const s = createCoworkSession({
      sessionId: "s1", self: { ref: "user:4" },
      transport: createServerTransport({ sessionId: "s1", self: "user:4", channel, fetch: fetchFn }),
      config: { consent: "notify", control: { mode: "ranked", scope: "session", rank: (r: string) => (r === "user:4" ? 1 : 2), idleMs: 3000 } },
      authorize: () => true, presenceRouting: "server", sharedFields: ["composer"],
      adapter: { ...createDomNavigationAgent(), visit: () => {} },
      // The default input blocker (on) and bindCoworkDom with its default isUserEvent
      // (event.isTrusted): exactly the consumer's page.
    } as never);
    sessions.push(s);
    const unbind = bindCoworkDom(s);
    await wait();
    relay(field);
    await wait(20);
    // Held by the writer at the moment of the write...
    expect(document.documentElement.getAttribute("data-cowork-blocked")).toBe("ranked");
    const composer = document.querySelector("[data-co-handle]") as HTMLElement;
    expect(composer.textContent).toBe("Hello from support");
    // ...and it stays, past the verify window and the revert watch.
    await wait(1_200);
    expect(composer.textContent).toBe("Hello from support");
    // Our write is never posted back as the held person's own field edit.
    expect(posts.filter((p) => p.kind === "field")).toEqual([]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("[cowork]"))).toEqual([]);
    unbind();
  });
});
