import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createDomNavigationAgent } from "../agent";

/**
 * setField against REAL React-controlled inputs. React's onChange for a
 * checkbox or radio listens to `click`, not `input` / `change` — so a write
 * that only fires those leaves React's state behind the DOM (measured on
 * fancy.gen against react-fancy's <Checkbox>: DOM false, React true).
 */
beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => ({ length: 1 }) as unknown as DOMRectList,
  );
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const render = (el: ReturnType<typeof createElement>) => {
  root = createRoot(container);
  act(() => root!.render(el));
};
const state = () => document.getElementById("state")!.textContent;

function Box() {
  const [checked, setChecked] = useState(true);
  return createElement(
    "div",
    null,
    createElement("input", { type: "checkbox", name: "share", checked, onChange: (e: any) => setChecked(e.target.checked) }),
    createElement("span", { id: "state" }, String(checked)),
  );
}

function Radios() {
  const [value, setValue] = useState("a");
  const radio = (v: string) =>
    createElement("input", { type: "radio", name: "pick", id: `pick-${v}`, value: v, checked: value === v, onChange: () => setValue(v) });
  return createElement("div", null, radio("a"), radio("b"), createElement("span", { id: "state" }, value));
}

function Text() {
  const [value, setValue] = useState("");
  return createElement(
    "div",
    null,
    createElement("input", { name: "q", value, onChange: (e: any) => setValue(e.target.value) }),
    createElement("span", { id: "state" }, value),
  );
}

describe("setField reaches React state", () => {
  it("a controlled checkbox: React sees false, then true", () => {
    render(createElement(Box));
    const agent = createDomNavigationAgent();
    agent.describe();
    act(() => void agent.setField("share", false));
    expect(state()).toBe("false");
    expect((document.querySelector("[name=share]") as HTMLInputElement).checked).toBe(false);
    act(() => void agent.setField("share", true));
    expect(state()).toBe("true");
  });

  it("setting a checkbox to the value it already has does not toggle it", () => {
    render(createElement(Box));
    const agent = createDomNavigationAgent();
    agent.describe();
    act(() => void agent.setField("share", true));
    expect(state()).toBe("true");
    expect((document.querySelector("[name=share]") as HTMLInputElement).checked).toBe(true);
  });

  it("a controlled radio group: React sees the new choice", () => {
    render(createElement(Radios));
    const agent = createDomNavigationAgent();
    agent.describe();
    act(() => void agent.setField("pick-b", true));
    expect(state()).toBe("b");
  });

  it("a controlled text input still works (the prototype-setter path)", () => {
    render(createElement(Text));
    const agent = createDomNavigationAgent();
    agent.describe();
    act(() => void agent.setField("q", "hello"));
    expect(state()).toBe("hello");
  });
});
