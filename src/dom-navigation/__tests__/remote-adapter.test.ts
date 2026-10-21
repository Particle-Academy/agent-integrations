import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerNavigationBridge } from "../../bridges/navigation";
import { createDomNavigationAgent } from "../agent";
import {
  createRemoteNavigationAdapter,
  domNavigationCallScript,
  DOM_NAVIGATION_GLOBAL,
  type DomNavigationTransport,
} from "../remote";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => ({ length: 1 }) as unknown as DOMRectList,
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 1, top: 2, width: 3, height: 4, x: 1, y: 2, right: 4, bottom: 6, toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/**
 * A transport that behaves like the real wire: every argument and result is
 * structured-cloned, so nothing but plain data crosses, and every call is
 * asynchronous — as it is over executeJavaScript or a MessagePort.
 */
function wireTo(agent: ReturnType<typeof createDomNavigationAgent>) {
  const calls: string[] = [];
  const transport: DomNavigationTransport = {
    call: async (method, args) => {
      calls.push(method);
      await Promise.resolve();
      return structuredClone(agent.call(method, structuredClone(args)));
    },
  };
  return { transport, calls };
}

const text = (r: any) => r.content?.[0]?.text ?? "";

describe("createRemoteNavigationAdapter → registerNavigationBridge, unchanged", () => {
  it("describes, reads, sets a field and clicks across an async, cloning transport", async () => {
    document.title = "Remote";
    document.body.innerHTML = `
      <main><h1>Welcome</h1>
        <input name="email" />
        <input type="password" name="pw" value="hunter2" />
        <button name="go">Go</button>
      </main>`;
    const onClick = vi.fn();
    document.querySelector("button")!.addEventListener("click", onClick);
    const { transport } = wireTo(createDomNavigationAgent());

    const host = new ToolRegistry();
    registerNavigationBridge(host, { adapter: createRemoteNavigationAdapter({ transport }) });

    const described = await host.callTool("page_describe", {});
    expect(described.isError).toBeFalsy();
    expect(text(described)).toContain("Title: Remote");
    expect(text(described)).toContain("[email] textbox: email");
    expect(text(described)).toContain("[go] button: Go");
    expect(JSON.stringify(described)).not.toContain("hunter2");

    const read = await host.callTool("page_read", {});
    expect(text(read)).toContain("H1: Welcome");

    const set = await host.callTool("page_set_field", { handle: "email", value: "ada@example.com" });
    expect(set.isError).toBeFalsy();
    expect(set.structuredContent).toMatchObject({ handle: "email", rect: { x: 1, y: 2, width: 3, height: 4 } });
    expect((document.querySelector("[name=email]") as HTMLInputElement).value).toBe("ada@example.com");

    const click = await host.callTool("page_click", { handle: "go" });
    expect(click.isError).toBeFalsy();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("stages a destructive click through the host's confirm", async () => {
    document.body.innerHTML = `<button name="del">Delete account</button>`;
    const onClick = vi.fn();
    document.querySelector("button")!.addEventListener("click", onClick);
    const { transport } = wireTo(createDomNavigationAgent());
    const confirm = vi.fn(async () => false);

    const host = new ToolRegistry();
    registerNavigationBridge(host, { adapter: createRemoteNavigationAdapter({ transport, confirm }) });
    await host.callTool("page_describe", {});
    const res = await host.callTool("page_click", { handle: "del" });

    expect(confirm).toHaveBeenCalledWith({ action: "click", handle: "del", label: "Delete account" });
    expect(res.isError).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("surfaces an in-page failure as a tool error, not a throw", async () => {
    document.body.innerHTML = ``;
    const { transport } = wireTo(createDomNavigationAgent());
    const host = new ToolRegistry();
    registerNavigationBridge(host, { adapter: createRemoteNavigationAdapter({ transport }) });
    const res = await host.callTool("page_set_field", { handle: "nope", value: "x" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('No element for handle "nope"');
  });
});

describe("the page is hostile: results are coerced to the declared shapes", () => {
  it("drops malformed actions and non-plain values instead of passing them through", async () => {
    const transport: DomNavigationTransport = {
      call: async (method) => {
        if (method === "describe") {
          return {
            url: 5,
            title: { evil: true },
            actions: [
              null,
              { handle: {}, role: "button", label: "no handle" },
              { handle: "ok", role: "button", label: "OK", destructive: "yes", value: { nested: 1 } },
              { handle: "t", role: 7, label: null, value: "kept" },
            ],
          };
        }
        if (method === "click") return { ok: "true", error: 42 };
        if (method === "rectFor") return { x: "1", y: 2, width: 3, height: 4 };
        if (method === "read") return { not: "text" };
        return undefined;
      },
    };
    const adapter = createRemoteNavigationAdapter({ transport });
    expect(await adapter.describe()).toEqual({
      url: "",
      title: "",
      actions: [
        { handle: "ok", role: "button", label: "OK", destructive: false },
        { handle: "t", role: "generic", label: "", value: "kept", destructive: false },
      ],
    });
    expect(await adapter.click("ok")).toEqual({ ok: false, error: undefined });
    expect(await adapter.rectFor!("ok")).toBeNull();
    expect(await adapter.read!()).toEqual({ title: "", headings: [], text: "" });
  });
});

describe("domNavigationCallScript", () => {
  it("builds an expression that calls the injected global with JSON-encoded args", () => {
    const seen: unknown[] = [];
    const g = { [DOM_NAVIGATION_GLOBAL]: { call: (m: string, a: unknown[]) => (seen.push([m, a]), "r") } };
    const code = domNavigationCallScript("setField", ["q", 'quote " and \u2028 line sep']);
    const result = new Function("globalThis", `return ${code};`)(g);
    expect(result).toBe("r");
    expect(seen).toEqual([["setField", ["q", 'quote " and \u2028 line sep']]]);
  });

  it("throws a recognisable error when the script was not injected into that world", () => {
    const code = domNavigationCallScript("describe", []);
    expect(() => new Function("globalThis", `return ${code};`)({})).toThrow(/not injected/);
  });

  it("refuses a method outside the protocol", () => {
    expect(() => domNavigationCallScript("constructor" as never, [])).toThrow(/Unknown dom-navigation method/);
  });
});
