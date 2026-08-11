import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerGitBridge } from "../git";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import type { JsonObject } from "../../mcp/types";

function setup(opts: { allowApply?: boolean; withOptional?: boolean } = {}) {
  const proposed: Array<{ operation: string; args: Record<string, unknown> }> = [];
  const applied: unknown[] = [];
  const host = new ToolRegistry();

  registerGitBridge(host, {
    allowApply: opts.allowApply,
    adapter: {
      status: async () => ({ branch: "main", staged: [], unstaged: ["src/a.ts"] }),
      log: async (q) => ({ commits: [{ sha: "abc1234", subject: "first" }], limit: q.limit }),
      diff: async (q) => ({ from: q.from ?? null, patch: "@@ -1 +1 @@" }),
      propose: async (operation, args) => {
        proposed.push({ operation, args });
        return { id: `prop-${proposed.length}`, operation, args, summary: `${operation} proposal` } as never;
      },
      ...(opts.withOptional === false
        ? {}
        : {
            reviews: async () => ({ items: [{ number: 7, title: "Add thing" }] }),
            checks: async (rev) => ({ revision: rev, checks: [{ name: "ci", status: "success" }] }),
            applyProposal: async (p) => {
              applied.push(p);
              return { ok: true };
            },
          }),
    },
  });

  const call = async (name: string, args: JsonObject = {}) => {
    const r = await host.callTool(name, args);
    return { isError: r.isError, text: r.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "" };
  };

  return { host, call, proposed, applied };
}

describe("registerGitBridge", () => {
  beforeEach(() => resetAllUndoStacks());

  it("registers reads and mutations", () => {
    const names = setup().host.listTools().map((t) => t.name);

    for (const t of ["git_status", "git_log", "git_diff", "git_stage", "git_unstage", "git_commit", "git_push", "git_pull", "git_fetch", "git_checkout"]) {
      expect(names, `missing ${t}`).toContain(t);
    }
  });

  it("reads status, log and diff straight through", async () => {
    const { call } = setup();

    expect((await call("git_status")).text).toContain("main");
    expect((await call("git_log", { limit: 1 })).text).toContain("abc1234");
    expect((await call("git_diff", {})).text).toContain("@@");
  });

  it("PROPOSES a mutation rather than performing it", async () => {
    // The whole posture of this bridge: an agent may not move a repository on
    // its own. `allowApply` is off unless a host opts in, so a commit request
    // must produce a proposal and change nothing.
    const { call, proposed, applied } = setup();

    const r = await call("git_commit", { message: "wip" });

    expect(r.isError).toBeFalsy();
    expect(proposed.map((p) => p.operation)).toContain("commit");
    expect(applied, "nothing may be applied without allowApply").toHaveLength(0);
  });

  it("proposes for every mutating verb, not just commit", async () => {
    const { call, proposed, applied } = setup();

    await call("git_stage", { paths: ["src/a.ts"] });
    await call("git_push", {});
    await call("git_checkout", { ref: "feature" });

    expect(proposed.map((p) => p.operation).sort()).toEqual(["checkout", "push", "stage"]);
    expect(applied).toHaveLength(0);
  });

  it("still refuses to apply when the host wired no applyProposal", async () => {
    // allowApply on its own is not enough — the host must also supply the
    // applier. Otherwise "allowed" would mean "silently does nothing".
    const { call, applied } = setup({ allowApply: true, withOptional: false });

    await call("git_commit", { message: "wip" });

    expect(applied).toHaveLength(0);
  });

  it("does not ADVERTISE a capability the provider lacks", async () => {
    // `reviews` and `checks` are optional — not every provider has them. The
    // bridge omits the tools entirely rather than exposing ones that fail when
    // called, which is the better of the two: an agent picks from the tool
    // list, so a tool that exists and always errors wastes a turn to discover
    // what the list could have said for free.
    const withOut = setup({ withOptional: false }).host.listTools().map((t) => t.name);
    const withIt = setup().host.listTools().map((t) => t.name);

    expect(withOut).not.toContain("git_reviews_list");
    expect(withOut).not.toContain("git_checks");
    expect(withIt, "and they appear when the provider does support them").toContain("git_reviews_list");
  });

  it("reads reviews and checks when the provider supports them", async () => {
    const { call } = setup();

    expect((await call("git_reviews_list", {})).text).toContain("Add thing");
    expect((await call("git_checks", { revision: "abc1234" })).text).toContain("success");
  });
});
