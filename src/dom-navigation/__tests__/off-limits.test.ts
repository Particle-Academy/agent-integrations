import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agentModule from "../agent";
import { createDomNavigationAgent, readPage, walk } from "../agent";

/**
 * The off-limits fence: an area of the page, marked `data-agent-off-limits` or
 * matched by a host `exclude` selector, that an agent may know EXISTS but may
 * neither read into nor act on. Consent is the case that forced it: a person
 * approving an agent's click on "Accept all" is still the agent's act.
 *
 * Every refusal below is checked against a live element at action time, so a
 * handle captured before the marker appeared, or forged from an id the agent
 * was never shown, is refused the same way.
 */
const isOffLimits = (agentModule as Record<string, unknown>).isOffLimits as
  | ((el: Element, options?: { exclude?: string | string[] }) => boolean)
  | undefined;

const REFUSAL = /off-limits to agents/i;

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

const page = (html: string) => {
  document.body.innerHTML = html;
};

/** A consent banner shaped like fancy-compliance-ui's, next to an ordinary form. */
const CONSENT_PAGE = `
  <main>
    <h1>Shop</h1>
    <form id="search-form"><input name="q" /><button name="search">Search</button></form>
    <section data-agent-off-limits="consent" aria-label="Cookie consent">
      <h2>We use cookies</h2>
      <p>Analytics helps us improve.</p>
      <button id="accept-all" data-co-handle="accept">Accept all</button>
      <button id="reject-all">Reject all</button>
      <form id="prefs">
        <input type="checkbox" id="analytics" name="analytics" checked />
        <select name="region"><option value="eu">EU</option><option value="us">US</option></select>
        <input name="note" value="secret-preselected" />
        <button type="submit" id="save-prefs"><span id="save-label">Save choices</span></button>
      </form>
    </section>
  </main>`;

function listen(selector: string, type = "click") {
  const fn = vi.fn((e: Event) => e.preventDefault());
  document.querySelector(selector)!.addEventListener(type, fn);
  return fn;
}

describe("positive control: ordinary page areas are unaffected", () => {
  it("lists, clicks, sets and submits outside the area exactly as before", () => {
    page(CONSENT_PAGE);
    const onSearch = listen("[name=search]");
    const onSubmit = listen("#search-form", "submit");
    const agent = createDomNavigationAgent();
    const handles = agent.describe().actions.map((a) => a.handle);
    expect(handles).toEqual(["q", "search"]);
    expect(agent.setField("q", "shoes")).toEqual({ ok: true });
    expect((document.querySelector("[name=q]") as HTMLInputElement).value).toBe("shoes");
    expect(agent.click("search")).toEqual({ ok: true });
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(agent.submit("q")).toEqual({ ok: true });
    expect(onSubmit).toHaveBeenCalled();
    expect(agent.rectFor("q")).not.toBeNull();
    expect(agent.guard("click", "search")).toEqual({ ok: true });
  });

  it("a page with no marker reports no off-limits areas", () => {
    page(`<button name="go">Go</button>`);
    const snap = createDomNavigationAgent().describe();
    expect(snap.offLimits ?? []).toEqual([]);
    expect(snap.actions.map((a) => a.handle)).toEqual(["go"]);
  });
});

