// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { AgentPanel, type AgentActivity } from "../AgentPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return { host, unmount: () => act(() => root.unmount()) };
}

const CALL: AgentActivity = {
  id: "1",
  at: 1_760_000_000_000,
  kind: "tool",
  source: "whiteboard_add_sticky",
  text: "Added a sticky",
  args: { text: "hello", x: 10 },
  result: { id: "n_1" },
  durationMs: 142,
  status: "ok",
};

/**
 * The tool-call feed lives on AgentPanel rather than in a separate
 * `<ToolCallFeed>`, because the panel already rendered an activity stream with
 * a `"tool"` kind. A sibling component would have re-rendered the same rows
 * beside it.
 */
describe("AgentPanel as a tool-call feed", () => {
  it("renders name, args, result and latency on one row", () => {
    const { host, unmount } = mount(<AgentPanel activity={[CALL]} />);
    const row = host.querySelector("[data-fai-row]") as HTMLElement;

    expect(row.querySelector(".fai-row__source")?.textContent).toBe("whiteboard_add_sticky");
    expect(row.querySelector("[data-fai-args]")?.textContent).toContain("hello");
    expect(row.querySelector("[data-fai-result]")?.textContent).toContain("n_1");
    expect(row.querySelector("[data-fai-latency]")?.textContent).toContain("142ms");
    unmount();
  });

  it("marks the row's status so a stream shows work in flight", () => {
    // The difference between a feed and a log: a row can appear the moment a
    // call starts, not only once it has settled.
    const pending = { ...CALL, id: "2", status: "pending" as const, result: undefined, durationMs: undefined };
    const { host, unmount } = mount(<AgentPanel activity={[pending, CALL]} />);
    const rows = [...host.querySelectorAll("[data-fai-row]")];

    expect(rows[0]?.getAttribute("data-status")).toBe("pending");
    expect(rows[1]?.getAttribute("data-status")).toBe("ok");
    unmount();
  });

  it("infers error status from the kind when none is given", () => {
    const failed: AgentActivity = { ...CALL, id: "3", kind: "error", status: undefined };
    const { host, unmount } = mount(<AgentPanel activity={[failed]} />);

    expect(host.querySelector("[data-fai-row]")?.getAttribute("data-kind")).toBe("error");
    unmount();
  });

  it("truncates a long payload instead of pushing the feed off screen", () => {
    // A feed is scanned, not read. An untruncated result shifts every
    // subsequent row out of view, which costs more than the detail is worth —
    // the full value stays on `detail`.
    const long = { ...CALL, id: "4", result: "x".repeat(500) };
    const { host, unmount } = mount(<AgentPanel activity={[long]} />);
    const text = host.querySelector("[data-fai-result]")?.textContent ?? "";

    expect(text.length).toBeLessThan(120);
    expect(text).toContain("…");
    unmount();
  });

  it("leaves a plain activity row exactly as it was", () => {
    // Additive: every existing consumer passes rows with no tool-call fields,
    // and those must render unchanged.
    const plain: AgentActivity = { id: "5", at: CALL.at, kind: "message", source: "Agent", text: "hi" };
    const { host, unmount } = mount(<AgentPanel activity={[plain]} />);
    const row = host.querySelector("[data-fai-row]") as HTMLElement;

    expect(row.querySelector("[data-fai-args]")).toBeNull();
    expect(row.querySelector("[data-fai-result]")).toBeNull();
    expect(row.querySelector("[data-fai-latency]")).toBeNull();
    expect(row.getAttribute("data-status"), "a non-call row has no call status").toBeNull();
    expect(row.textContent).toContain("hi");
    unmount();
  });

  it("treats a tool row with no call fields as an ordinary row", () => {
    const bare: AgentActivity = { id: "6", at: CALL.at, kind: "tool", source: "flow_run", text: "ran" };
    const { host, unmount } = mount(<AgentPanel activity={[bare]} />);

    expect(host.querySelector("[data-fai-row]")?.getAttribute("data-status")).toBeNull();
    unmount();
  });
});
