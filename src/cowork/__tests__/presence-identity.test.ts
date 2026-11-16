// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCoworkSession, type CoworkSession } from "../session";
import { createServerTransport, createWhisperTransport, type PresenceChannelLike } from "../transport";

/*
 * A consumer's "View As": the admin and the person viewed are ONE Laravel account, and
 * the presence channel was authorized by Laravel's /broadcasting/auth, which keys a member
 * by the account. Pusher merged the two connections into one member carrying the
 * admin's info: on the subject's page `here` was [{ ref: "user:1" }] and its own person
 * was missing. Intents are attributed by the server's `from`, never by the member id, so
 * nothing here may drop one; what must happen is that the page SAYS its presence is
 * wrong (once), and that a collapsed `here` never evicts a participant the server lists.
 */

function channelDouble() {
  let here: ((members: unknown[]) => void) | null = null;
  let whisper: ((data: unknown, meta?: { userId?: string }) => void) | null = null;
  const channel: PresenceChannelLike = {
    here(cb) { here = cb; return channel; },
    joining() { return channel; },
    leaving() { return channel; },
    whisper() { return channel; },
    listenForWhisper(_e, cb) { whisper = cb; return channel; },
    listen() { return channel; },
    stopListening() { return channel; },
  };
  return { channel, fireHere: (m: unknown[]) => here?.(m), fireWhisper: (d: unknown, meta?: { userId?: string }) => whisper?.(d, meta) };
}
const sync = () => ({ ok: true, status: 200, json: async () => ({ session: { participants: [
  { ref: "user:1", route: "/dashboard", revision: 0, follows: null },
  { ref: "user:4", route: "/dashboard", revision: 0, follows: null },
] } }) }) as unknown as Response;

let sessions: CoworkSession[] = [];
let warn: { mock: { calls: unknown[][] } };
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {}) as never;
  document.body.innerHTML = '<div id="root"></div>';
});
afterEach(() => {
  for (const s of sessions) s.destroy();
  sessions = [];
  vi.restoreAllMocks();
});
const warned = (text: string) => warn.mock.calls.filter((c) => String(c[0]).includes(text));
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

function page(self: string) {
  const d = channelDouble();
  const s = createCoworkSession({
    sessionId: "s1", self: { ref: self },
    transport: createServerTransport({ sessionId: "s1", self, channel: d.channel, fetch: (async () => sync()) as never }),
    config: { consent: "notify", control: { mode: "free" } }, authorize: () => true,
    root: document.getElementById("root")!, presenceRouting: "server", heartbeatMs: 60_000,
  });
  sessions.push(s);
  return { s, ...d };
}

describe("presence identity", () => {
  it("warns once when the presence list does not contain this page's own person (a shared member id)", async () => {
    const { fireHere } = page("user:4");
    await settle();
    // The subject's subscription_succeeded under View As: one member, the ADMIN's info.
    fireHere([{ route: "/dashboard", ref: "user:1", label: "Super", view: "user:1" }]);
    fireHere([{ route: "/dashboard", ref: "user:1", label: "Super", view: "user:1" }]);
    await settle();
    const w = warned("presence");
    expect(w).toHaveLength(1);
    expect(String(w[0]![0])).toContain("user:4");
    expect(String(w[0]![0])).toContain("/auth");
  });

  it("says nothing when the presence list has this page's person", async () => {
    const { fireHere } = page("user:4");
    await settle();
    fireHere([{ ref: "user:1" }, { ref: "user:4" }]);
    await settle();
    expect(warned("presence")).toHaveLength(0);
  });

  it("under server routing, a collapsed `here` does not evict a participant the server lists", async () => {
    const { s, fireHere } = page("user:1");
    await settle();
    expect(s.getSnapshot().peers.map((p) => p.ref).sort()).toEqual(["user:1", "user:4"]);
    // The admin's page: the merged member carries the admin's own info, so Bob is "absent".
    fireHere([{ ref: "user:1" }]);
    await settle();
    expect(s.getSnapshot().peers.map((p) => p.ref).sort()).toEqual(["user:1", "user:4"]);
  });

  it("a whisper that cannot be attributed is warned once (direct routing)", async () => {
    const d = channelDouble();
    const s = createCoworkSession({
      sessionId: "s1", self: { ref: "a" }, transport: createWhisperTransport({ channel: d.channel, self: "a" }),
      config: { consent: "notify", control: { mode: "free" } }, authorize: () => true,
      root: document.getElementById("root")!, presenceRouting: "direct",
    });
    sessions.push(s);
    d.fireHere([{ ref: "a" }, { ref: "b" }]);
    d.fireWhisper({ v: 1, frame: { t: "cursor", route: "/", x: 1, y: 1 } });
    d.fireWhisper({ v: 1, frame: { t: "cursor", route: "/", x: 2, y: 2 } });
    d.fireWhisper({ v: 1, frame: { t: "cursor", route: "/", x: 3, y: 3 } }, { userId: "stranger" });
    await settle();
    expect(warned("whisper")).toHaveLength(2); // no sender stamp; a sender who is not a member
  });
});
