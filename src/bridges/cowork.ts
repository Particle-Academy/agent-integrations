import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import type { AgentTarget } from "../presence/types";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";
import type { CoworkSession, CoworkSnapshot } from "../cowork/session";
import type { Decision } from "../cowork/types";
import { isValidRef } from "../cowork/engine";

/**
 * Bridge for co-work sessions (CC-fancy-0037): an AI agent joins a session as an
 * ordinary participant.
 *
 * The agent brings its OWN `CoworkSession` (created with its own ref, transport
 * and the host's same `config` / `authorize`), so every tool here goes through the
 * same engine, middleware, consent and control mode a person's browser does. There
 * is no agent bypass: a host that does not grant the agent `drive` on a view sees
 * the agent refused with `cowork.denied.authorize`, exactly as a person would be.
 *
 *   cowork_peers             who is here, where, who follows whom, who holds control
 *   cowork_follow            follow a peer's view (no ref: stop following)
 *   cowork_request_control   ask for a view's baton; its holder decides
 *   cowork_release_control   hand a held view back to its owner
 *
 * The list is CLOSED ({@link COWORK_BRIDGE_TOOLS}, asserted by the suite). Nothing
 * here grants control, revokes it, writes into a page or reads a field value:
 * granting is the view owner's decision, and page actions belong to the
 * navigation bridge of a page the agent is allowed to drive. `cowork_peers`
 * reports neither cursors nor the name of a field someone is editing.
 */
export const COWORK_BRIDGE_TOOLS = [
  "cowork_peers",
  "cowork_follow",
  "cowork_request_control",
  "cowork_release_control",
] as const;

export type CoworkBridgeOptions = {
  /** The agent's own participant session. */
  session: Pick<CoworkSession, "getSnapshot" | "follow" | "unfollow" | "requestControl" | "release">;
  agent?: { id: string; name?: string; color?: string };
  /** Stable id for this bridge instance. Default the session id. */
  id?: string;
  screenId?: string;
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };

/** The snapshot as an agent may see it: no cursors, positions or field names. */
function describe(snapshot: CoworkSnapshot) {
  return {
    sessionId: snapshot.sessionId,
    self: snapshot.self,
    configured: snapshot.configured,
    consent: snapshot.consent,
    blocked: snapshot.blocked
      ? {
          by: snapshot.blocked.by,
          mode: snapshot.blocked.mode,
          ...(snapshot.blocked.until !== undefined ? { until: snapshot.blocked.until } : {}),
        }
      : null,
    peers: snapshot.peers.map((p) => ({
      ref: p.ref,
      ...(p.label !== undefined ? { label: p.label } : {}),
      self: p.self,
      route: p.view.route,
      follows: p.follows,
      drives: p.drives,
      idle: p.idle,
      ...(p.activeField !== null ? { editing: true } : {}),
    })),
    control: Object.fromEntries(
      Object.entries(snapshot.control).map(([view, c]) => [
        view,
        {
          mode: c.mode,
          ...(c.holder !== undefined ? { holder: c.holder } : {}),
          requests: [...c.requests],
          ...(c.blockedUntil !== undefined ? { blockedUntil: c.blockedUntil } : {}),
        },
      ]),
    ),
  };
}

const answer = (decision: Decision, ok: string) =>
  decision.allow
    ? textResult(ok, { allow: true })
    : errorResult(`Refused: ${decision.reason} (${decision.status}). The session's policy decides; nothing was changed.`);

/** registerCoworkBridge: MCP tools that let an agent take part in a co-work session. */
export function registerCoworkBridge(host: ToolHost, options: CoworkBridgeOptions): Bridge {
  const { session } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const surfaceId = options.id ?? session.getSnapshot().sessionId;
  const bridgeId = `cowork:${surfaceId}`;
  const disposers: Array<() => void> = [];

  ensureUndoToolsRegistered(host, { defaultAgentId: agent.id });

  const target = (elementId: string | undefined, label: string): AgentTarget => ({
    kind: "custom",
    screenId: options.screenId,
    elementId,
    label,
  });

  const reg = (
    name: (typeof COWORK_BRIDGE_TOOLS)[number],
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: JsonObject) => Promise<unknown> | unknown,
    resolveTarget: false | ((args: JsonObject) => AgentTarget),
  ) => {
    const wrapped = async (args: JsonObject) => {
      try {
        return await handler(args);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    };
    const final = resolveTarget
      ? wrapToolWithActivity(wrapped as never, {
          toolName: name,
          agent,
          kind: "custom",
          screenId: options.screenId,
          resolveTarget: ({ args }) => resolveTarget(args as JsonObject),
        })
      : wrapped;
    disposers.push(
      host.registerTool(
        {
          name,
          description,
          inputSchema: { type: "object", properties: properties as Record<string, never>, required, additionalProperties: false },
        },
        final as never,
        { owner: bridgeId },
      ),
    );
  };

  reg(
    "cowork_peers",
    "List the people and agents in this co-work session: each one's ref, label, route, who they follow, whether they drive or are idle, and who holds control of each view. Never includes cursors or field values.",
    {},
    [],
    () => {
      const out = describe(session.getSnapshot());
      return textResult(JSON.stringify(out, null, 2), out);
    },
    false,
  );

  reg(
    "cowork_follow",
    "Follow a peer's view, so your view mirrors where they go. Omit ref to stop following. The session's policy may refuse; the reason is returned.",
    { ref: { type: "string", description: "The peer's ref, from cowork_peers. Omit to stop following." } },
    [],
    async (args) => {
      if (args.ref === undefined) return answer(await session.unfollow(), "Stopped following.");
      if (!isValidRef(args.ref)) return errorResult("ref must be a peer ref from cowork_peers.");
      return answer(await session.follow(args.ref), `Following ${args.ref}.`);
    },
    (args) => target(typeof args.ref === "string" ? args.ref : undefined, args.ref === undefined ? "stop following" : `follow ${String(args.ref)}`),
  );

  reg(
    "cowork_request_control",
    "Ask for control of a view (baton control). This only queues the request: the view's current holder grants it or not. Refused under other control modes and when the host does not allow you to drive that view.",
    { view: { type: "string", description: "The view's ref (its owner's ref), from cowork_peers." } },
    ["view"],
    async (args) => {
      if (!isValidRef(args.view)) return errorResult("view must be a view ref from cowork_peers.");
      return answer(await session.requestControl(args.view), `Requested control of ${args.view}'s view; its holder decides.`);
    },
    (args) => target(String(args.view), `request control of ${String(args.view)}`),
  );

  reg(
    "cowork_release_control",
    "Hand a view you hold back to its owner.",
    { view: { type: "string", description: "The view's ref (its owner's ref)." } },
    ["view"],
    async (args) => {
      if (!isValidRef(args.view)) return errorResult("view must be a view ref from cowork_peers.");
      return answer(await session.release(args.view), `Released ${args.view}'s view to its owner.`);
    },
    (args) => target(String(args.view), `release ${String(args.view)}`),
  );

  return {
    id: bridgeId,
    title: "Co-work session",
    dispose: () => {
      for (const d of disposers.splice(0)) d();
    },
  };
}
