import { describe, expect, it } from "vitest";
import { MicroMcpServer } from "../../mcp/server";
import { BridgeContributions } from "../bridge-contributions";

/**
 * "Site tools always; page tools while mounted" — issue #7, steps 2–3.
 *
 * `useCoBrowseSession` already accepted an `extraBridges?: (server) => void`
 * hook and called it. What it could not express is the DECIDED design, because
 * that callback is invoked exactly once, while the server is being built:
 *
 *   - a page that mounts LATER never gets a chance to contribute at all;
 *   - a page that unmounts cannot withdraw, so the agent keeps a tool aimed at
 *     a surface that is gone, and finds out by calling it.
 *
 * Both failures are silent — the agent simply never sees those tools, or sees
 * ones that no longer work. That is why this is a registry re-applied around the
 * server's lifetime rather than a callback captured at construction.
 */

function toolNames(server: MicroMcpServer): string[] {
  return server.listTools().map((t) => t.name).sort();
}

function contributes(name: string) {
  return (server: MicroMcpServer) =>
    server.registerTool({ name, inputSchema: { type: "object" } }, async () => ({ content: [] }));
}

describe("BridgeContributions", () => {
  it("applies a contribution registered BEFORE a server exists", () => {
    // The ordering bug: the page mounted first, so its one chance had already
    // passed and it contributed nothing, with no error anywhere.
    const contributions = new BridgeContributions();
    contributions.add(contributes("artboard_focus"));

    const server = new MicroMcpServer({ info: { name: "t", version: "1" } });
    contributions.bind(server);

    expect(toolNames(server)).toEqual(["artboard_focus"]);
  });

  it("applies a contribution registered while a server is already live", () => {
    const contributions = new BridgeContributions();
    const server = new MicroMcpServer({ info: { name: "t", version: "1" } });
    contributions.bind(server);

    contributions.add(contributes("chart_set"));

    expect(toolNames(server)).toEqual(["chart_set"]);
  });

  it("withdraws that page's tools when its contribution is disposed", () => {
    const contributions = new BridgeContributions();
    const server = new MicroMcpServer({ info: { name: "t", version: "1" } });
    contributions.bind(server);

    contributions.add(contributes("site_tool"));
    const dispose = contributions.add(contributes("page_tool"));

    expect(toolNames(server)).toEqual(["page_tool", "site_tool"]);

    dispose();

    // The site tool is untouched — that is the whole point of the split.
    expect(toolNames(server)).toEqual(["site_tool"]);
  });

  it("does not re-apply a disposed contribution on the next bind", () => {
    const contributions = new BridgeContributions();
    const first = new MicroMcpServer({ info: { name: "t", version: "1" } });
    contributions.bind(first);
    const dispose = contributions.add(contributes("page_tool"));
    dispose();

    contributions.unbind();
    const second = new MicroMcpServer({ info: { name: "t", version: "1" } });
    contributions.bind(second);

    expect(toolNames(second)).toEqual([]);
  });

  it("re-applies a still-mounted contribution to a replacement server", () => {
    // A session can be torn down and started again under a page that never
    // unmounted; its tools must come back rather than silently vanish.
    const contributions = new BridgeContributions();
    contributions.add(contributes("page_tool"));

    const first = new MicroMcpServer({ info: { name: "t", version: "1" } });
    contributions.bind(first);
    contributions.unbind();

    const second = new MicroMcpServer({ info: { name: "t", version: "1" } });
    contributions.bind(second);

    expect(toolNames(second)).toEqual(["page_tool"]);
  });

  it("unbind withdraws from the old server", () => {
    const contributions = new BridgeContributions();
    const server = new MicroMcpServer({ info: { name: "t", version: "1" } });
    contributions.bind(server);
    contributions.add(contributes("page_tool"));

    contributions.unbind();

    expect(toolNames(server)).toEqual([]);
  });

  it("tolerates a contribution that returns nothing", () => {
    // `extraBridges` was typed `(server) => void`, so existing callers return
    // nothing. They must keep working — they simply cannot be withdrawn.
    const contributions = new BridgeContributions();
    const server = new MicroMcpServer({ info: { name: "t", version: "1" } });
    contributions.bind(server);

    const dispose = contributions.add((s) => {
      s.registerTool({ name: "legacy", inputSchema: { type: "object" } }, async () => ({ content: [] }));
    });

    expect(() => dispose()).not.toThrow();
    expect(toolNames(server)).toEqual(["legacy"]);
  });

  it("is idempotent on double dispose", () => {
    const contributions = new BridgeContributions();
    const server = new MicroMcpServer({ info: { name: "t", version: "1" } });
    contributions.bind(server);
    const dispose = contributions.add(contributes("page_tool"));

    dispose();
    expect(() => dispose()).not.toThrow();
    expect(toolNames(server)).toEqual([]);
  });
});
