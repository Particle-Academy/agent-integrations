import { describe, expect, it } from "vitest";
import { MicroMcpServer, type Transport } from "../server";
import type { JsonRpcMessage } from "../types";

/**
 * Who hears `notifications/tools/list_changed`.
 *
 * The notification means "the list you have is stale". A transport attached
 * AFTER the change never had the old list, so telling it the list changed is
 * noise — and on a stdio server it is worse than noise: the host builds the
 * server, attaches stdin/stdout in the same tick, and the first frame the client
 * ever receives is an unsolicited notification that arrives before it has sent
 * `initialize`.
 *
 * Changes are still coalesced into one notification per tick, and a transport
 * attached between two changes in one tick still hears about the second one.
 */

const LIST_CHANGED = "notifications/tools/list_changed";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const noop = { name: "x", inputSchema: { type: "object" as const } };

/**
 * A transport that records everything sent to it and has no `close`, so a
 * detached one keeps recording — which is what lets the detach test see a frame
 * that should not have been sent.
 */
function listen(server: MicroMcpServer): { transport: Transport; frames: JsonRpcMessage[] } {
  const frames: JsonRpcMessage[] = [];
  const transport: Transport = { send: (frame) => frames.push(frame) };
  server.attach(transport);
  return { transport, frames };
}

const heard = (frames: JsonRpcMessage[]) => frames.filter((f) => (f as { method?: string }).method === LIST_CHANGED).length;

describe("tools/list_changed reaches the transports that saw the old list", () => {
  it("is NOT sent to a transport attached after the change, even in the same tick", async () => {
    const server = new MicroMcpServer({ info: { name: "t", version: "1" } });
    server.registerTool({ ...noop, name: "a" }, () => ({ content: [] }));
    server.registerTool({ ...noop, name: "b" }, () => ({ content: [] }));

    const late = listen(server);
    await tick();

    expect(heard(late.frames), "a transport that never had the old list was told it changed").toBe(0);
  });

  it("is sent ONCE to a transport attached before several changes in one tick", async () => {
    const server = new MicroMcpServer({ info: { name: "t", version: "1" } });
    const early = listen(server);

    server.registerTool({ ...noop, name: "a" }, () => ({ content: [] }));
    server.registerTool({ ...noop, name: "b" }, () => ({ content: [] }))();
    await tick();

    expect(heard(early.frames)).toBe(1);
  });

  it("is sent to a transport attached between two changes in the same tick", async () => {
    // It saw the list after the first change; the second made that stale.
    const server = new MicroMcpServer({ info: { name: "t", version: "1" } });
    const early = listen(server);
    server.registerTool({ ...noop, name: "a" }, () => ({ content: [] }));

    const between = listen(server);
    server.registerTool({ ...noop, name: "b" }, () => ({ content: [] }));
    await tick();

    expect(heard(early.frames)).toBe(1);
    expect(heard(between.frames)).toBe(1);
  });

  it("is not sent to a transport detached before the notification goes out", async () => {
    const server = new MicroMcpServer({ info: { name: "t", version: "1" } });
    const gone = listen(server);
    server.registerTool({ ...noop, name: "a" }, () => ({ content: [] }));

    server.detach(gone.transport);
    await tick();

    expect(heard(gone.frames)).toBe(0);
  });

  it("still fires for a change made after every transport is attached", async () => {
    const server = new MicroMcpServer({ info: { name: "t", version: "1" } });
    server.registerTool({ ...noop, name: "a" }, () => ({ content: [] }));
    const client = listen(server);
    await tick();

    server.unregisterTool("a");
    await tick();

    expect(heard(client.frames)).toBe(1);
  });
});
