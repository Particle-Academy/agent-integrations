// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCoworkSession, type CoworkSession, type CoworkSessionOptions } from "../session";
import { createMemoryTransport, type MemoryHub } from "../transport";
import type { NavigationBridgeAdapter } from "../../bridges/navigation";

/*
 * The multi-page document editor: editors on the SAME page see each other's
 * edits to the shared document fields, last writer wins; editors elsewhere see
 * only presence. Opt-in per page with `sharedFields`.
 */
let hub: MemoryHub;
const sessions: CoworkSession[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  hub = createMemoryTransport();
  document.body.innerHTML = "";
});
afterEach(() => {
  for (const s of sessions.splice(0)) s.destroy();
  vi.useRealTimers();
});
const settle = () => vi.advanceTimersByTimeAsync(0);

const HTML = `
  <input data-co-handle="doc.title" />
  <textarea data-co-handle="doc.body"></textarea>
  <input data-co-handle="doc.pin" type="password" />
  <section data-cowork="view-only"><input data-co-handle="doc.locked" /></section>
  <input data-co-handle="nav.search" />`;

type Editor = { session: CoworkSession; root: HTMLElement; applied: Array<[string, unknown]> };

function editor(ref: string, extra: Partial<CoworkSessionOptions> & { echo?: boolean } = {}): Editor {
  const root = document.createElement("div");
  root.innerHTML = HTML;
  document.body.appendChild(root);
  const applied: Array<[string, unknown]> = [];
  const { echo, ...rest } = extra;
  let session!: CoworkSession;
  const adapter: NavigationBridgeAdapter = {
    getLocation: () => ({ url: "/doc/1", title: "" }),
    describe: () => ({ url: "/doc/1", title: "", actions: [] }),
    visit: () => {},
    scrollTo: () => {},
    scrollBy: () => {},
    setField: (handle, value) => {
      applied.push([handle, value]);
      // A real host reports every input event, including the ones this write dispatches.
      if (echo) void session.reportField(handle, value);
      return { ok: true };
    },
    click: () => ({ ok: true }),
    submit: () => ({ ok: true }),
  };
  session = createCoworkSession({
    sessionId: "doc",
    self: { ref, label: ref },
    transport: hub.connect({ ref, label: ref }),
    adapter,
    config: { control: { mode: "free" } },
    authorize: () => true,
    root,
    now: () => 1_000,
    sharedFields: ["doc.*"],
    ...rest,
  });
  sessions.push(session);
  return { session, root, applied };
}

async function onRoute(e: Editor, route: string) {
  await e.session.reportVisit(route);
  await settle();
}

const fieldFrames = () => hub.wire.filter((m) => (m.frame as { t?: string; intent?: { kind?: string } }).t === "intent" && (m.frame as { intent?: { kind?: string } }).intent?.kind === "field");

describe("shared document fields", () => {
  it("applies an edit by a peer on the same page", async () => {
    const a = editor("a");
    const b = editor("b");
    await settle();
    await a.session.reportField("doc.title", "Q3 plan");
    await settle();
    expect(b.applied).toEqual([["doc.title", "Q3 plan"]]);
    expect(a.applied).toEqual([]);
  });

  it("does not apply an edit made on another page", async () => {
    const a = editor("a");
    const b = editor("b");
    await settle();
    await onRoute(a, "/doc/1/page/2");
    await a.session.reportField("doc.title", "elsewhere");
    await settle();
    expect(b.applied).toEqual([]);
  });

  it("applies only handles the page shares; other fields stay presence", async () => {
    const a = editor("a");
    const b = editor("b");
    await settle();
    await a.session.reportField("nav.search", "invoices");
    await settle();
    expect(b.applied).toEqual([]);
  });

  it("is off unless the page opts in", async () => {
    const a = editor("a", { sharedFields: [] });
    const b = editor("b", { sharedFields: undefined });
    await settle();
    await a.session.reportField("doc.title", "x");
    await settle();
    expect(b.applied).toEqual([]);
  });

  it("never carries or applies a masked value, and never writes into a view-only region", async () => {
    const a = editor("a");
    const b = editor("b");
    await settle();
    await a.session.reportField("doc.pin", "4242");
    await a.session.reportField("doc.locked", "nope");
    await settle();
    expect(JSON.stringify(hub.wire)).not.toContain("4242");
    expect(JSON.stringify(hub.wire)).not.toContain("nope");
    expect(b.applied).toEqual([]);
  });

  it("does not echo: a value applied here is not sent back, so two editors cannot ping-pong", async () => {
    const a = editor("a", { echo: true });
    const b = editor("b", { echo: true });
    await settle();
    const before = fieldFrames().length;
    await a.session.reportField("doc.body", "draft");
    await settle();
    await settle();
    expect(b.applied).toEqual([["doc.body", "draft"]]);
    expect(a.applied).toEqual([]);
    expect(fieldFrames().length - before).toBe(1);
    // A genuinely new local edit of the same field still goes out.
    await b.session.reportField("doc.body", "draft, revised");
    await settle();
    expect(a.applied).toEqual([["doc.body", "draft, revised"]]);
  });

  it("sends a person's edit back to their own earlier value after a peer's value was applied", async () => {
    const a = editor("a");
    const b = editor("b");
    await settle();
    await b.session.reportField("doc.title", "mine");
    await settle();
    await a.session.reportField("doc.title", "theirs");
    await settle();
    expect(b.applied.at(-1)).toEqual(["doc.title", "theirs"]);
    // Back to "mine": a real edit on b's side, even though b once sent it.
    const before = a.applied.length;
    await b.session.reportField("doc.title", "mine");
    await settle();
    expect(a.applied.slice(before)).toEqual([["doc.title", "mine"]]);
  });

  it("does not overwrite a field the person is typing in; applies the latest value on blur", async () => {
    const a = editor("a");
    const b = editor("b");
    await settle();
    const title = b.root.querySelector<HTMLInputElement>('[data-co-handle="doc.title"]')!;
    title.focus();
    await a.session.reportField("doc.title", "first");
    await a.session.reportField("doc.title", "second");
    await settle();
    expect(b.applied).toEqual([]);
    title.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await settle();
    expect(b.applied).toEqual([["doc.title", "second"]]);
  });

  it("drops the waiting value when the person edits the field before blurring (their edit is newer)", async () => {
    const a = editor("a");
    const b = editor("b");
    await settle();
    const title = b.root.querySelector<HTMLInputElement>('[data-co-handle="doc.title"]')!;
    title.focus();
    await a.session.reportField("doc.title", "theirs");
    await settle();
    await b.session.reportField("doc.title", "mine");
    title.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await settle();
    expect(b.applied).toEqual([]);
    expect(a.applied).toEqual([["doc.title", "mine"]]);
  });
});
