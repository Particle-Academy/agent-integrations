import { describe, expect, it } from "vitest";
import { MicroMcpServer } from "../../mcp/server";
import { attachInProcess } from "../../mcp/transports/in-process";
import { MemoryHumanPlusEventStore } from "../../human-plus/events";
import { registerTuiBridge } from "../tui";

describe("TUI bridge", () => {
  it("reads stable surfaces, invokes actions, and pushes the durable event", async () => {
    let value = "old";
    const registry = { list: () => [surface], get: (id: string) => id === "prompt" ? surface : undefined };
    const surface = { id: "prompt", kind: "input", read: () => ({ value }), commands: [{ name: "set", invoke: (input: Record<string, unknown> = {}) => { value = String(input.value); } }] };
    const store = new MemoryHumanPlusEventStore(); const server = new MicroMcpServer({ info: { name: "test", version: "1" } });
    registerTuiBridge(server, { registry, eventStore: store, appId: "test" }); const transport = attachInProcess(server); const messages: any[] = []; transport.onServerMessage((message) => messages.push(message));
    await transport.deliver({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "human_plus_events_subscribe", arguments: { consumerId: "agent" } } });
    await transport.deliver({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tui_action_invoke", arguments: { surfaceId: "prompt", command: "set", input: { value: "new" } } } });
    expect(value).toBe("new"); const pushed = messages.find((x) => x.method === "notifications/human_plus/event"); expect(pushed.params.type).toBe("action.executed");
    const pulled = await store.list({ consumerId: "agent" }); expect(pulled.events[0]?.id).toBe(pushed.params.id);
  });

  it("stages confirmation-policy actions", async () => {
    let calls = 0; const command = { name: "delete", policy: "confirm" as const, invoke: () => calls++ }; const surface = { id: "row", kind: "button", read: () => ({}), commands: [command] };
    const server = new MicroMcpServer({ info: { name: "test", version: "1" } }); const bridge = registerTuiBridge(server, { registry: { list: () => [surface], get: () => surface }, eventStore: new MemoryHumanPlusEventStore(), appId: "test" });
    await server.callTool("tui_action_invoke", { surfaceId: "row", command: "delete" }); expect(calls).toBe(0); const pending = bridge.pending()[0]!;
    await server.callTool("tui_action_confirm", { id: pending.id }); expect(calls).toBe(1);
  });
});
