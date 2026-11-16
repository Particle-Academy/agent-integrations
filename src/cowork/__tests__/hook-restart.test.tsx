// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useMemo } from "react";

import { createCoworkSession } from "../session";
import { createServerTransport, type PeerTransport, type PresenceChannelLike } from "../transport";
import { useCoworkSession } from "../use-cowork-session";

/*
 * A consumer on 0.65.2: frames reached both pages' transports and NEITHER page's session
 * applied or held anything, in either direction, with nothing on the console. When
 * useCoworkSession re-creates its session (a new sessionId, self.ref, authorize going
 * from unset to set, or a new channel), the old session's destroy() CLOSED the transport
 * it was given. A host that keeps its transport in a useMemo hands the SAME object to the
 * new session: a closed transport, whose relay listener is gone. Now the hook never lets
 * a session close a transport it may reuse; it closes one only when the transport is
 * replaced or the component unmounts. And `debug: true` traces every receive step.
 */

afterEach(() => { cleanup(); vi.restoreAllMocks(); document.documentElement.removeAttribute("data-cowork-blocked"); });

function channelDouble() {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const channel: PresenceChannelLike = {
    here() { return channel; }, joining() { return channel; }, leaving() { return channel; },
    whisper() { return channel; }, listenForWhisper() { return channel; },
    listen(event, cb) { (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(cb); return channel; },
    stopListening(event, cb) { if (cb) listeners.get(event)?.delete(cb); return channel; },
  };
  return { channel, relay: (p: unknown) => { for (const cb of listeners.get(".cowork.intent") ?? []) cb(p); }, listening: () => listeners.get(".cowork.intent")?.size ?? 0 };
}
const sync = (async (_u: string, init?: { method?: string }) => ((init?.method ?? "GET") === "GET"
  ? { ok: true, status: 200, json: async () => ({ session: { control: { mode: "ranked", scope: "session", idleMs: 3000, views: {} }, participants: [
      { ref: "user:1", route: "/dashboard", revision: 0, follows: null, rank: 2 },
      { ref: "user:4", route: "/dashboard", revision: 0, follows: null, rank: 1 },
    ] } }) }
  : { ok: true, status: 202, json: async () => ({}) })) as never;
const field = { id: "f", session: "s1", from: "user:1", view: "user:1", revision: 0, intent: { kind: "field", handle: "composer", value: "Hello from support" } };
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

function Page(props: { channel: PresenceChannelLike; authorize?: (() => boolean) | undefined }) {
  const transport = useMemo(() => createServerTransport({ sessionId: "s1", self: "user:4", channel: props.channel, fetch: sync }), [props.channel]);
  const s = useCoworkSession({
    sessionId: "s1", self: { ref: "user:4" }, transport,
    config: { consent: "notify", control: { mode: "ranked", scope: "session", rank: (r: string) => (r === "user:4" ? 1 : 2), idleMs: 3000 } },
    ...(props.authorize ? { authorize: props.authorize } : {}),
    presenceRouting: "server",
  } as never);
  return <span data-ready={String(s.ready)} />;
}

describe("useCoworkSession re-creating its session on the same transport", () => {
  it("the new session still receives: the transport the host keeps is not closed under it", async () => {
    const { channel, relay, listening } = channelDouble();
    const view = render(<Page channel={channel} />); // authorize not set yet (still loading)
    await settle();
    view.rerender(<Page channel={channel} authorize={() => true} />); // now bound: the hook restarts
    await settle();
    expect(listening()).toBeGreaterThan(0);
    await act(async () => { relay(field); await new Promise((r) => setTimeout(r, 20)); });
    expect(document.documentElement.getAttribute("data-cowork-blocked")).toBe("ranked");
  });

  it("unmounting still closes the transport (leaves the channel)", async () => {
    const { channel, listening } = channelDouble();
    const view = render(<Page channel={channel} authorize={() => true} />);
    await settle();
    expect(listening()).toBeGreaterThan(0);
    view.unmount();
    await Promise.resolve(); // closed once no session uses it, a microtask later
    expect(listening()).toBe(0);
  });
});

describe("a destroyed session that still gets a frame", () => {
  it("warns once (its transport kept delivering after destroy)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let deliver: ((m: { from: string; frame: unknown }) => void) | null = null;
    const transport: PeerTransport = {
      routing: "server", send: async () => ({ allow: true }) as never,
      onFrame: (fn) => { deliver = fn as never; return () => {}; }, // never unsubscribes
      onPresence: () => () => {}, close: () => {}, sync: async () => null,
    };
    const s = createCoworkSession({ sessionId: "s1", self: { ref: "user:4" }, transport, config: { consent: "notify", control: { mode: "free" } }, authorize: () => true, presenceRouting: "server" });
    s.destroy();
    deliver!({ from: "user:1", frame: { t: "intent", envelope: { id: "x", view: "user:1", revision: 0 }, intent: { kind: "scroll", y: 1 } } });
    deliver!({ from: "user:1", frame: { t: "intent", envelope: { id: "y", view: "user:1", revision: 0 }, intent: { kind: "scroll", y: 2 } } });
    await new Promise((r) => setTimeout(r, 10));
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("destroyed"))).toHaveLength(1);
  });
});

