import { describe, expect, it } from "vitest";
import { MicroMcpServer, rpcError } from "../server";
import { attachInProcess } from "../transports/in-process";
import { JSONRPC_INVALID_PARAMS, type JsonRpcMessage } from "../types";

/**
 * How `tools/call` reports failure, per MCP 2025-11-25 (and 2025-06-18).
 *
 * - An unknown tool is a PROTOCOL error, and the spec's example code for it is
 *   -32602 (invalid params), not -32601: the method `tools/call` exists, the
 *   `name` argument is what is wrong.
 * - A tool that runs and fails is a TOOL EXECUTION error: a normal result with
 *   `isError: true`, so the model sees the message and can correct itself. A
 *   protocol error is something clients may never show the model at all.
 */

type Frame = { id?: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } };

async function call(server: MicroMcpServer, params: Record<string, unknown>): Promise<Frame> {
  const transport = attachInProcess(server);
  const frames: JsonRpcMessage[] = [];
  transport.onServerMessage((frame) => frames.push(frame));
  await transport.deliver({ jsonrpc: "2.0", id: 7, method: "tools/call", params: params as never });
  const reply = frames.find((f) => (f as { id?: unknown }).id === 7) as Frame | undefined;
  expect(reply, "tools/call produced no reply").toBeDefined();
  return reply!;
}

const make = () => new MicroMcpServer({ info: { name: "t", version: "1" } });

describe("an unknown tool", () => {
  it("is a protocol error with code -32602", async () => {
    const frame = await call(make(), { name: "never_existed", arguments: {} });

    expect(frame.result).toBeUndefined();
    expect(frame.error?.code).toBe(-32602);
    expect(frame.error?.message).toContain("Unknown tool");
  });

  it("is -32602 for a withdrawn tool too, and keeps the withdrawal message", async () => {
    const server = make();
    server.registerTool({ name: "artboard_focus", inputSchema: { type: "object" } }, async () => ({ content: [] }))();

    const frame = await call(server, { name: "artboard_focus", arguments: {} });

    expect(frame.error?.code).toBe(-32602);
    expect(frame.error?.message).toMatch(/withdrawn/);
  });

  it("is -32602 when `name` is missing", async () => {
    expect((await call(make(), { arguments: {} })).error?.code).toBe(JSONRPC_INVALID_PARAMS);
  });
});

describe("a tool handler that throws", () => {
  it("returns a result with isError: true, not a protocol error", async () => {
    const server = make();
    server.registerTool({ name: "explode", inputSchema: { type: "object" } }, async () => {
      throw new Error("the widget is not mounted");
    });

    const frame = await call(server, { name: "explode", arguments: {} });

    expect(frame.error).toBeUndefined();
    expect(frame.result?.isError).toBe(true);
    expect(frame.result?.content).toEqual([{ type: "text", text: "the widget is not mounted" }]);
  });

  it("does the same for a synchronous throw", async () => {
    const server = make();
    server.registerTool({ name: "explode", inputSchema: { type: "object" } }, (() => {
      throw new Error("sync failure");
    }) as never);

    const frame = await call(server, { name: "explode", arguments: {} });

    expect(frame.error).toBeUndefined();
    expect(frame.result).toMatchObject({ isError: true, content: [{ type: "text", text: "sync failure" }] });
  });

  it("does the same when the handler throws an rpcError-shaped value", async () => {
    // Input validation inside a handler is a tool execution error since
    // 2025-11-25, so the model gets the message and can retry.
    const server = make();
    server.registerTool({ name: "strict", inputSchema: { type: "object" } }, async () => {
      throw rpcError(JSONRPC_INVALID_PARAMS, "x must be a number");
    });

    const frame = await call(server, { name: "strict", arguments: {} });

    expect(frame.error).toBeUndefined();
    expect(frame.result).toMatchObject({ isError: true, content: [{ type: "text", text: "x must be a number" }] });
  });

  it("does the same for a thrown non-Error value", async () => {
    const server = make();
    server.registerTool({ name: "explode", inputSchema: { type: "object" } }, async () => {
      throw "plain string";
    });

    const frame = await call(server, { name: "explode", arguments: {} });

    expect(frame.result).toMatchObject({ isError: true, content: [{ type: "text", text: "plain string" }] });
  });

  it("leaves a handler's own isError result untouched", async () => {
    const server = make();
    const own = { content: [{ type: "text" as const, text: "nope" }], isError: true };
    server.registerTool({ name: "refuse", inputSchema: { type: "object" } }, async () => own);

    expect((await call(server, { name: "refuse", arguments: {} })).result).toEqual(own);
  });
});
