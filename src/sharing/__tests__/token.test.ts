import { describe, it, expect } from "vitest";
import { buildShareUrl } from "../token";

describe("buildShareUrl (H4a — token in fragment)", () => {
  it("puts session+token in the URL fragment, never the query string", () => {
    const url = buildShareUrl({ id: "abc", token: "secret123", display: "secret12" }, "https://x.test/page");
    const parsed = new URL(url);

    // Nothing sensitive in the query (which leaks via logs / Referer).
    expect(parsed.search).toBe("");
    expect(url).not.toContain("?token=");
    expect(url).not.toContain("?session=");

    // Everything is carried in the fragment (never sent to the server).
    const frag = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    expect(frag.get("session")).toBe("abc");
    expect(frag.get("token")).toBe("secret123");
  });
});
