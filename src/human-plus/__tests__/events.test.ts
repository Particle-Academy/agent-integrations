import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryHumanPlusEventStore } from "../events";
import { FileHumanPlusEventStore } from "../file-store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const event = (surfaceId = "prompt") => ({ appId: "dogfood", surfaceId, type: "message.created", payload: { text: "hi" }, actor: { kind: "human" as const, id: "user" }, priority: "normal" as const });

describe("Human+ event stores", () => {
  it("provides ordered per-consumer acknowledgement without hiding events globally", async () => {
    const store = new MemoryHumanPlusEventStore(); const first = await store.append(event()); const second = await store.append(event("tools"));
    await store.acknowledge("agent-a", [first.id], "handled");
    expect((await store.list({ consumerId: "agent-a", unacknowledgedOnly: true })).events.map((x) => x.id)).toEqual([second.id]);
    expect((await store.list({ consumerId: "agent-b", unacknowledgedOnly: true })).events.map((x) => x.id)).toEqual([first.id, second.id]);
  });

  it("recovers events and acknowledgements after file-store restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "fancy-human-plus-")); roots.push(root); const path = join(root, "events.jsonl");
    const first = new FileHumanPlusEventStore(path); const stored = await first.append(event()); await first.acknowledge("agent", [stored.id], "handled");
    const reopened = new FileHumanPlusEventStore(path);
    expect((await reopened.list({ consumerId: "agent", unacknowledgedOnly: true })).events).toEqual([]);
    expect((await reopened.list({ consumerId: "other" })).events[0]?.id).toBe(stored.id);
  });
});
