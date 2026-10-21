import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomNavigationAgent } from "../agent";

/**
 * The in-page half: the DOM walker that used to live only in px-ui-sandbox's
 * CoBrowseProvider. jsdom has no layout, so every element reports zero client
 * rects and would read as invisible — the stub below gives each element one
 * rect, and `hidden` / `aria-hidden` remain the way to hide something.
 */
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => ({ length: 1, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  document.title = "";
});

const page = (html: string, title = "Test page") => {
  document.title = title;
  document.body.innerHTML = html;
};

describe("describe(): handles", () => {
  it("prefers data-co-handle, then name, then id, then role#index", () => {
    page(`
      <button data-co-handle="save" name="ignored" id="ignored-too">Save</button>
      <input name="email" id="email-id" />
      <button id="publish">Publish</button>
      <div role="button" id="div-btn">Div button</div>
      <button>Anonymous</button>
    `);
    const handles = createDomNavigationAgent().describe().actions.map((a) => a.handle);
    expect(handles).toEqual(["save", "email", "publish", "div-btn", "button#0"]);
  });

  it("gives a duplicate handle a synthetic role#index instead of clobbering the first", () => {
    page(`<input name="q" /><input name="q" />`);
    const actions = createDomNavigationAgent().describe().actions;
    expect(actions.map((a) => a.handle)).toEqual(["q", "textbox#0"]);
  });

  it("skips hidden, aria-hidden and type=hidden elements", () => {
    page(`
      <button hidden>Gone</button>
      <button aria-hidden="true">Also gone</button>
      <input type="hidden" name="csrf" value="secret" />
      <button>Shown</button>
    `);
    const labels = createDomNavigationAgent().describe().actions.map((a) => a.label);
    expect(labels).toEqual(["Shown"]);
  });

  it("reports url as pathname+search and the document title", () => {
    page(`<a href="/x">X</a>`, "Hello");
    const snap = createDomNavigationAgent().describe();
    expect(snap.title).toBe("Hello");
    expect(snap.url).toBe(window.location.pathname + window.location.search);
  });
});

describe("describe(): roles, names, destructive", () => {
  it("derives ARIA-ish roles", () => {
    page(`
      <a href="/a">A</a><button>B</button><select name="s"><option>1</option></select>
      <textarea name="t"></textarea><input type="checkbox" name="c" /><input type="radio" name="r" />
      <input type="submit" name="go" value="Go" /><input type="text" name="txt" /><div role="tab" id="tab1">T</div>
    `);
    const roles = Object.fromEntries(createDomNavigationAgent().describe().actions.map((a) => [a.handle, a.role]));
    expect(roles).toMatchObject({
      "link#0": "link",
      "button#1": "button",
      s: "select",
      t: "textbox",
      c: "checkbox",
      r: "radio",
      go: "button",
      txt: "textbox",
      tab1: "tab",
    });
  });

  it("resolves accessible names in order: aria-label, aria-labelledby, label[for], wrapping label, placeholder, text, name", () => {
    page(`
      <span id="lb1">Labelled</span><span id="lb2">by two</span>
      <input name="a" aria-label=" Aria name " />
      <input name="b" aria-labelledby="lb1 lb2" />
      <label for="c-id">For label</label><input name="c" id="c-id" />
      <label>Wrapping <input name="d" /></label>
      <input name="e" placeholder="Placeholder" />
      <button name="f">  Button
         text  </button>
      <input name="g" />
    `);
    const names = Object.fromEntries(createDomNavigationAgent().describe().actions.map((a) => [a.handle, a.label]));
    expect(names).toMatchObject({
      a: "Aria name",
      b: "Labelled by two",
      c: "For label",
      d: "Wrapping",
      e: "Placeholder",
      f: "Button text",
      g: "g",
    });
  });

  it("finds label[for] even when the id needs CSS escaping", () => {
    page(`<label for='we"ird id'>Weird</label><input name="w" id='we"ird id' />`);
    const action = createDomNavigationAgent().describe().actions.find((a) => a.handle === "w");
    expect(action?.label).toBe("Weird");
  });

  it("marks submits, data-co-confirm and destructive verbs as destructive", () => {
    page(`
      <button type="submit" name="s">Send</button>
      <button type="button" name="d">Delete account</button>
      <button type="button" name="x" data-co-confirm>Do it</button>
      <button type="button" name="ok">Open</button>
      <a href="/out">Log out</a>
    `);
    const d = Object.fromEntries(createDomNavigationAgent().describe().actions.map((a) => [a.handle, a.destructive]));
    expect(d).toMatchObject({ s: true, d: true, x: true, ok: false, "link#0": true });
  });
});

describe("masking: sensitive values never leave the page", () => {
  it("never returns a password, card, one-time-code or data-private value", () => {
    page(`
      <input type="password" name="pw" value="hunter2" />
      <input name="cc" autocomplete="cc-number" value="4242424242424242" />
      <input name="otp" autocomplete="one-time-code" value="123456" />
      <input name="priv" data-private value="private-value" />
      <textarea name="note" data-private>private-textarea</textarea>
      <input name="plain" value="visible" />
    `);
    const agent = createDomNavigationAgent();
    const snap = agent.describe();
    const wire = JSON.stringify(snap) + agent.read();
    for (const secret of ["hunter2", "4242424242424242", "123456", "private-value", "private-textarea"]) {
      expect(wire).not.toContain(secret);
    }
    expect(snap.actions.find((a) => a.handle === "plain")?.value).toBe("visible");
    expect(snap.actions.find((a) => a.handle === "pw")?.value).toBeUndefined();
  });

  it("still masks a password after the agent itself typed into it", () => {
    page(`<input type="password" name="pw" />`);
    const agent = createDomNavigationAgent();
    agent.describe();
    expect(agent.setField("pw", "s3cret")).toEqual({ ok: true });
    expect(JSON.stringify(agent.describe())).not.toContain("s3cret");
  });

  it("reports checkbox state as a boolean", () => {
    page(`<input type="checkbox" name="agree" checked />`);
    expect(createDomNavigationAgent().describe().actions[0].value).toBe(true);
  });
});

