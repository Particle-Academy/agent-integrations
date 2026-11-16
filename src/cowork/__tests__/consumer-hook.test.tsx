// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useMemo } from "react";

import { createDomNavigationAgent } from "../../dom-navigation/agent";
import { bindCoworkDom } from "../dom-binding";
import { createServerTransport, type PresenceChannelLike } from "../transport";
import { useCoworkSession } from "../use-cowork-session";

/*
 * The consumer's subject page, option for option: useCoworkSession with a memoized
 * config (ranked, scope session, a rank FUNCTION, idleMs 3000), our unmodified
 * createDomNavigationAgent as the adapter with only `visit` overridden, presenceRouting
 * server, sharedFields ['composer'], no starter, bindCoworkDom(session) on the document,
 * and a contentEditable DIV composer. The admin's frames are the consumer's, verbatim.
 * Their probe: the frame reached the transport, yet no hold and no write.
 */

afterEach(() => { cleanup(); vi.restoreAllMocks(); document.documentElement.removeAttribute("data-cowork-blocked"); });

const SESSION = "01M7HET0F16A6DYGN7H0SBK3WA";
function channelDouble() {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const channel: PresenceChannelLike = {
    here() { return channel; }, joining() { return channel; }, leaving() { return channel; },
    whisper() { return channel; }, listenForWhisper() { return channel; },
    listen(event, cb) { (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(cb); return channel; },
    stopListening(event, cb) { if (cb) listeners.get(event)?.delete(cb); return channel; },
  };
  return { channel, relay: (p: unknown) => { for (const cb of listeners.get(".cowork.intent") ?? []) cb(p); } };
}
const syncBody = { session: { state: "live", starter: "user:1", consent: "notify", consented: false, routing: "server",
  control: { mode: "ranked", scope: "session", idleMs: 3000, views: {} },
  participants: [
    { ref: "user:1", actingFor: "user:4", route: "/dashboard", revision: 0, follows: "user:4", rank: 2 },
    { ref: "user:4", route: "/dashboard", revision: 0, follows: "user:1", rank: 1 },
  ] } };
const fetchDouble = (async (_url: string, init?: { method?: string }) =>
  ((init?.method ?? "GET") === "GET"
    ? { ok: true, status: 200, json: async () => syncBody }
    : { ok: true, status: 202, json: async () => ({}) })) as never;
const cursor = { id: "user1-8pf21ve2hy", session: SESSION, from: "user:1", intent: { kind: "cursor", route: "/dashboard", anchor: '[data-co-handle="composer"]', fx: 0.4999, fy: 0.5 } };
const field = { id: "user1-g1l5m6br0l", session: SESSION, from: "user:1", view: "user:1", revision: 0, intent: { kind: "field", handle: "composer", value: "Hello from support" } };

function SubjectPage({ channel }: { channel: PresenceChannelLike }) {
  const subject = "user:4";
  const transport = useMemo(() => createServerTransport({ sessionId: SESSION, self: "user:4", channel, fetch: fetchDouble }), [channel]);
  const config = useMemo(() => ({ consent: "notify", control: { mode: "ranked", scope: "session", rank: (ref: string) => (ref === subject ? 1 : 2), idleMs: 3000 } }), [subject]);
  const adapter = useMemo(() => { const agent = createDomNavigationAgent(); return { ...agent, visit: () => {} }; }, []);
  const session = useCoworkSession({
    sessionId: SESSION, self: { ref: "user:4", label: "Bob Johnson" }, transport, adapter,
    config, sharedFields: ["composer"], authorize: () => true, presenceRouting: "server",
  } as never);
  useEffect(() => (session.ready ? bindCoworkDom(session) : undefined), [session.ready, session.reportField]);
  return <div data-co-handle="composer" contentEditable suppressContentEditableWarning />;
}

describe("the consumer's subject page, option for option", () => {
  it("holds the subject and writes the admin's text into the contentEditable composer", async () => {
    const { channel, relay } = channelDouble();
    render(<SubjectPage channel={channel} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    await act(async () => {
      relay(cursor);
      relay(field);
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(document.documentElement.getAttribute("data-cowork-blocked")).toBe("ranked");
    expect((document.querySelector('[data-co-handle="composer"]') as HTMLElement).textContent).toBe("Hello from support");
  });
});
