import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerMapBridge } from "../map";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import type { JsonObject } from "../../mcp/types";

/** The STORED shape: a marker holds a nested `position`, not flat lat/lng. */
type Marker = { id: string; position: { lat: number; lng: number }; label?: string };

function setup(opts: { withCamera?: boolean } = {}) {
  let view = { center: { lat: 51.5, lng: -0.12 }, zoom: 10 };
  let markers: Marker[] = [{ id: "m1", position: { lat: 51.5, lng: -0.12 }, label: "Depot" }];
  let selected: string | null = null;
  const fitted: Array<{ points: unknown; padding?: number }> = [];
  const followed: Array<string | null> = [];
  const host = new ToolRegistry();

  registerMapBridge(host, {
    adapter: {
      getView: () => view as never,
      setView: (next) => {
        view = next as typeof view;
      },
      getMarkers: () => markers as never,
      setMarkers: (next) => {
        // One cast at the boundary rather than a chain of them: the fixture
        // models the fields these tests read, not every optional the real
        // MapMarker carries.
        const asFn = next as unknown as (prev: Marker[]) => Marker[];
        markers = typeof next === "function" ? asFn(markers) : (next as unknown as Marker[]);
      },
      getSelected: () => selected,
      setSelected: (id) => {
        selected = id;
      },
      ...(opts.withCamera === false
        ? {}
        : {
            fitBounds: (points, padding) => fitted.push({ points, padding }),
            setFollow: (id) => followed.push(id),
          }),
    },
  });

  const call = async (name: string, args: JsonObject = {}) => {
    const r = await host.callTool(name, args);
    return { isError: r.isError, text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "" };
  };

  return { host, call, view: () => view, markers: () => markers, selected: () => selected, fitted, followed };
}

describe("registerMapBridge", () => {
  beforeEach(() => resetAllUndoStacks());

  it("registers its tools", () => {
    const names = setup().host.listTools().map((t) => t.name);

    for (const t of ["map_get_state", "map_set_view", "map_pan", "map_zoom", "map_add_marker", "map_update_marker", "map_remove_marker", "map_select", "map_fit_bounds"]) {
      expect(names, `missing ${t}`).toContain(t);
    }
  });

  it("adds, updates and removes a marker through the controlled array", async () => {
    const { call, markers } = setup();

    await call("map_add_marker", { id: "m2", lat: 48.85, lng: 2.35, label: "Paris" });
    expect(markers().map((m) => m.id)).toContain("m2");
    // The TOOL takes flat lat/lng; the STORED marker nests them under
    // `position`, which is what fancy-map's <Map> renders. A bridge that passed
    // the args through unchanged would type-check here and draw nothing.
    expect(markers().find((m) => m.id === "m2")?.position).toEqual({ lat: 48.85, lng: 2.35 });

    await call("map_update_marker", { id: "m2", label: "Paris HQ" });
    expect(markers().find((m) => m.id === "m2")?.label).toBe("Paris HQ");

    await call("map_remove_marker", { id: "m2" });
    expect(markers().map((m) => m.id)).not.toContain("m2");
  });

  it("keeps the other markers when one is removed", async () => {
    // The setter takes an updater, so a bridge that rebuilt the array from the
    // one marker it touched would silently drop the rest.
    const { call, markers } = setup();

    await call("map_add_marker", { id: "m2", lat: 1, lng: 1 });
    await call("map_remove_marker", { id: "m2" });

    expect(markers().map((m) => m.id)).toEqual(["m1"]);
  });

  it("selects a marker", async () => {
    const { call, selected } = setup();

    await call("map_select", { id: "m1" });
    expect(selected()).toBe("m1");
  });

  it("routes fit-bounds through the map handle rather than guessing a zoom", async () => {
    // Fitting is geometry the map owns. Computing a center and zoom here would
    // be a second implementation that drifts from what the engine actually does.
    const { call, fitted } = setup();

    await call("map_fit_bounds", { points: [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }], padding: 24 });

    expect(fitted).toHaveLength(1);
    expect(fitted[0]!.padding).toBe(24);
  });

  it("refuses fit-bounds when the host wired no handle", async () => {
    const { call } = setup({ withCamera: false });

    expect((await call("map_fit_bounds", { points: [{ lat: 1, lng: 1 }] })).isError).toBe(true);
  });
});