describe("describe(): the area exists, its role, nothing else", () => {
  it("reports the area with its purpose and role, and no handle, label or value inside it", () => {
    page(CONSENT_PAGE);
    const snap = createDomNavigationAgent().describe();
    expect(snap.offLimits).toEqual([{ role: "region", purpose: "consent" }]);
    const wire = JSON.stringify(snap);
    for (const leak of ["Accept all", "Reject all", "accept", "analytics", "secret-preselected", "Save choices", "cookies", "region\":\"eu"]) {
      expect(wire).not.toContain(leak);
    }
  });

  it("reports a nested area once, as its outermost area", () => {
    page(`<div data-agent-off-limits="consent" role="dialog"><div data-agent-off-limits><button>X</button></div></div>`);
    expect(createDomNavigationAgent().describe().offLimits).toEqual([{ role: "dialog", purpose: "consent" }]);
  });

  it("does not list an element OUTSIDE the area whose activation lands inside it", () => {
    page(`
      <label for="analytics" data-co-handle="analytics-label">Analytics cookies</label>
      <button aria-controls="panel" name="opener">Open</button>
      <div data-agent-off-limits><input type="checkbox" id="analytics" /><div id="panel"></div></div>
      <button name="plain">Plain</button>`);
    const snap = createDomNavigationAgent().describe();
    expect(snap.actions.map((a) => a.handle)).toEqual(["plain"]);
    expect(JSON.stringify(snap)).not.toContain("Analytics cookies");
  });

  it("does not leak area text through an outside element's accessible name", () => {
    page(`
      <button name="named" aria-labelledby="inside">x</button>
      <div data-co-handle="wrapper">Wrapper <span data-agent-off-limits>Accept all</span></div>
      <div data-agent-off-limits><span id="inside">Accept all</span></div>`);
    const wire = JSON.stringify(createDomNavigationAgent().describe());
    expect(wire).not.toContain("Accept all");
  });

  it("read() leaves out the area's text and headings", () => {
    page(CONSENT_PAGE);
    const r = createDomNavigationAgent().read();
    expect(r.headings.map((h) => h.text)).toEqual(["Shop"]);
    expect(r.text).toContain("Shop");
    expect(r.text).not.toContain("cookies");
    expect(r.text).not.toContain("Analytics");
    expect(r.text).not.toContain("Accept all");
  });

  it("the standalone walk() and readPage() honour the marker too", () => {
    page(CONSENT_PAGE);
    expect(walk(document).snapshot.actions.map((a) => a.handle)).toEqual(["q", "search"]);
    expect(readPage(document).text).not.toContain("Accept all");
  });
});

