import { describe, it, expect } from "vitest";
import {
  buildCursorDeeplink,
  buildVscodeDeeplink,
  buildManualConfig,
  buildManualConfigSnippet,
  slugifyServerName,
  encodeBase64Json,
  connectorHref,
  CONNECTOR_TARGETS,
} from "../targets";

const server = { name: "Decksmith", url: "https://decksmith.dev/mcp" };

describe("buildCursorDeeplink", () => {
  it("uses the HTTP {url} base64 payload, raw (not percent-encoded)", () => {
    const href = buildCursorDeeplink(server);
    expect(href).toMatch(
      /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=Decksmith&config=/,
    );
    const config = href.split("config=")[1];
    // raw base64 → decodes straight back to {"url": ...}, no type/transport key
    const decoded = JSON.parse(atob(config));
    expect(decoded).toEqual({ url: server.url });
    expect(decoded).not.toHaveProperty("type");
    expect(decoded).not.toHaveProperty("transport");
  });

  it("url-encodes the name", () => {
    const href = buildCursorDeeplink({ ...server, name: "My App" });
    expect(href).toContain("name=My%20App");
  });
});

describe("buildVscodeDeeplink", () => {
  it("uses URL-encoded JSON (not base64) with {name,url}", () => {
    const href = buildVscodeDeeplink(server);
    expect(href).toMatch(/^vscode:\/\/mcp\/install\?/);
    const payload = href.split("install?")[1];
    expect(JSON.parse(decodeURIComponent(payload))).toEqual({
      name: server.name,
      url: server.url,
    });
  });

  it("targets the insiders scheme when asked", () => {
    expect(buildVscodeDeeplink(server, { insiders: true })).toMatch(
      /^vscode-insiders:\/\/mcp\/install\?/,
    );
  });
});

describe("buildManualConfig", () => {
  it("wraps the remote URL with npx -y mcp-remote under a slugified key", () => {
    const cfg = buildManualConfig({ ...server, name: "Decksmith" });
    expect(cfg).toEqual({
      mcpServers: {
        decksmith: {
          command: "npx",
          args: ["-y", "mcp-remote", server.url],
        },
      },
    });
  });

  it("snippet is pretty-printed JSON", () => {
    expect(buildManualConfigSnippet(server)).toBe(
      JSON.stringify(buildManualConfig(server), null, 2),
    );
  });
});

describe("slugifyServerName", () => {
  it("lowercases + dashes non-alphanumerics, trims edges", () => {
    expect(slugifyServerName("My Fancy App!")).toBe("my-fancy-app");
    expect(slugifyServerName("  -- ")).toBe("mcp-server");
  });
});

describe("encodeBase64Json", () => {
  it("round-trips through atob", () => {
    const value = { url: "https://x.test/mcp", n: 1 };
    expect(JSON.parse(atob(encodeBase64Json(value)))).toEqual(value);
  });
});

describe("connectorHref", () => {
  it("returns deeplinks only for cursor/vscode", () => {
    expect(connectorHref("cursor", server)).toContain("cursor://");
    expect(connectorHref("vscode", server)).toContain("vscode://");
    expect(connectorHref("claude-web", server)).toBeNull();
    expect(connectorHref("claude-desktop", server)).toBeNull();
    expect(connectorHref("manual", server)).toBeNull();
  });
});

describe("CONNECTOR_TARGETS", () => {
  it("maps every client to its mechanism", () => {
    expect(CONNECTOR_TARGETS["claude-web"].mechanism).toBe("copy-open");
    expect(CONNECTOR_TARGETS["claude-desktop"].mechanism).toBe("download");
    expect(CONNECTOR_TARGETS.cursor.mechanism).toBe("deeplink");
    expect(CONNECTOR_TARGETS.vscode.mechanism).toBe("deeplink");
    expect(CONNECTOR_TARGETS.manual.mechanism).toBe("snippet");
  });
});
