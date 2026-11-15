// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { useCoworkSession, type UseCoworkSessionOptions } from "../use-cowork-session";
import { createMemoryTransport, type PeerTransport } from "../transport";
import { CoworkPresence } from "../../components/CoworkPresence";
import { CoBrowseCursorLayer } from "../../components/CoBrowseCursorLayer";
import type { CoworkSnapshot } from "../session";

afterEach(cleanup);

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function Room(props: UseCoworkSessionOptions & { onSession?: (s: ReturnType<typeof useCoworkSession>) => void }) {
  const session = useCoworkSession(props);
  props.onSession?.(session);
  return (
    <ul data-testid="peers">
      {session.peers.map((p) => (
        <li key={p.ref} data-ref={p.ref} data-follows={p.follows ?? ""}>{p.label}</li>
      ))}
    </ul>
  );
}

const base = (transport: PeerTransport, ref: string): UseCoworkSessionOptions => ({
  sessionId: "s1",
  self: { ref, label: ref.toUpperCase() },
  transport,
  config: { control: { mode: "free" } },
  authorize: () => true,
});

describe("useCoworkSession", () => {
  it("renders the peers and follows through the hook, and leaves on unmount", async () => {
    const hub = createMemoryTransport();
    const other = hub.connect({ ref: "b", label: "B" });
    let handle: ReturnType<typeof useCoworkSession> | undefined;
    const { getByTestId, unmount } = render(<Room {...base(hub.connect({ ref: "a", label: "A" }), "a")} onSession={(s) => { handle = s; }} />);
    await settle();
    expect(Array.from(getByTestId("peers").querySelectorAll("li")).map((li) => li.getAttribute("data-ref")).sort()).toEqual(["a", "b"]);
    expect(handle?.ready).toBe(true);

    await act(async () => { await handle!.follow("b"); });
    await settle();
    expect(getByTestId("peers").querySelector('[data-ref="a"]')?.getAttribute("data-follows")).toBe("b");

    unmount();
    expect(hub.peers().map((p) => p.ref)).toEqual(["b"]);
    other.close();
  });

  it("is inert and refuses until it has a transport", async () => {
    let handle: ReturnType<typeof useCoworkSession> | undefined;
    render(<Room {...base(undefined as unknown as PeerTransport, "a")} transport={undefined} onSession={(s) => { handle = s; }} />);
    await settle();
    expect(handle?.ready).toBe(false);
    expect(handle?.peers).toEqual([]);
    expect(await handle!.sendIntent({ kind: "scroll", y: 1 })).toEqual({ allow: false, reason: "cowork.session.not-ready", status: 0 });
  });
});

const snapshot = (over: Partial<CoworkSnapshot> = {}): CoworkSnapshot => ({
  sessionId: "s1",
  self: "user",
  routing: "direct",
  consent: "notify",
  configured: true,
  control: {},
  blocked: null,
  peers: [
    { ref: "user", label: "Uma", self: true, view: { route: "/", revision: 0 }, follows: null, drives: false, idle: false, cursor: null, activeField: null, online: true },
    { ref: "admin", label: "Admin", self: false, view: { route: "/", revision: 0 }, follows: "user", drives: true, idle: false, cursor: { x: 40, y: 60 }, activeField: null, online: true },
    { ref: "ed", label: "Ed", self: false, view: { route: "/", revision: 0 }, follows: null, drives: false, idle: true, cursor: null, activeField: null, online: true },
  ],
  ...over,
});