describe("setField: native setter + input/change so React-controlled inputs see it", () => {
  it("uses the prototype value setter, bypassing an instance-level override, and fires input then change", () => {
    page(`<input name="name" />`);
    const el = document.querySelector("input")!;
    // React's value tracker shadows `value` on the instance; a plain assignment
    // would hit this and React would never see the change.
    let shadowed: string | undefined;
    Object.defineProperty(el, "value", {
      configurable: true,
      get: () => "tracker",
      set: (v: string) => {
        shadowed = v;
      },
    });
    const events: string[] = [];
    el.addEventListener("input", (e) => events.push(`input:${e.bubbles}`));
    el.addEventListener("change", (e) => events.push(`change:${e.bubbles}`));

    const agent = createDomNavigationAgent();
    agent.describe();
    expect(agent.setField("name", "Ada")).toEqual({ ok: true });

    expect(shadowed).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.get!.call(el)).toBe("Ada");
    expect(events).toEqual(["input:true", "change:true"]);
  });

  it("sets textarea and select values and checkbox checked state", () => {
    page(`
      <textarea name="t"></textarea>
      <select name="s"><option value="a">A</option><option value="b">B</option></select>
      <input type="checkbox" name="c" />
    `);
    const agent = createDomNavigationAgent();
    agent.describe();
    agent.setField("t", "long text");
    agent.setField("s", "b");
    agent.setField("c", true);
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("long text");
    expect((document.querySelector("select") as HTMLSelectElement).value).toBe("b");
    expect((document.querySelector("[name=c]") as HTMLInputElement).checked).toBe(true);
  });

  it("refuses unknown handles and non-field elements", () => {
    page(`<button name="b">B</button>`);
    const agent = createDomNavigationAgent();
    agent.describe();
    expect(agent.setField("nope", "x")).toEqual({ ok: false, error: 'No element for handle "nope"' });
    expect(agent.setField("b", "x")).toEqual({ ok: false, error: 'Handle "b" is not a form field' });
  });

  it("resolves an attribute handle before describe() has run", () => {
    page(`<input data-co-handle="early" />`);
    const agent = createDomNavigationAgent();
    expect(agent.setField("early", "v")).toEqual({ ok: true });
    expect((document.querySelector("input") as HTMLInputElement).value).toBe("v");
  });
});

describe("click, submit, rectFor, read", () => {
  it("clicks by handle", () => {
    page(`<button name="go">Go</button>`);
    const onClick = vi.fn();
    document.querySelector("button")!.addEventListener("click", onClick);
    const agent = createDomNavigationAgent();
    agent.describe();
    expect(agent.click("go")).toEqual({ ok: true });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("submits the enclosing form via requestSubmit", () => {
    page(`<form><input name="q" /><button type="submit" name="send">Send</button></form>`);
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    document.querySelector("form")!.addEventListener("submit", onSubmit);
    const agent = createDomNavigationAgent();
    agent.describe();
    expect(agent.submit("q")).toEqual({ ok: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    page(`<button name="lonely">x</button>`);
    expect(agent.submit("lonely")).toEqual({ ok: false, error: 'Handle "lonely" is not inside a form' });
  });

  it("calls beforeAction at the points the sandbox marks agent attribution", () => {
    page(`<form><input name="q" /><button name="b">B</button></form>`);
    const beforeAction = vi.fn();
    document.querySelector("form")!.addEventListener("submit", (e) => e.preventDefault());
    const agent = createDomNavigationAgent({ beforeAction });
    agent.describe();
    agent.setField("q", "x");
    agent.click("b");
    agent.submit("q");
    agent.click("missing");
    expect(beforeAction.mock.calls.map((c) => c[0])).toEqual(["setField", "click", "submit"]);
  });

  it("rectFor returns the viewport rect, or null for an unknown handle", () => {
    page(`<button name="b">B</button>`);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 10, top: 20, width: 30, height: 40, x: 10, y: 20, right: 40, bottom: 60, toJSON: () => ({}),
    } as DOMRect);
    const agent = createDomNavigationAgent();
    agent.describe();
    expect(agent.rectFor("b")).toEqual({ x: 10, y: 20, width: 30, height: 40 });
    expect(agent.rectFor("missing")).toBeNull();
  });

  it("read() returns title, heading outline and main text", () => {
    page(`<header>Skip me</header><main><h1>Top</h1><h2>Sub</h2><p>Body   copy</p></main>`, "Doc");
    const text = createDomNavigationAgent().read();
    expect(text.split("\n").slice(0, 3)).toEqual(["Doc", "H1: Top", "H2: Sub"]);
    expect(text).toContain("TopSubBody copy");
    expect(text).not.toContain("Skip me");
  });
});

describe("call(): the serialisable dispatch the injected script exposes", () => {
  it("dispatches known methods and rejects anything else", () => {
    page(`<button name="b">B</button>`);
    const agent = createDomNavigationAgent();
    expect((agent.call("describe", []) as { actions: unknown[] }).actions).toHaveLength(1);
    expect(() => agent.call("constructor" as never, [])).toThrow(/Unknown dom-navigation method/);
    expect(() => agent.call("__proto__" as never, [])).toThrow(/Unknown dom-navigation method/);
  });

  it("visit refuses non-http(s) schemes", () => {
    const agent = createDomNavigationAgent();
    expect(() => agent.visit("javascript:alert(1)")).toThrow(/Refusing/);
  });
});