describe("debug: true", () => {
  it("traces a receive: the instance, frame in, queued, dequeued, committed, hold and apply decisions", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { channel, relay } = channelDouble();
    const s = createCoworkSession({
      sessionId: "s1", self: { ref: "user:4" }, debug: true,
      transport: createServerTransport({ sessionId: "s1", self: "user:4", channel, fetch: sync }),
      config: { consent: "notify", control: { mode: "ranked", scope: "session", rank: (r: string) => (r === "user:4" ? 1 : 2), idleMs: 3000 } },
      authorize: () => true, presenceRouting: "server", sharedFields: ["composer"],
    } as never);
    await new Promise((r) => setTimeout(r, 20));
    relay(field);
    await new Promise((r) => setTimeout(r, 20));
    const lines = log.mock.calls.map((c) => String(c[0]));
    const trace = lines.filter((l) => /^\[cowork#\d+\]/.test(l));
    for (const step of ["created", "frame in", "queued", "dequeued", "committed", "hold", "apply"]) {
      expect(trace.some((l) => l.includes(step)), step).toBe(true);
    }
    s.destroy();
  });
});

describe("StrictMode and separate React roots (the consumer's island layout)", () => {
  it("under StrictMode's double effects the session still receives", async () => {
    const { StrictMode } = await import("react");
    const { channel, relay } = channelDouble();
    render(<StrictMode><Page channel={channel} authorize={() => true} /></StrictMode>);
    await settle();
    await act(async () => { relay(field); await new Promise((r) => setTimeout(r, 20)); });
    expect(document.documentElement.getAttribute("data-cowork-blocked")).toBe("ranked");
  });

  it("the session in one root applies a peer's value to a contentEditable in ANOTHER root, which keeps it across that root's renders, and the person's edits there post", async () => {
    const { createRoot } = await import("react-dom/client");
    const { useEffect, useState } = await import("react");
    const { bindCoworkDom } = await import("../dom-binding");
    const { createDomNavigationAgent } = await import("../../dom-navigation/agent");
    const { channel, relay } = channelDouble();
    const posts: unknown[] = [];
    const fetchFn = (async (url: string, init?: { method?: string; body?: string }) => {
      if ((init?.method ?? "GET") !== "GET" && String(url).endsWith("/intents")) posts.push(JSON.parse(String(init?.body)).intent);
      return (sync as unknown as (u: string, i?: unknown) => Promise<unknown>)(url, init);
    }) as never;
    const isUser = (e: Event) => (e as Event & { user?: boolean }).user === true;

    function Island() {
      const transport = useMemo(() => createServerTransport({ sessionId: "s1", self: "user:4", channel, fetch: fetchFn }), []);
      const adapter = useMemo(() => ({ ...createDomNavigationAgent(), visit: () => {} }), []);
      const s = useCoworkSession({
        sessionId: "s1", self: { ref: "user:4" }, transport, adapter, sharedFields: ["composer"], authorize: () => true, presenceRouting: "server",
        config: { consent: "notify", control: { mode: "ranked", scope: "session", rank: (r: string) => (r === "user:4" ? 1 : 2), idleMs: 3000 } },
      } as never);
      useEffect(() => (s.ready ? bindCoworkDom(s, { isUserEvent: isUser }) : undefined), [s.ready, s.reportField]);
      return <span>bar</span>;
    }
    let bump: () => void = () => {};
    function Composer() {
      const [text, setText] = useState("");
      const [n, setN] = useState(0);
      bump = () => setN((x) => x + 1);
      return (
        <div>
          <span data-renders={n} />
          <div data-co-handle="composer" contentEditable suppressContentEditableWarning onInput={(e) => setText((e.target as HTMLElement).textContent ?? "")} data-text={text} />
        </div>
      );
    }
    const barEl = document.body.appendChild(document.createElement("header"));
    const appEl = document.body.appendChild(document.createElement("main"));
    const bar = createRoot(barEl);
    const app = createRoot(appEl);
    await act(async () => { bar.render(<Island />); app.render(<Composer />); await new Promise((r) => setTimeout(r, 20)); });

    await act(async () => { relay(field); await new Promise((r) => setTimeout(r, 30)); });
    const composer = appEl.querySelector('[data-co-handle="composer"]') as HTMLElement;
    expect(composer.textContent).toBe("Hello from support");
    expect(document.documentElement.getAttribute("data-cowork-blocked")).toBe("ranked");
    await act(async () => { bump(); await new Promise((r) => setTimeout(r, 10)); });
    expect(composer.textContent).toBe("Hello from support"); // the other root re-rendered; the text stays

    // Later, once free, the person types in the other root: it posts.
    await act(async () => { await new Promise((r) => setTimeout(r, 3_100)); });
    await act(async () => {
      composer.textContent = "Hello from support - thanks";
      composer.dispatchEvent(Object.assign(new InputEvent("input", { bubbles: true }), { user: true }));
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(posts).toContainEqual({ kind: "field", handle: "composer", value: "Hello from support - thanks" });
    await act(async () => { bar.unmount(); app.unmount(); });
  }, 15_000);
});
