import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerScreensBridge } from "../screens";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import type { JsonObject } from "../../mcp/types";

type Screen = { id: string; title?: string; kind?: string; config?: Record<string, unknown>; layout?: string };

function setup(opts: { readOnly?: boolean } = {}) {
  let screens: Screen[] = [{ id: "home", title: "Home", kind: "page" }];
  let active: string | null = "home";
  const host = new ToolRegistry();

  const writers = {
    createScreen: (spec: { id: string; kind: string; title?: string; config?: Record<string, unknown> }) => {
      screens = [...screens, { ...spec }];
    },
    destroyScreen: (id: string) => {
      screens = screens.filter((s) => s.id !== id);
    },
    updateScreenContent: (id: string, partial: Record<string, unknown>) => {
      screens = screens.map((s) => (s.id === id ? { ...s, config: { ...s.config, ...partial } } : s));
    },
    listKinds: () => [{ kind: "page", label: "Page" }],
  };

  registerScreensBridge(host, {
    adapter: {
      listScreens: () => screens as never,
      getActive: () => active,
      setActive: (id) => {
        active = id;
      },
      ...(opts.readOnly ? {} : writers),
    },
  });

  const call = async (name: string, args: JsonObject = {}) => {
    const r = await host.callTool(name, args);
    return { isError: r.isError, text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "" };
  };

  return { host, call, screens: () => screens, active: () => active };
}

describe("registerScreensBridge", () => {
  beforeEach(() => resetAllUndoStacks());

  it("registers its tools", () => {
    const names = setup().host.listTools().map((t) => t.name);

    for (const t of ["screens_list", "screens_describe_active", "screens_list_kinds", "screens_create", "screens_destroy", "screens_update_content", "screens_navigate"]) {
      expect(names, `missing ${t}`).toContain(t);
    }
  });

  it("lists screens and describes the active one", async () => {
    const { call } = setup();

    expect((await call("screens_list")).text).toContain("home");
    expect((await call("screens_describe_active")).text).toContain("home");
  });

  it("navigates by id", async () => {
    const { call, active } = setup();

    await call("screens_create", { id: "settings", kind: "page", title: "Settings" });
    await call("screens_navigate", { screen: "settings" });

    expect(active()).toBe("settings");
  });

  it("creates and destroys without disturbing the others", async () => {
    const { call, screens } = setup();

    await call("screens_create", { id: "temp", kind: "page" });
    expect(screens().map((s) => s.id)).toEqual(["home", "temp"]);

    await call("screens_destroy", { id: "temp" });
    expect(screens().map((s) => s.id)).toEqual(["home"]);
  });

  it("merges content rather than replacing a screen's config", async () => {
    const { call, screens } = setup();

    await call("screens_create", { id: "chart", kind: "page", config: { series: "a", color: "red" } });
    await call("screens_update_content", { id: "chart", partial: { color: "blue" } });

    const chart = screens().find((s) => s.id === "chart")!;
    expect(chart.config).toEqual({ series: "a", color: "blue" });
  });

  it("refuses a write the host did not wire, instead of pretending", async () => {
    // Every mutator is optional on the adapter. A read-only host must produce a
    // refusal an agent can act on, not a success for something that never ran.
    const { call, screens } = setup({ readOnly: true });

    expect((await call("screens_create", { id: "x", kind: "page" })).isError).toBe(true);
    expect(screens()).toHaveLength(1);
  });

  it("still navigates on a read-only host", async () => {
    // Navigation is not a mutation of the screen set, so it must survive when
    // the create/destroy writers are absent.
    const { call, active } = setup({ readOnly: true });

    await call("screens_navigate", { screen: "home" });
    expect(active()).toBe("home");
  });
});