describe("every action on a handle inside the area is refused", () => {
  it("click, by data-co-handle, id and name, with a plain sentence", () => {
    page(CONSENT_PAGE);
    const onAccept = listen("#accept-all");
    const agent = createDomNavigationAgent();
    agent.describe();
    for (const h of ["accept", "reject-all", "analytics"]) {
      const res = agent.click(h);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(REFUSAL);
      expect(res.error).toMatch(/^[A-Z].*\.$/);
    }
    expect(onAccept).not.toHaveBeenCalled();
    expect((document.getElementById("analytics") as HTMLInputElement).checked).toBe(true);
  });

  it("setField on a text field, a checkbox and a select", () => {
    page(CONSENT_PAGE);
    const agent = createDomNavigationAgent();
    expect(agent.setField("note", "x").error).toMatch(REFUSAL);
    expect(agent.setField("analytics", false).error).toMatch(REFUSAL);
    expect(agent.setField("region", "us").error).toMatch(REFUSAL);
    expect((document.querySelector("[name=note]") as HTMLInputElement).value).toBe("secret-preselected");
    expect((document.getElementById("analytics") as HTMLInputElement).checked).toBe(true);
    expect((document.querySelector("[name=region]") as HTMLSelectElement).value).toBe("eu");
  });

  it("submit of a form inside the area, by the form or by one of its fields", () => {
    page(CONSENT_PAGE);
    const onSubmit = listen("#prefs", "submit");
    const agent = createDomNavigationAgent();
    expect(agent.submit("prefs").error).toMatch(REFUSAL);
    expect(agent.submit("note").error).toMatch(REFUSAL);
    expect(agent.click("save-prefs").error).toMatch(REFUSAL);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("focus-like reads: guard refuses, rectFor gives nothing, scrollTo throws the sentence", () => {
    page(CONSENT_PAGE);
    const agent = createDomNavigationAgent();
    expect(agent.guard("focus", "accept").ok).toBe(false);
    expect(agent.guard("focus", "accept").error).toMatch(REFUSAL);
    expect(agent.rectFor("accept")).toBeNull();
    expect(() => agent.scrollTo({ handle: "accept" })).toThrow(REFUSAL);
  });

  it("the serialisable call() path refuses the same way", () => {
    page(CONSENT_PAGE);
    const agent = createDomNavigationAgent();
    expect((agent.call("click", ["accept"]) as { error: string }).error).toMatch(REFUSAL);
    expect((agent.call("guard", ["click", "accept"]) as { ok: boolean }).ok).toBe(false);
  });

  it("a handle captured BEFORE the marker was added", () => {
    page(`<div id="banner"><button data-co-handle="accept">Accept all</button></div>`);
    const onAccept = listen("[data-co-handle=accept]");
    const agent = createDomNavigationAgent();
    expect(agent.describe().actions.map((a) => a.handle)).toEqual(["accept"]);
    document.getElementById("banner")!.setAttribute("data-agent-off-limits", "");
    expect(agent.click("accept").error).toMatch(REFUSAL);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("a nested child deep inside the area", () => {
    page(`<div data-agent-off-limits><div><button><span data-co-handle="deep">Accept</span></button></div></div>`);
    const onClick = listen("[data-co-handle=deep]");
    expect(createDomNavigationAgent().click("deep").error).toMatch(REFUSAL);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("a forged handle the agent was never shown", () => {
    page(`<div data-agent-off-limits><button id="never-described">Accept</button></div>`);
    const agent = createDomNavigationAgent();
    expect(agent.describe().actions).toEqual([]);
    expect(agent.click("never-described").error).toMatch(REFUSAL);
  });

  it("an empty or 'false' attribute value still fences: presence is the test", () => {
    page(`<div data-agent-off-limits="false"><button id="a">A</button></div>`);
    expect(createDomNavigationAgent().click("a").error).toMatch(REFUSAL);
  });
});

describe("indirection: an outside element that activates something inside", () => {
  it("a <label for> outside a control inside", () => {
    page(`<label for="c" id="lbl">Analytics</label><div data-agent-off-limits><input type="checkbox" id="c" /></div>`);
    const agent = createDomNavigationAgent();
    expect(agent.click("lbl").error).toMatch(REFUSAL);
    expect((document.getElementById("c") as HTMLInputElement).checked).toBe(false);
  });

  it("a child of a wrapping label whose control is inside", () => {
    page(`<label><span id="txt">Analytics</span><span data-agent-off-limits><input type="checkbox" id="c" /></span></label>`);
    expect(createDomNavigationAgent().click("txt").error).toMatch(REFUSAL);
    expect((document.getElementById("c") as HTMLInputElement).checked).toBe(false);
  });

  it("aria-controls, popovertarget and commandfor pointing inside", () => {
    page(`
      <button id="a" aria-controls="other panel">A</button>
      <button id="b" popovertarget="panel">B</button>
      <button id="c" commandfor="panel" command="show-modal">C</button>
      <div id="other"></div>
      <div data-agent-off-limits><div id="panel"></div></div>`);
    const agent = createDomNavigationAgent();
    for (const h of ["a", "b", "c"]) expect(agent.click(h).error).toMatch(REFUSAL);
  });

  it("a submit button outside, owning a form (form=) whose fields are inside", () => {
    page(`
      <form id="f"></form>
      <div data-agent-off-limits><input type="checkbox" name="analytics" form="f" /></div>
      <button type="submit" form="f" id="out-submit">Save</button>
      <input name="outside-field" form="f" />`);
    const onSubmit = listen("#f", "submit");
    const agent = createDomNavigationAgent();
    expect(agent.click("out-submit").error).toMatch(REFUSAL);
    expect(agent.submit("outside-field").error).toMatch(REFUSAL);
    expect(agent.submit("f").error).toMatch(REFUSAL);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("a submit or reset button inside a form that CONTAINS the area", () => {
    page(`
      <form id="f">
        <div data-agent-off-limits><input type="checkbox" id="c" checked /></div>
        <button id="go">Save</button>
        <button type="reset" id="clear">Reset</button>
        <input type="image" id="img" alt="Go" />
      </form>`);
    const onSubmit = listen("#f", "submit");
    const onReset = listen("#f", "reset");
    const agent = createDomNavigationAgent();
    for (const h of ["go", "clear", "img"]) expect(agent.click(h).error).toMatch(REFUSAL);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });

  it("a plain button (type=button) in such a form is not an activation of the form", () => {
    page(`
      <form id="f">
        <div data-agent-off-limits><input type="checkbox" id="c" /></div>
        <button type="button" id="plain">Help</button>
      </form>`);
    expect(createDomNavigationAgent().click("plain")).toEqual({ ok: true });
  });

  it("a radio outside whose group has a member inside", () => {
    page(`
      <form>
        <input type="radio" name="level" value="all" id="out" />
        <span data-agent-off-limits><input type="radio" name="level" value="none" id="in" checked /></span>
      </form>`);
    const agent = createDomNavigationAgent();
    expect(agent.click("out").error).toMatch(REFUSAL);
    expect(agent.setField("out", true).error).toMatch(REFUSAL);
    expect((document.getElementById("in") as HTMLInputElement).checked).toBe(true);
  });

  it("an <option> inside the area, by click", () => {
    page(`<div data-agent-off-limits><select name="s"><option id="o2" value="2">2</option></select></div>`);
    expect(createDomNavigationAgent().click("o2").error).toMatch(REFUSAL);
  });
});

describe("exclude: a host selector instead of the attribute", () => {
  it("a single selector fences its matches and their descendants", () => {
    page(`<div class="cmp-banner" role="dialog"><button id="ok">OK</button></div><button id="out">Out</button>`);
    const agent = createDomNavigationAgent({ exclude: ".cmp-banner" });
    const snap = agent.describe();
    expect(snap.actions.map((a) => a.handle)).toEqual(["out"]);
    expect(snap.offLimits).toEqual([{ role: "dialog" }]);
    expect(agent.click("ok").error).toMatch(REFUSAL);
    expect(agent.click("out")).toEqual({ ok: true });
  });

  it("a list of selectors", () => {
    page(`<div id="a"><button id="x">X</button></div><aside class="b"><button id="y">Y</button></aside>`);
    const agent = createDomNavigationAgent({ exclude: ["#a", ".b"] });
    expect(agent.click("x").error).toMatch(REFUSAL);
    expect(agent.click("y").error).toMatch(REFUSAL);
  });

  it("an invalid selector fails closed: refuses, never ignores", () => {
    page(`<button id="x">X</button>`);
    const agent = createDomNavigationAgent({ exclude: "[[[" });
    expect(agent.click("x").ok).toBe(false);
    expect(() => agent.describe()).toThrow();
  });
});

describe("containment: shadow roots and frames", () => {
  it("isOffLimits is exported and climbs out of an open shadow root", () => {
    expect(typeof isOffLimits).toBe("function");
    page(`<div data-agent-off-limits id="host-wrap"><div id="host"></div></div><div id="free-host"></div>`);
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    root.innerHTML = `<button id="in-shadow">Accept</button>`;
    const free = document.getElementById("free-host")!.attachShadow({ mode: "open" });
    free.innerHTML = `<button id="free">Free</button>`;
    expect(isOffLimits!(root.getElementById("in-shadow")!)).toBe(true);
    expect(isOffLimits!(free.getElementById("free")!)).toBe(false);
  });

  it("the exclude selector climbs out of a shadow root too", () => {
    page(`<div class="cmp"><div id="host"></div></div>`);
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    root.innerHTML = `<button id="b">B</button>`;
    expect(isOffLimits!(root.getElementById("b")!, { exclude: ".cmp" })).toBe(true);
  });

  it("an agent running in a same-origin iframe inside the area refuses", () => {
    page(`<div data-agent-off-limits><iframe id="fr"></iframe></div><iframe id="free"></iframe>`);
    const inner = (document.getElementById("fr") as HTMLIFrameElement).contentDocument!;
    inner.body.innerHTML = `<button id="b">Accept</button>`;
    const onClick = vi.fn();
    inner.getElementById("b")!.addEventListener("click", onClick);
    expect(createDomNavigationAgent({ document: inner }).click("b").error).toMatch(REFUSAL);
    expect(onClick).not.toHaveBeenCalled();

    const freeDoc = (document.getElementById("free") as HTMLIFrameElement).contentDocument!;
    freeDoc.body.innerHTML = `<button id="b">Fine</button>`;
    expect(createDomNavigationAgent({ document: freeDoc }).click("b")).toEqual({ ok: true });
  });

  it("the iframe element itself, inside the area, is refused from the top frame", () => {
    page(`<div data-agent-off-limits><iframe id="fr" title="Consent"></iframe></div>`);
    const agent = createDomNavigationAgent();
    expect(agent.click("fr").error).toMatch(REFUSAL);
    expect(agent.rectFor("fr")).toBeNull();
  });

  it("an embedder the agent cannot see (cross-origin) is treated as off-limits by default", () => {
    page(`<iframe id="fr"></iframe>`);
    const frame = document.getElementById("fr") as HTMLIFrameElement;
    const inner = frame.contentDocument!;
    inner.body.innerHTML = `<button id="b">B</button>`;
    // What a cross-origin child sees: a parent window, but no readable frameElement.
    Object.defineProperty(frame.contentWindow!, "frameElement", { configurable: true, get: () => null });
    const agent = createDomNavigationAgent({ document: inner });
    expect(agent.click("b").error).toMatch(REFUSAL);
    expect(agent.describe().actions).toEqual([]);
    const allowed = createDomNavigationAgent({ document: inner, opaqueEmbedder: "allow" });
    expect(allowed.click("b")).toEqual({ ok: true });
  });
});
