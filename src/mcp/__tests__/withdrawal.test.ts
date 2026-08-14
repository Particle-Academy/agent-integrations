import { describe, expect, it } from "vitest";
import { MicroMcpServer } from "../server";
import { attachInProcess } from "../transports/in-process";

/**
 * Mid-withdrawal calls — issue #7, step 4.
 *
 * "Site tools always; page tools while mounted" makes the tool surface DYNAMIC:
 * a page contributes bridges on mount and retracts them on unmount. Racing an
 * unmount is therefore normal, not exotic — an agent decides to call a tool,
 * the human navigates away, and the call lands after the tool is gone.
 *
 * Before this, a withdrawn tool was indistinguishable from one that never
 * existed: both produced `Unknown tool: x`. That is the least useful thing to
 * say at exactly the moment a human is watching — it reads as "the agent is
 * broken" or "you asked for something imaginary", when the truth is "that
 * surface just closed, and here is what you can do instead".
 */

function callTool(server: MicroMcpServer, name: string): Promise<unknown> {
  const transport = attachInProcess(server);
  return new Promise((resolve) => {
    // Match on the request id: registering/withdrawing a tool also pushes a
    // `notifications/tools/list_changed` frame, so "the first message" is not
    // the response.
    transport.onServerMessage((frame) => {
      if ((frame as { id?: unknown }).id === 1) resolve(frame);
    });
    void transport.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    });
  });
}

function errorMessage(frame: unknown): string {
  return String((frame as { error?: { message?: string } })?.error?.message ?? "");
}

describe("a withdrawn tool explains itself", () => {
  it("says the surface went away, not that the tool never existed", async () => {
    const server = new MicroMcpServer({ info: { name: "t", version: "1" } });
    const dispose = server.registerTool(
      { name: "artboard_focus", inputSchema: { type: "object" } },
      async () => ({ content: [] }),
    );

    dispose();

    const message = errorMessage(await callTool(server, "artboard_focus"));

    expect(message).toContain("artboard_focus");
    expect(message).toMatch(/withdraw|no longer/i);
  });

  it("still says Unknown tool for a name that was never registered", async () => {
    // The distinction is the whole point: one is "you asked for something that
    // does not exist", the other is "it existed a moment ago".
    const server = new MicroMcpServer({ info: { name: "t", version: "1" } });

    const message = errorMessage(await callTool(server, "never_existed"));

    expect(message).toContain("Unknown tool");
    expect(message).not.toMatch(/withdraw/i);
  });

  it("stops reporting withdrawal once the tool is registered again", async () => {
    // A surface that remounts must not keep apologising for a previous unmount.
    const server = new MicroMcpServer({ info: { name: "t", version: "1" } });
    const dispose = server.registerTool(
      { name: "chart_set", inputSchema: { type: "object" } },
      async () => ({ content: [] }),
    );
    dispose();
    server.registerTool({ name: "chart_set", inputSchema: { type: "object" } }, async () => ({ content: [] }));

    const frame = (await callTool(server, "chart_set")) as { result?: unknown; error?: unknown };

    expect(frame.error).toBeUndefined();
    expect(frame.result).toBeDefined();
  });
});
