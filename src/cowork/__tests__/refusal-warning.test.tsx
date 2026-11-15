// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { createCoworkSession } from "../session";
import { createMemoryTransport } from "../transport";
import { useCoworkSession } from "../use-cowork-session";

/*
 * MOIC, live on 0.64.0: one run posted no field intent at all, the next (identical
 * code) posted every one. They pass no `onRefused`, and a refusal at the sender is
 * decided before the network, so whatever stopped those reports left no trace. With
 * no handler, a refusal is now warned on the console, once per stage, kind and reason.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const masked = { control: { mode: "free" as const }, limits: { mask: ["composer"] } };

describe("a refusal with no onRefused", () => {
  it("is warned on the console once per stage, kind and reason", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hub = createMemoryTransport();
    const s = createCoworkSession({ sessionId: "s", self: { ref: "a" }, transport: hub.connect({ ref: "a" }), config: masked, authorize: () => true });
    await s.reportField("composer", "one");
    await s.reportField("composer", "two");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("cowork.denied.masked");
    expect(String(warn.mock.calls[0]![0])).toContain("field");
    s.destroy();
  });

  it("is not warned when the host handles refusals", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: unknown[] = [];
    const hub = createMemoryTransport();
    const s = createCoworkSession({ sessionId: "s", self: { ref: "a" }, transport: hub.connect({ ref: "a" }), config: masked, authorize: () => true, onRefused: (r) => seen.push(r) });
    await s.reportField("composer", "one");
    expect(seen).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    s.destroy();
  });

  it("through the hook too, which always wraps the host's handler", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hub = createMemoryTransport();
    const transport = hub.connect({ ref: "a" });
    let handle: ReturnType<typeof useCoworkSession> | undefined;
    function Page() {
      handle = useCoworkSession({ sessionId: "s", self: { ref: "a" }, transport, config: masked, authorize: () => true });
      return null;
    }
    render(<Page />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { await handle!.reportField("composer", "one"); });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("cowork.denied.masked");
  });
});
