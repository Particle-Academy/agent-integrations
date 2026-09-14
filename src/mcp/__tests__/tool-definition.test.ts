import { expect, it } from "vitest";
import { MicroMcpServer } from "../server";
import { attachInProcess } from "../transports/in-process";
import type { JsonRpcMessage, ToolDefinition } from "../types";

/**
 * `tools/list` reports a definition exactly as it was registered.
 *
 * `ToolDefinition` now names the spec's optional fields (`execution`,
 * `annotations`, `outputSchema`, `_meta`, and a `$schema` on the input schema).
 * Typing them is only half of it — this pins that they reach the client,
 * because a server that accepted them and then dropped them on the wire would
 * typecheck perfectly.
 */
it("passes every spec field of a tool definition through to tools/list", async () => {
  const definition: ToolDefinition = {
    name: "run_workflow",
    title: "Run Workflow",
    description: "Runs it.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { workflow_id: { type: "string" } },
      required: ["workflow_id"],
    },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    execution: { taskSupport: "forbidden" },
    _meta: { "example.com/owner": "flow" },
  };

  const server = new MicroMcpServer({ info: { name: "t", version: "1" } });
  server.registerTool(definition, () => ({ content: [] }));

  const transport = attachInProcess(server);
  const frames: JsonRpcMessage[] = [];
  transport.onServerMessage((f) => frames.push(f));
  await transport.deliver({ jsonrpc: "2.0", id: 1, method: "tools/list" });

  const reply = frames.find((f) => (f as { id?: unknown }).id === 1) as unknown as { result: { tools: unknown[] } };
  // Through JSON, as a client receives it.
  expect(JSON.parse(JSON.stringify(reply.result.tools))).toEqual([definition]);
});
