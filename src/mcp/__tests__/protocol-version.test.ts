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
 * This server used to answer one constant whatever was asked, unless a host
 * passed `protocolVersions` (`fancy-flow-mcp-js` did, because its PHP twin
 * negotiates). It now negotiates by default, over the revisions it is correct
 * under, and a host's own list still replaces the default outright.
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

describe("a server that names no versions negotiates over the default list", () => {
  // The default used to be ONE revision, 2025-06-18, answered whatever was
  // asked: a 2025-11-25 client was told 2025-06-18 and a 2024-11-05 client was
  // told a revision it could not speak. 2025-03-26 is deliberately absent — it
  // requires servers to accept JSON-RPC batches, and the stdio transport does
  // not.
  const make = () => new MicroMcpServer({ info: { name: "t", version: "1" } });

  it("speaks 2025-11-25, 2025-06-18 and 2024-11-05, newest first", () => {
    expect(make().protocolVersions).toEqual(["2025-11-25", "2025-06-18", "2024-11-05"]);
  });

  it("names 2025-11-25 as MCP_PROTOCOL_VERSION, the newest it speaks", () => {
    expect(MCP_PROTOCOL_VERSION).toBe("2025-11-25");
  });

  it.each(["2025-11-25", "2025-06-18", "2024-11-05"])("echoes %s", async (asked) => {
    expect((await initialize(make(), { protocolVersion: asked })).protocolVersion).toBe(asked);
  });

  it("still answers 2025-06-18 to a 2025-06-18 client, exactly as before", async () => {
    expect((await initialize(make(), { protocolVersion: "2025-06-18" })).protocolVersion).toBe("2025-06-18");
  });

  it.each(["2025-03-26", "2026-07-28", "not-a-version"])("answers 2025-11-25 when asked for %s, which it does not speak", async (asked) => {
    expect((await initialize(make(), { protocolVersion: asked })).protocolVersion).toBe("2025-11-25");
  });

  it("answers 2025-11-25 when the client names no version", async () => {
    expect((await initialize(make(), {})).protocolVersion).toBe("2025-11-25");
  });
});

describe("a host that passes its own list keeps exactly that list", () => {
  it("does not merge the default list into a host's list", async () => {
    const server = new MicroMcpServer({ info: { name: "t", version: "1" }, protocolVersions: ["2025-06-18"] });

    expect(server.protocolVersions).toEqual(["2025-06-18"]);
    // 2025-11-25 is in the default list, but not in this host's.
    expect((await initialize(server, { protocolVersion: "2025-11-25" })).protocolVersion).toBe("2025-06-18");
    expect((await initialize(server, { protocolVersion: "2024-11-05" })).protocolVersion).toBe("2025-06-18");
  });

  it("does not see a later mutation of the array it was given", () => {
    const list = ["2025-06-18", "2024-11-05"];
    const server = new MicroMcpServer({ info: { name: "t", version: "1" }, protocolVersions: list });
    list.unshift("2099-01-01");

    expect(server.protocolVersions).toEqual(["2025-06-18", "2024-11-05"]);
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