describe("CoworkPresence", () => {
  it("shows each peer with a stable handle, and the session indicator under notify", () => {
    const { container } = render(<CoworkPresence session={snapshot()} />);
    const root = container.querySelector("[data-cowork-presence]")!;
    expect(root.getAttribute("data-tone")).toBe("neutral");
    // A control surface: input blocking never swallows a press inside it.
    expect(root.hasAttribute("data-cowork-control")).toBe(true);
    expect(Array.from(root.querySelectorAll("[data-cowork-peer]")).map((el) => el.getAttribute("data-cowork-peer"))).toEqual(["user", "admin", "ed"]);
    expect(root.querySelector('[data-cowork-peer="admin"]')?.hasAttribute("data-drives")).toBe(true);
    expect(root.querySelector('[data-cowork-peer="ed"]')?.hasAttribute("data-idle")).toBe(true);
    expect(root.querySelector('[data-cowork-peer="user"]')?.hasAttribute("data-self")).toBe(true);
    expect(root.querySelector("[data-cowork-indicator]")?.textContent).toBe("Co-working session: 3 people");
  });

  it("warns while the local person is blocked, with the countdown", () => {
    const blocked = { view: "user", by: "admin", label: "Admin", until: 10_000, mode: "ranked" as const };
    const { container } = render(<CoworkPresence session={snapshot({ blocked })} now={() => 8_200} />);
    const root = container.querySelector("[data-cowork-presence]")!;
    expect(root.getAttribute("data-tone")).toBe("warning");
    expect(root.querySelector("[data-cowork-indicator]")?.textContent).toBe("Admin has control, 2s");
    expect(root.querySelector("[data-cowork-indicator]")?.getAttribute("role")).toBe("status");
  });

  it("names the baton holder without a countdown", () => {
    const blocked = { view: "user", by: "admin", label: "Admin", mode: "baton" as const };
    const { container } = render(<CoworkPresence session={snapshot({ blocked, consent: "none" })} />);
    expect(container.querySelector("[data-cowork-indicator]")?.textContent).toBe("Admin has control");
  });

  it("shows no indicator when the host chose no consent and nothing is blocked", () => {
    const { container } = render(<CoworkPresence session={snapshot({ consent: "none" })} />);
    expect(container.querySelector("[data-cowork-indicator]")).toBeNull();
    expect(container.querySelectorAll("[data-cowork-peer]")).toHaveLength(3);
  });

  it("takes every label from the host", () => {
    const blocked = { view: "user", by: "admin", label: "Admin", until: 10_000, mode: "ranked" as const };
    const { container } = render(
      <CoworkPresence
        session={snapshot({ blocked })}
        now={() => 9_000}
        labels={{ blocked: (who, seconds) => `${who} tiene el control (${seconds})` }}
      />,
    );
    expect(container.querySelector("[data-cowork-indicator]")?.textContent).toBe("Admin tiene el control (1)");
  });
});

describe("CoBrowseCursorLayer with peers", () => {
  it("draws one cursor per peer that has one, never for this browser", () => {
    render(<CoBrowseCursorLayer peers={snapshot()} />);
    const cursors = document.querySelectorAll("[data-cowork-cursor]");
    expect(Array.from(cursors).map((el) => el.getAttribute("data-cowork-cursor"))).toEqual(["admin"]);
    expect(document.body.textContent).toContain("Admin");
  });

  it("places an anchored cursor inside its handle's rect", () => {
    const anchor = document.createElement("input");
    anchor.setAttribute("data-co-handle", "email");
    anchor.getBoundingClientRect = () => ({ x: 100, y: 200, left: 100, top: 200, width: 50, height: 20, right: 150, bottom: 220, toJSON() {} }) as DOMRect;
    document.body.appendChild(anchor);
    const snap = snapshot();
    snap.peers[1] = { ...snap.peers[1]!, cursor: { anchor: "email", fx: 0.5, fy: 0.5 } };
    render(<CoBrowseCursorLayer peers={snap} />);
    const cursor = document.querySelector('[data-cowork-cursor="admin"]') as HTMLElement;
    expect(cursor.getAttribute("data-x")).toBe("125");
    expect(cursor.getAttribute("data-y")).toBe("210");
    anchor.remove();
  });

  it("renders nothing for peers without cursors", () => {
    const snap = snapshot();
    snap.peers = snap.peers.map((p) => ({ ...p, cursor: null }));
    render(<CoBrowseCursorLayer peers={snap} />);
    expect(document.querySelector("[data-co-browse-cursor-layer]")).toBeNull();
  });
});
