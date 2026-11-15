// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDomNavigationAgent } from "../agent";

/*
 * A contenteditable composer (a chat input, a tag input) is a text field to the
 * person typing in it. The agent treats it as one: plain text in and out. Rich
 * content (tag chips, formatting) is NOT carried: setField replaces the text.
 */
describe("contenteditable fields", () => {
  // jsdom has no layout: every element reads as visible, as the other DOM-agent suites do.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
      () => ({ length: 1, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    document.body.innerHTML = `
      <div contenteditable="true" data-co-handle="composer">hello</div>
      <div contenteditable data-co-handle="notes">draft</div>
      <div contenteditable="true" data-co-handle="secret" data-private>hidden</div>
      <section data-agent-off-limits="payment"><div contenteditable="true" data-co-handle="fenced">x</div></section>
      <div contenteditable="false" data-co-handle="readonly">no</div>
      <div data-co-handle="plain">not editable</div>`;
  });

  it("describes a contenteditable as a textbox carrying its text, never a sensitive one's", () => {
    const actions = createDomNavigationAgent().describe().actions;
    const by = (handle: string) => actions.find((a) => a.handle === handle);
    expect(by("composer")).toMatchObject({ role: "textbox", value: "hello" });
    expect(by("notes")).toMatchObject({ role: "textbox", value: "draft" });
    expect(by("secret")?.role).toBe("textbox");
    expect(by("secret")).not.toHaveProperty("value");
    expect(by("readonly")?.role).not.toBe("textbox");
  });

  it("setField replaces the text and fires an input event frameworks listen for", () => {
    const el = document.querySelector<HTMLElement>('[data-co-handle="composer"]')!;
    const seen: Array<{ type: string; inputType?: string; data?: string | null }> = [];
    el.addEventListener("input", (e) => seen.push({ type: e.type, inputType: (e as InputEvent).inputType, data: (e as InputEvent).data }));

    expect(createDomNavigationAgent().setField("composer", "typed for you")).toEqual({ ok: true });

    expect(el.textContent).toBe("typed for you");
    expect(seen).toEqual([{ type: "input", inputType: "insertReplacementText", data: "typed for you" }]);
  });

  it("writes plain text, never markup", () => {
    const el = document.querySelector<HTMLElement>('[data-co-handle="composer"]')!;
    createDomNavigationAgent().setField("composer", "<b>bold</b>");
    expect(el.textContent).toBe("<b>bold</b>");
    expect(el.querySelector("b")).toBeNull();
  });

  it("keeps the fences: off-limits and non-editable elements are refused", () => {
    const agent = createDomNavigationAgent();
    expect(agent.setField("fenced", "y").ok).toBe(false);
    expect(document.querySelector('[data-co-handle="fenced"]')!.textContent).toBe("x");
    expect(agent.setField("readonly", "y")).toMatchObject({ ok: false });
    expect(agent.setField("plain", "y")).toMatchObject({ ok: false, error: 'Handle "plain" is not a form field' });
  });
});
