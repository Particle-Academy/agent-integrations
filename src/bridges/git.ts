import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";

export type GitProposal = {
  operation: string;
  arguments: Record<string, unknown>;
  summary: string;
};

export type GitBridgeAdapter = {
  status: () => Promise<unknown>;
  log: (query: { ref?: string; limit?: number; skip?: number }) => Promise<unknown>;
  diff: (query: { from?: string; to?: string; staged?: boolean; paths?: string[] }) => Promise<unknown>;
  reviews?: (query: { state?: string; cursor?: string; limit?: number }) => Promise<unknown>;
  checks?: (revision: string) => Promise<unknown>;
  propose: (operation: string, args: Record<string, unknown>) => Promise<GitProposal>;
  applyProposal?: (proposal: GitProposal) => Promise<unknown>;
};

export type GitBridgeOptions = {
  adapter: GitBridgeAdapter;
  agent?: { id: string; name?: string; color?: string };
  /** Defaults to proposal-only. Set true only when the host has its own confirmation policy. */
  allowApply?: boolean;
};

export function registerGitBridge(host: ToolHost, options: GitBridgeOptions): Bridge {
  const agent = { id: "agent", name: "Agent", color: "#a855f7", ...(options.agent ?? {}) };
  const disposers: Array<() => void> = [];
  ensureUndoToolsRegistered(host, { defaultAgentId: agent.id });

  const reg = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: JsonObject) => Promise<unknown>,
    mutation = false,
  ) => {
    const wrapped = async (args: JsonObject) => {
      try {
        return await handler(args);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    };
    const final = mutation
      ? wrapToolWithActivity(wrapped as any, {
          toolName: name,
          agent,
          kind: "git",
          resolveTarget: ({ args }) => ({ kind: "git", elementId: typeof args.path === "string" ? args.path : undefined } as any),
        })
      : wrapped;
    disposers.push(host.registerTool({
      name,
      description,
      inputSchema: { type: "object", properties: properties as any, required, additionalProperties: false },
    }, final as any));
  };

  reg("git_status", "Read normalized working-tree and branch status.", {}, [], async () => {
    const result = await options.adapter.status();
    return textResult(JSON.stringify(result, null, 2), result as any);
  });
  reg("git_log", "Read normalized commit history.", {
    ref: { type: "string" }, limit: { type: "number" }, skip: { type: "number" },
  }, [], async (args) => {
    const result = await options.adapter.log(args as any);
    return textResult(JSON.stringify(result, null, 2), result as any);
  });
  reg("git_diff", "Read a normalized Git diff.", {
    from: { type: "string" }, to: { type: "string" }, staged: { type: "boolean" },
    paths: { type: "array", items: { type: "string" } },
  }, [], async (args) => {
    const result = await options.adapter.diff(args as any);
    return textResult(JSON.stringify(result, null, 2), result as any);
  });
  if (options.adapter.reviews) reg("git_reviews_list", "List normalized pull/merge requests.", {
    state: { type: "string" }, cursor: { type: "string" }, limit: { type: "number" },
  }, [], async (args) => {
    const result = await options.adapter.reviews!(args as any);
    return textResult(JSON.stringify(result, null, 2), result as any);
  });
  if (options.adapter.checks) reg("git_checks", "Read checks or pipeline summaries for a revision.", {
    revision: { type: "string" },
  }, ["revision"], async (args) => {
    const result = await options.adapter.checks!(String(args.revision));
    return textResult(JSON.stringify(result, null, 2), result as any);
  });

  const mutation = (name: string, description: string, properties: Record<string, unknown>, required: string[]) =>
    reg(name, description, properties, required, async (args) => {
      const proposal = await options.adapter.propose(name.slice(4), args);
      if (args.apply === true) {
        if (!options.allowApply || !options.adapter.applyProposal) return errorResult("This host requires human confirmation before applying Git writes.");
        const result = await options.adapter.applyProposal(proposal);
        return textResult(`Applied: ${proposal.summary}`, result as any);
      }
      return textResult(`Proposed: ${proposal.summary}`, proposal as any);
    }, true);

  mutation("git_stage", "Propose staging paths.", { paths: { type: "array", items: { type: "string" } }, apply: { type: "boolean" } }, ["paths"]);
  mutation("git_unstage", "Propose unstaging paths.", { paths: { type: "array", items: { type: "string" } }, apply: { type: "boolean" } }, ["paths"]);
  mutation("git_commit", "Propose committing staged changes.", { message: { type: "string" }, apply: { type: "boolean" } }, ["message"]);
  mutation("git_checkout", "Propose checking out a ref.", { target: { type: "string" }, apply: { type: "boolean" } }, ["target"]);
  mutation("git_fetch", "Propose fetching a remote.", { remote: { type: "string" }, apply: { type: "boolean" } }, []);
  mutation("git_pull", "Propose a fast-forward-only pull.", { remote: { type: "string" }, branch: { type: "string" }, apply: { type: "boolean" } }, []);
  mutation("git_push", "Propose pushing a branch.", { remote: { type: "string" }, branch: { type: "string" }, apply: { type: "boolean" } }, []);
  mutation("git_review_create", "Propose creating a pull/merge request.", {
    title: { type: "string" }, body: { type: "string" }, sourceBranch: { type: "string" }, targetBranch: { type: "string" }, draft: { type: "boolean" }, apply: { type: "boolean" },
  }, ["title", "sourceBranch", "targetBranch"]);

  return { id: "git", title: "Git", dispose: () => disposers.forEach((dispose) => dispose()) };
}
