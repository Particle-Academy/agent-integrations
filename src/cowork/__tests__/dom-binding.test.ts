// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bindCoworkDom } from "../dom-binding";

/*
 * MOIC, live on 0.64.0: with identical code one run posted field intents and the
 * next posted none. bindCoworkDom only listened for `input` / `change`. A rich-text
 * composer (Lexical, ProseMirror, Slate, ...) cancels the trusted `beforeinput` and
 * edits the DOM itself, and a cancelled beforeinput fires NO `input` event, so the
 * person's typing was never seen; only the keys the editor let through natively were.
 */

const user = <T extends Event>(e: T): T => Object.assign(e, { user: true });
const isUser = (e: Event) => (e as Event & { user?: boolean }).user === true;

let calls: Array<[string, unknown]>;
const session = { reportField: (handle: string, value: unknown) => { calls.push([handle, value]); return Promise.resolve({ allow: true } as never); } };

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  document.body.innerHTML = '<div id="root"></div>';
});
afterEach(() => vi.useRealTimers());

/** An editor that handles every key itself: beforeinput is cancelled, no input event follows. */
function richEditor(host: HTMLElement) {
  host.addEventListener("beforeinput", (e) => {
    e.preventDefault();
    const data = (e as InputEvent).data ?? "";
    // The editor's own DOM update, a moment later (a microtask or a frame).
    queueMicrotask(() => {
      const p = host.querySelector("p") ?? host.appendChild(document.createElement("p"));
      if ((e as InputEvent).inputType === "deleteContentBackward") p.textContent = (p.textContent ?? "").slice(0, -1);
      else p.textContent = (p.textContent ?? "") + data;
    });
  });
}

async function typeRich(host: HTMLElement, text: string) {
  for (const ch of text) {
    host.dispatchEvent(user(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true })));
    host.dispatchEvent(user(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: ch })));
    host.dispatchEvent(user(new KeyboardEvent("keyup", { key: ch, bubbles: true })));
    await vi.advanceTimersByTimeAsync(40);
  }
}

describe("bindCoworkDom", () => {
  it("reports a rich-text composer that cancels beforeinput and fires no input event, mounted after binding", async () => {
    const root = document.getElementById("root")!;
    const off = bindCoworkDom(session, { root, isUserEvent: isUser });
    // Mounted AFTER the binding (a new chat), the handle on the editing host.
    const host = document.createElement("div");
    host.setAttribute("contenteditable", "true");
    host.setAttribute("data-co-handle", "composer");
    root.appendChild(host);
    richEditor(host);

    await typeRich(host, "Hello");
    await vi.advanceTimersByTimeAsync(400);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.at(-1)).toEqual(["composer", "Hello"]);
    off();
  });

  it("a key that changes nothing (an arrow) reports nothing", async () => {
    const root = document.getElementById("root")!;
    root.innerHTML = '<div contenteditable="true" data-co-handle="composer"><p>Hi</p></div>';
    const off = bindCoworkDom(session, { root, isUserEvent: isUser });
    const host = root.firstElementChild as HTMLElement;
    host.dispatchEvent(user(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    host.dispatchEvent(user(new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true })));
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toEqual([]);
    off();
  });

  it("an untrusted DOM change (the session applying a peer's value) is never reported", async () => {
    const root = document.getElementById("root")!;
    root.innerHTML = '<div contenteditable="true" data-co-handle="composer"></div>';
    const off = bindCoworkDom(session, { root, isUserEvent: isUser });
    const host = root.firstElementChild as HTMLElement;
    host.textContent = "from a peer";
    host.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toEqual([]);
    off();
  });

  it("a plain contenteditable still reports once per edit, not twice (input and keyup)", async () => {
    const root = document.getElementById("root")!;
    root.innerHTML = '<div contenteditable="true" data-co-handle="composer"></div>';
    const off = bindCoworkDom(session, { root, isUserEvent: isUser, throttleMs: 0 });
    const host = root.firstElementChild as HTMLElement;
    host.dispatchEvent(user(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "a" })));
    host.textContent = "a";
    host.dispatchEvent(user(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "a" })));
    host.dispatchEvent(user(new KeyboardEvent("keyup", { key: "a", bubbles: true })));
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toEqual([["composer", "a"]]);
    off();
  });
});
