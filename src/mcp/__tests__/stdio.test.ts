// @vitest-environment node
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { MicroMcpServer } from "../server";
import { attachStdio } from "../stdio";
import type { JsonRpcMessage } from "../types";

/**
 * The stdio transport — newline-delimited JSON-RPC, the framing every MCP
 * client uses when it launches a server as a subprocess.
 *
 * These drive real Node streams, not a mock of one: the defects this transport
 * can have are all about how bytes arrive (split frames, several frames in one
 * chunk, a multi-byte character cut in half, input ending with a reply still
 * owed), and a mock that hands over tidy whole lines cannot produce any of them.
 */

function harness(options: { onError?: (e: Error) => void } = {}) {
  const server = new MicroMcpServer({ info: { name: "stdio-test", version: "1" } });
  server.registerTool(
    { name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    async (args) => ({ content: [{ type: "text", text: String(args.text) }] }),
  );

  const input = new PassThrough();
  const output = new PassThrough();
  const errors: Error[] = [];
  let closed = 0;

  // Everything written to stdout, split exactly the way a client splits it.
  let written = "";
  output.on("data", (chunk: Buffer) => {
    written += chunk.toString("utf8");
  });
  const frames = (): JsonRpcMessage[] =>
    written
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as JsonRpcMessage);

  const transport = attachStdio(server, {
    input,
    output,
    onError: options.onError ?? ((e) => errors.push(e)),
    onClose: () => {
      closed += 1;
    },
  });

  // Wait for the server to have replied to `id`, rather than for a fixed time.
  const replyTo = async (id: number): Promise<JsonRpcMessage> => {
    for (let i = 0; i < 200; i++) {
      const hit = frames().find((f) => (f as { id?: unknown }).id === id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error(`no reply to id ${id}; stdout was: ${JSON.stringify(written)}`);
  };

  return { server, input, output, transport, errors, frames, replyTo, written: () => written, closed: () => closed };
}

const frame = (id: number, method: string, params?: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

describe("framing", () => {
  it("answers one request per line, one JSON object per output line", async () => {
    const h = harness();
    h.input.write(frame(1, "ping") + "\n");

    expect(await h.replyTo(1)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(h.written()).toBe(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\n");
  });

  it("reassembles a frame split across chunks", async () => {
    const h = harness();
    const line = frame(2, "tools/call", { name: "echo", arguments: { text: "split" } }) + "\n";
    h.input.write(line.slice(0, 17));
    await new Promise((r) => setTimeout(r, 5));
    h.input.write(line.slice(17));

    expect(await h.replyTo(2)).toMatchObject({ result: { content: [{ type: "text", text: "split" }] } });
  });

  it("separates several frames arriving in one chunk, CRLF included", async () => {
    const h = harness();
    h.input.write(`${frame(3, "ping")}\r\n${frame(4, "ping")}\n\n${frame(5, "ping")}\n`);

    await Promise.all([h.replyTo(3), h.replyTo(4), h.replyTo(5)]);
    expect(h.errors, "a blank line or a CR was treated as a malformed frame").toEqual([]);
  });

  it("keeps a multi-byte character intact when a chunk boundary cuts through it", async () => {
    // Decoding each chunk on its own turns half of "é" into U+FFFD, and the
    // reply then carries a different string from the one the client sent.
    const h = harness();
    const bytes = Buffer.from(frame(6, "tools/call", { name: "echo", arguments: { text: "café ☕" } }) + "\n", "utf8");
    const cut = bytes.indexOf(Buffer.from("é", "utf8")) + 1;
    h.input.write(bytes.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 5));
    h.input.write(bytes.subarray(cut));

    expect(await h.replyTo(6)).toMatchObject({ result: { content: [{ text: "café ☕" }] } });
  });

  it("writes a reply containing newlines as ONE line", async () => {
    // A raw newline inside a frame would end it early on the client side.
    const h = harness();
    h.input.write(frame(7, "tools/call", { name: "echo", arguments: { text: "a\nb\r\nc" } }) + "\n");

    expect(await h.replyTo(7)).toMatchObject({ result: { content: [{ text: "a\nb\r\nc" }] } });
    expect(h.written().split("\n").filter(Boolean)).toHaveLength(1);
  });
});

describe("a bad line costs that line, not the session", () => {
  it("reports a line that is not JSON and keeps serving", async () => {
    const h = harness();
    h.input.write("this is not json\n" + frame(8, "ping") + "\n");

    await h.replyTo(8);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.message).toMatch(/not JSON/i);
    // Nothing was written for the bad line: stdout carries protocol frames only.
    expect(h.frames()).toHaveLength(1);
  });

  it.each([
    ["a number", "42"],
    ["null", "null"],
    ["a string", '"ping"'],
    ["a batch", `[${frame(99, "ping")}]`],
  ])("reports %s, which is JSON but not a JSON-RPC message", async (_label, line) => {
    const h = harness();
    h.input.write(`${line}\n${frame(9, "ping")}\n`);

    await h.replyTo(9);
    expect(h.errors).toHaveLength(1);
    expect(h.frames().some((f) => (f as { id?: unknown }).id === 99), "a batch member was served").toBe(false);
  });

  it("survives an onError that throws", async () => {
    const h = harness({
      onError: () => {
        throw new Error("host handler blew up");
      },
    });
    h.input.write("garbage\n" + frame(10, "ping") + "\n");

    await h.replyTo(10);
  });
});

describe("lifecycle", () => {
  it("still delivers a reply owed when input ends, then closes", async () => {
    // `printf '<request>\n' | server` ends stdin immediately after the request.
    // Closing on end without waiting drops the one reply the client wanted.
    const h = harness();
    h.input.end(frame(11, "tools/call", { name: "echo", arguments: { text: "last words" } }) + "\n");

    expect(await h.replyTo(11)).toMatchObject({ result: { content: [{ text: "last words" }] } });
    for (let i = 0; i < 100 && h.closed() === 0; i++) await new Promise((r) => setTimeout(r, 2));
    expect(h.closed()).toBe(1);
  });

  it("serves a final frame that has no trailing newline", async () => {
    const h = harness();
    h.input.end(frame(12, "ping"));

    await h.replyTo(12);
  });

  it("stops receiving from the server once input has ended", async () => {
    const h = harness();
    h.input.end();
    for (let i = 0; i < 100 && h.closed() === 0; i++) await new Promise((r) => setTimeout(r, 2));

    h.server.notify({ jsonrpc: "2.0", method: "notifications/message" });
    expect(h.written()).toBe("");
  });

  it("ignores input after close(), and close() is idempotent", async () => {
    const h = harness();
    h.server.detach(h.transport);
    h.transport.close();
    h.input.write(frame(13, "ping") + "\n");
    await new Promise((r) => setTimeout(r, 20));

    expect(h.written()).toBe("");
    expect(h.closed()).toBe(1);
  });

  it("hands a client that attaches in the same tick as registration no stray frame", async () => {
    // The whole reason a stdio server can be built as `attachStdio(createServer())`:
    // the first thing on stdout must be the reply to the client's initialize.
    const server = new MicroMcpServer({ info: { name: "t", version: "1" } });
    server.registerTool({ name: "a", inputSchema: { type: "object" } }, () => ({ content: [] }));
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (c: Buffer) => (written += c.toString("utf8")));
    attachStdio(server, { input, output, onError: () => {} });

    await new Promise((r) => setTimeout(r, 10));
    expect(written).toBe("");
  });
});
