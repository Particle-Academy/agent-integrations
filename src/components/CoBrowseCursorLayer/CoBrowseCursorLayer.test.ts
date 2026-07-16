import { describe, expect, it } from "vitest";
import { fluidGlideDuration, visibleCursorPoint } from "./CoBrowseCursorLayer";

describe("CoBrowseCursorLayer motion", () => {
  it("keeps off-screen targets represented inside the visible viewport", () => {
    expect(visibleCursorPoint({ x: 200, y: -600, width: 100, height: 40 }, { width: 1280, height: 720 })).toEqual({
      x: 250,
      y: 24,
    });
    expect(visibleCursorPoint({ x: 1400, y: 800, width: 100, height: 40 }, { width: 1280, height: 720 })).toEqual({
      x: 1256,
      y: 696,
    });
  });

  it("scales Fluid movement with distance without teleporting or dragging", () => {
    expect(fluidGlideDuration(null, { x: 100, y: 100 })).toBe(0);
    expect(fluidGlideDuration({ x: 0, y: 0 }, { x: 20, y: 0 })).toBe(240);
    expect(fluidGlideDuration({ x: 0, y: 0 }, { x: 525, y: 0 })).toBe(500);
    expect(fluidGlideDuration({ x: 0, y: 0 }, { x: 2_000, y: 0 })).toBe(1_200);
  });
});
