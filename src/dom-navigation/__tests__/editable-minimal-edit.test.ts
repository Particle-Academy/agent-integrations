// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { setEditableText } from "../agent";

/*
 * A peer's text arriving in a contenteditable must be a MINIMAL edit: only the
 * changed range is replaced, in place, so the caret, the selection and the text
 * node a framework holds all survive. Replacing `textContent` threw away the node
 * and put the caret at the start, so a person typing at the end lost their place.
 */
let el: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="c" contenteditable="true" data-co-handle="composer">hello world</div>';
  el = document.getElementById("c")!;
});

const caretAt = (node: Node, offset: number) => {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
};
const caret = () => {
  const s = window.getSelection()!;
  return { node: s.anchorNode, offset: s.anchorOffset };
};

describe("setEditableText makes a minimal edit", () => {
  it("keeps the same text node, so a framework's reference to it stays valid", () => {
    const node = el.firstChild;
    setEditableText(el, "hello brave world");
    expect(el.textContent).toBe("hello brave world");
    expect(el.firstChild).toBe(node);
    expect(el.childNodes.length).toBe(1);
  });

  it("keeps the caret where it was when the change lands after it", () => {
    const node = el.firstChild!;
    caretAt(node, 5); // after "hello"
    setEditableText(el, "hello world, and more");
    expect(caret()).toEqual({ node, offset: 5 });
  });

  it("moves the caret with the text when the change lands before it", () => {
    const node = el.firstChild!;
    caretAt(node, 11); // at the end of "hello world"
    setEditableText(el, "Oh, hello world");
    expect(el.textContent).toBe("Oh, hello world");
    expect(caret()).toEqual({ node, offset: 15 });
  });

  it("changes nothing, and fires nothing, when the text is already the value", () => {
    const node = el.firstChild;
    let fired = 0;
    el.addEventListener("input", () => fired++);
    setEditableText(el, "hello world");
    expect(el.firstChild).toBe(node);
    expect(fired).toBe(0);
  });

  it("replaces a middle range across several text nodes and leaves the rest alone", () => {
    el.innerHTML = "";
    const a = document.createTextNode("one ");
    const b = document.createTextNode("two ");
    const c = document.createTextNode("three");
    el.append(a, b, c);
    setEditableText(el, "one 2 three");
    expect(el.textContent).toBe("one 2 three");
    expect(a.isConnected).toBe(true);
    expect(c.isConnected).toBe(true);
  });

  it("fills an empty editable and empties a full one", () => {
    el.textContent = "";
    setEditableText(el, "first");
    expect(el.textContent).toBe("first");
    setEditableText(el, "");
    expect(el.textContent).toBe("");
  });

  it("still fires one input event (insertReplacementText) for a real change", () => {
    const events: string[] = [];
    el.addEventListener("input", (e) => events.push((e as InputEvent).inputType));
    setEditableText(el, "hello there");
    expect(events).toEqual(["insertReplacementText"]);
  });
});
