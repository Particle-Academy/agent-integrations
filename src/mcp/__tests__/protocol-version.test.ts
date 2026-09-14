import { describe, expect, it } from "vitest";
import { MicroMcpServer } from "../server";
import { attachInProcess } from "../transports/in-process";
import { MCP_PROTOCOL_VERSION, type JsonRpcMessage } from "../types";

/**
 * Protocol revision negotiation.
 *
 * The spec's rule for `initialize` is short: if the server supports the version
 * the client asked for it MUST answer with that version, otherwise it answers
 * with one it does support and the client decides whether to stay.
 *
 * This server used to answer one constant whatever was asked. That is honest
 * for a server that speaks exactly one revision, and it stays the default. It
 * is wrong for a server that speaks several: a client asking for 2024-11-05 was
 * told 2025-06-18 and disconnected from a server that could have served it.
 * `fancy-flow-mcp-js` is the case that forced this — its PHP twin negotiates,
 * and a twin that cannot is not one.
 */

async function initialize(server: MicroMcpServer, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const transport = attachInProcess(server);
  const frames: JsonRpcMessage[] = [];
  transport.onServerMessage((frame) => frames.push(frame));

  await transport.deliver({ jsonrpc: "2.0", id: 1, method: "initialize", params: params as never });

  const reply = frames.find((f) => (f as { id?: unknown }).id === 1) as { result?: Record<string, unknown> } | undefined;
  expect(reply?.result, "initialize produced no result").toBeDefined();
  return reply!.result!;
}

describe("a server that names no versions keeps answering the one it always did", () => {
  it.each(["2025-06-18", "2025-11-25", "2024-11-05", "not-a-version"])("asked for %s", async (asked) => {
    const server = new MicroMcpServer({ info: { name: "t", version: "1" } });

    expect((await initialize(server, { protocolVersion: asked })).protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });
});

describe("a server that names the versions it speaks negotiates", () => {
  const versions = ["2025-11-25", "2025-06-18", "2024-11-05"] as const;
  const make = () => new MicroMcpServer({ info: { name: "t", version: "1" }, protocolVersions: versions });

  it.each(versions)("echoes %s, because it was asked for and is spoken", async (asked) => {
    expect((await initialize(make(), { protocolVersion: asked })).protocolVersion).toBe(asked);
  });

  it("answers its NEWEST version when asked for one it does not speak", async () => {
    // The client then decides whether it can live with that — the spec's
    // answer, and the only one that does not strand a newer client.
    expect((await initialize(make(), { protocolVersion: "2026-07-28" })).protocolVersion).toBe("2025-11-25");
  });

  it("answers its newest version when the client names none", async () => {
    expect((await initialize(make(), {})).protocolVersion).toBe("2025-11-25");
  });

  it("does not echo a version that is merely a prefix or case variant of a spoken one", async () => {
    expect((await initialize(make(), { protocolVersion: "2025-11" })).protocolVersion).toBe("2025-11-25");
    expect((await initialize(make(), { protocolVersion: 20251125 })).protocolVersion).toBe("2025-11-25");
  });
});

it("refuses to be built speaking no version at all", () => {
  // An empty list has no answer to give a client. Failing at construction puts
  // the error next to the mistake, instead of in a handshake nobody is watching.
  expect(() => new MicroMcpServer({ info: { name: "t", version: "1" }, protocolVersions: [] })).toThrow(/protocol/i);
});
