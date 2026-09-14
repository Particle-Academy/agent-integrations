// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseCorsOrigins } from "../cors";

describe("parseCorsOrigins", () => {
  it("reads `*` as allow-any", () => {
    expect(parseCorsOrigins("*")).toEqual({ kind: "any" });
    expect(parseCorsOrigins(" * ")).toEqual({ kind: "any" });
  });

  it("splits a comma-separated list", () => {
    expect(parseCorsOrigins("https://particle.academy,https://www.particle.academy")).toEqual({
      kind: "list",
      origins: ["https://particle.academy", "https://www.particle.academy"],
    });
  });

  it("accepts an array", () => {
    expect(parseCorsOrigins(["https://a.example", "https://b.example"])).toEqual({
      kind: "list",
      origins: ["https://a.example", "https://b.example"],
    });
  });

  it("normalises each entry to the form a browser sends in Origin", () => {
    // A browser lower-cases the host, drops a default port and never sends a
    // path. An operator writing any of those would otherwise match nothing,
    // silently.
    expect(parseCorsOrigins("HTTPS://Particle.Academy:443/, http://localhost:5173")).toEqual({
      kind: "list",
      origins: ["https://particle.academy", "http://localhost:5173"],
    });
  });

  it("keeps a non-default port", () => {
    expect(parseCorsOrigins("https://a.example:8443")).toEqual({ kind: "list", origins: ["https://a.example:8443"] });
  });

  it("drops duplicates and empty entries", () => {
    expect(parseCorsOrigins("https://a.example,, https://a.example/ ,")).toEqual({
      kind: "list",
      origins: ["https://a.example"],
    });
  });

  it("refuses `*` mixed with named origins", () => {
    expect(() => parseCorsOrigins("*,https://a.example")).toThrow(/\*/);
  });

  it("refuses an empty value rather than guessing a policy", () => {
    expect(() => parseCorsOrigins("")).toThrow(/empty|no origin/i);
    expect(() => parseCorsOrigins(" , ")).toThrow(/empty|no origin/i);
    expect(() => parseCorsOrigins([])).toThrow(/empty|no origin/i);
  });

  it("refuses `null` as an allowed origin", () => {
    // Sandboxed iframes and file:// pages send `Origin: null`.
    expect(() => parseCorsOrigins("null")).toThrow(/null/);
  });

  it("refuses an entry that is not an origin", () => {
    expect(() => parseCorsOrigins("particle.academy")).toThrow(/origin/i);
    expect(() => parseCorsOrigins("https://a.example/app")).toThrow(/path/i);
  });
});
