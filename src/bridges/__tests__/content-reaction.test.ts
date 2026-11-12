import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import type { JsonObject } from "../../mcp/types";
import { onActivity, resetActivityRegistry } from "../../presence";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import {
  registerContentReactionBridge,
  type ContentReactionBridgeAdapter,
  type ContentReactionBridgeOptions,
} from "../content-reaction";

/**
 * The content-reaction bridge: an agent reads and changes the reactions on a
 * piece of content (react-fancy's `ContentReaction`) through the host's own
 * controlled state, never by clicking the picker.
 *
 * Reactions sit on every comment of a page, so several instances share one
 * host: the tools are registered once and select an instance with `content`.
 */

const REACTIONS = [
  { key: "like", emoji: "+", label: "Like" },
  { key: "love", emoji: "<3", label: "Love" },
  { key: "sad", emoji: ":(", label: "Sad" },
];

function makeContent(id: string, overrides: Partial<ContentReactionBridgeAdapter> = {}, initial: string[] = []) {
  const state = { value: [...initial] };
  const adapter: ContentReactionBridgeAdapter = {
    id,
    title: `Comment ${id}`,
    screenId: "thread",
    getValue: () => state.value,
    setValue: vi.fn((next: string[]) => {
      state.value = next;
    }),
    getReactions: () => REACTIONS,
    getCounts: () => ({ like: 3, love: 0 }),
    ...overrides,
  };
  return { adapter, state };
}

async function call(host: ToolRegistry, name: string, args: JsonObject = {}) {
  const r = await host.callTool(name, args);
  return {
    isError: r.isError === true,
    text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "",
    structured: r.structuredContent as any,
  };
}

function mount(host: ToolRegistry, adapter: ContentReactionBridgeAdapter, rest: Partial<ContentReactionBridgeOptions> = {}) {
  return registerContentReactionBridge(host, { adapter, ...rest });
}

const TOOLS = ["reaction_list", "reaction_read", "reaction_toggle", "reaction_set"];

describe("registerContentReactionBridge", () => {
  beforeEach(() => {
    resetAllUndoStacks();
    resetActivityRegistry();
  });

  it("registers the reaction tools plus the shared undo tools", () => {
    const host = new ToolRegistry();
    mount(host, makeContent("c1").adapter);
    const names = host.listTools().map((t) => t.name);
    for (const n of [...TOOLS, "agent_undo"]) expect(names).toContain(n);
  });

  it("reaction_read returns value, counts, available reactions and mode", async () => {
    const host = new ToolRegistry();
    mount(host, makeContent("c1", {}, ["like"]).adapter);
    const r = await call(host, "reaction_read");
    expect(r.isError).toBe(false);
    expect(r.structured).toEqual({
      content: "c1",
      title: "Comment c1",
      mode: "multi",
      value: ["like"],
      counts: { like: 3, love: 0 },
      reactions: REACTIONS,
    });
  });

  it("reaction_read omits counts when the host has none", async () => {
    const host = new ToolRegistry();
    mount(host, makeContent("c1", { getCounts: undefined }).adapter);
    const r = await call(host, "reaction_read");
    expect(r.structured.counts).toBeUndefined();
  });

  describe("reaction_toggle", () => {
    it("multi: turns a reaction on, then off, with meta", async () => {
      const host = new ToolRegistry();
      const { adapter, state } = makeContent("c1", {}, ["sad"]);
      mount(host, adapter);

      const on = await call(host, "reaction_toggle", { key: "like" });
      expect(on.isError).toBe(false);
      expect(on.structured).toMatchObject({ content: "c1", key: "like", on: true, value: ["sad", "like"] });
      expect(state.value).toEqual(["sad", "like"]);
      expect(adapter.setValue).toHaveBeenLastCalledWith(["sad", "like"], { key: "like", on: true });

      const off = await call(host, "reaction_toggle", { key: "like" });
      expect(off.structured).toMatchObject({ on: false, value: ["sad"] });
      expect(state.value).toEqual(["sad"]);
    });

    it("single: choosing one replaces the others; choosing the active one clears it", async () => {
      const host = new ToolRegistry();
      const { adapter, state } = makeContent("c1", { getMode: () => "single" }, ["like"]);
      mount(host, adapter);

      await call(host, "reaction_toggle", { key: "love" });
      expect(state.value).toEqual(["love"]);
      const cleared = await call(host, "reaction_toggle", { key: "love" });
      expect(cleared.structured).toMatchObject({ on: false, value: [] });
      expect(state.value).toEqual([]);
    });

    it("refuses an unknown key and names the available ones", async () => {
      const host = new ToolRegistry();
      const { adapter } = makeContent("c1");
      mount(host, adapter);
      const r = await call(host, "reaction_toggle", { key: "party" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('"party"');
      expect(r.text).toContain("like, love, sad");
      expect(adapter.setValue).not.toHaveBeenCalled();
    });
  });

  describe("reaction_set", () => {
    it("replaces the whole value", async () => {
      const host = new ToolRegistry();
      const { adapter, state } = makeContent("c1", {}, ["sad"]);
      mount(host, adapter);
      const r = await call(host, "reaction_set", { value: ["love", "like"] });
      expect(r.isError).toBe(false);
      expect(state.value).toEqual(["love", "like"]);
      expect(r.structured).toMatchObject({ content: "c1", value: ["love", "like"], previous: ["sad"], changed: true });
    });

    it("drops duplicates", async () => {
      const host = new ToolRegistry();
      const { adapter, state } = makeContent("c1");
      mount(host, adapter);
      await call(host, "reaction_set", { value: ["like", "like"] });
      expect(state.value).toEqual(["like"]);
    });

    it("an empty array clears every reaction", async () => {
      const host = new ToolRegistry();
      const { adapter, state } = makeContent("c1", {}, ["like", "sad"]);
      mount(host, adapter);
      await call(host, "reaction_set", { value: [] });
      expect(state.value).toEqual([]);
    });

    it("refuses unknown keys, non-arrays, and more than one in single mode", async () => {
      const host = new ToolRegistry();
      const { adapter } = makeContent("c1", { getMode: () => "single" });
      mount(host, adapter);
      expect((await call(host, "reaction_set", { value: ["party"] })).isError).toBe(true);
      expect((await call(host, "reaction_set", { value: "like" as never })).isError).toBe(true);
      const two = await call(host, "reaction_set", { value: ["like", "love"] });
      expect(two.isError).toBe(true);
      expect(two.text).toContain("single");
      expect(adapter.setValue).not.toHaveBeenCalled();
    });

    it("setting the current value changes nothing and broadcasts nothing", async () => {
      const host = new ToolRegistry();
      const { adapter } = makeContent("c1", {}, ["like"]);
      mount(host, adapter);
      const seen: unknown[] = [];
      onActivity((e) => {
        seen.push(e);
      });
      const r = await call(host, "reaction_set", { value: ["like"] });
      expect(r.isError).toBe(false);
      expect(r.structured.changed).toBe(false);
      expect(adapter.setValue).not.toHaveBeenCalled();
      expect(seen).toEqual([]);
    });
  });

  describe("activity", () => {
    it("toggle and set broadcast an AgentActivity event targeting the content", async () => {
      const host = new ToolRegistry();
      mount(host, makeContent("c1").adapter, { agent: { id: "helper", name: "Helper" } });
      const events: any[] = [];
      onActivity((e) => {
        events.push(e);
      });

      await call(host, "reaction_toggle", { key: "like" });
      await call(host, "reaction_set", { value: ["love"] });

      expect(events.map((e) => e.action)).toEqual(["reaction_toggle", "reaction_set"]);
      for (const e of events) {
        expect(e.agentId).toBe("helper");
        expect(e.target).toMatchObject({ kind: "reaction", elementId: "c1", screenId: "thread" });
      }
      expect(events[0].meta).toMatchObject({ key: "like", on: true });
    });

    it("reads broadcast nothing", async () => {
      const host = new ToolRegistry();
      mount(host, makeContent("c1").adapter);
      const events: unknown[] = [];
      onActivity((e) => {
        events.push(e);
      });
      await call(host, "reaction_read");
      await call(host, "reaction_list");
      expect(events).toEqual([]);
    });

    it("a refused write broadcasts nothing", async () => {
      const host = new ToolRegistry();
      mount(host, makeContent("c1").adapter);
      const events: unknown[] = [];
      onActivity((e) => {
        events.push(e);
      });
      await call(host, "reaction_toggle", { key: "nope" });
      expect(events).toEqual([]);
    });
  });

  describe("host commits", () => {
    it("awaits an async commit and reports a refusal without broadcasting", async () => {
      const host = new ToolRegistry();
      const { adapter } = makeContent("c1", {
        setValue: vi.fn(async () => ({ ok: false as const, error: "Comment is locked" })),
      });
      mount(host, adapter);
      const events: unknown[] = [];
      onActivity((e) => {
        events.push(e);
      });
      const r = await call(host, "reaction_toggle", { key: "like" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Comment is locked");
      expect(events).toEqual([]);
    });

    it("a thrown commit is an error, not a crash", async () => {
      const host = new ToolRegistry();
      const { adapter } = makeContent("c1", {
        setValue: () => {
          throw new Error("network down");
        },
      });
      mount(host, adapter);
      const r = await call(host, "reaction_set", { value: ["like"] });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("network down");
    });
  });

  describe("undo", () => {
    it("agent_undo restores the previous value, agent_redo re-applies", async () => {
      const host = new ToolRegistry();
      const { adapter, state } = makeContent("c1", {}, ["sad"]);
      mount(host, adapter);
      await call(host, "reaction_toggle", { key: "like" });
      expect(state.value).toEqual(["sad", "like"]);
      await call(host, "agent_undo");
      expect(state.value).toEqual(["sad"]);
      await call(host, "agent_redo");
      expect(state.value).toEqual(["sad", "like"]);
    });
  });

  describe("pendingMode", () => {
    it("off by default: writes apply at once", async () => {
      const host = new ToolRegistry();
      const { adapter, state } = makeContent("c1");
      mount(host, adapter);
      await call(host, "reaction_toggle", { key: "like" });
      expect(state.value).toEqual(["like"]);
    });

    it("on, without a confirm hook: staged until confirm:true", async () => {
      const host = new ToolRegistry();
      const { adapter, state } = makeContent("c1");
      mount(host, adapter, { pendingMode: true });
      const staged = await call(host, "reaction_toggle", { key: "like" });
      expect(staged.isError).toBe(true);
      expect(staged.text).toContain("confirm:true");
      expect(state.value).toEqual([]);
      await call(host, "reaction_toggle", { key: "like", confirm: true });
      expect(state.value).toEqual(["like"]);
    });

    it("on, with a confirm hook: the human decides, and a decline changes nothing", async () => {
      const host = new ToolRegistry();
      const { adapter, state } = makeContent("c1");
      const confirm = vi.fn(async () => false);
      mount(host, adapter, { pendingMode: true, confirm });
      const events: unknown[] = [];
      onActivity((e) => {
        events.push(e);
      });
      const r = await call(host, "reaction_set", { value: ["love"] });
      expect(r.isError).toBe(true);
      expect(confirm).toHaveBeenCalledWith({ action: "reaction_set", content: "c1", value: [], next: ["love"] });
      expect(state.value).toEqual([]);
      expect(events).toEqual([]);

      confirm.mockResolvedValueOnce(true);
      await call(host, "reaction_set", { value: ["love"] });
      expect(state.value).toEqual(["love"]);
    });
  });

  describe("several contents on one host", () => {
    it("shares one tool list and selects the content by id", async () => {
      const host = new ToolRegistry();
      const a = makeContent("c1");
      const b = makeContent("c2");
      mount(host, a.adapter);
      const before = host.listTools().length;
      mount(host, b.adapter);
      expect(host.listTools().length).toBe(before);

      await call(host, "reaction_toggle", { content: "c2", key: "love" });
      expect(b.state.value).toEqual(["love"]);
      expect(a.state.value).toEqual([]);
    });

    it("requires `content` once two are mounted, and lists them", async () => {
      const host = new ToolRegistry();
      mount(host, makeContent("c1").adapter);
      mount(host, makeContent("c2").adapter);
      const r = await call(host, "reaction_toggle", { key: "like" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('"c1", "c2"');
      expect(r.text).toContain("reaction_list");

      const list = await call(host, "reaction_list");
      expect(list.structured.contents.map((c: any) => c.id)).toEqual(["c1", "c2"]);
      expect(list.structured.contents[0]).toMatchObject({ title: "Comment c1", value: [], screenId: "thread" });
    });

    it("dispose removes only that content; the last one withdraws the tools", () => {
      const host = new ToolRegistry();
      const one = mount(host, makeContent("c1").adapter);
      const two = mount(host, makeContent("c2").adapter);
      one.dispose();
      expect(host.getTool("reaction_toggle")).not.toBeNull();
      two.dispose();
      for (const n of TOOLS) expect(host.getTool(n)).toBeNull();
    });

    it("refuses an adapter without an id", () => {
      const host = new ToolRegistry();
      expect(() => mount(host, makeContent("").adapter)).toThrow(/id/);
    });
  });
});
