import { emitActivity } from "../presence";
import { errorResult, textResult, type MicroMcpServer, type Transport } from "../mcp/server";
import type { JsonObject, ToolCallContext } from "../mcp/types";
import type { ToolHost } from "../mcp/tool-host";
import type { HumanPlusActor, HumanPlusEventStore, HumanPlusPriority } from "../human-plus/events";

export type TuiActionPolicy = "observe" | "execute" | "propose" | "confirm" | "human-only";
export interface TuiSurfaceCommandLike { name: string; description?: string; policy?: TuiActionPolicy; inputSchema?: Record<string, unknown>; invoke(input?: Record<string, unknown>): unknown | Promise<unknown>; }
export interface TuiSurfaceLike { id: string; kind: string; label?: string; read(): unknown; commands?: TuiSurfaceCommandLike[]; }
export interface TuiSurfaceRegistryLike { list(): TuiSurfaceLike[]; get(id: string): TuiSurfaceLike | undefined; }
export interface TuiBridgeOptions {
  registry: TuiSurfaceRegistryLike;
  eventStore: HumanPlusEventStore;
  appId: string;
  sessionId?: string;
  actor?: HumanPlusActor;
}

type Subscription = { consumerId: string; types?: string[]; surfaces?: string[] };
type PendingAction = { id: string; surfaceId: string; command: string; input: Record<string, unknown>; actor: HumanPlusActor };

export function registerTuiBridge(host: ToolHost, options: TuiBridgeOptions) {
  const disposers: Array<() => void> = []; const subscriptions = new Map<unknown, Subscription>(); const pending = new Map<string, PendingAction>();
  const defaultActor = options.actor ?? { kind: "agent" as const, id: "agent", name: "Agent" };
  const serverCapabilities = (host as ToolHost & { capabilities?: { experimental?: Record<string, unknown> } }).capabilities;
  if (serverCapabilities) serverCapabilities.experimental = { ...serverCapabilities.experimental, "io.particle-academy/human-plus": { version: "1", push: true, durableCursor: true, stagedActions: true, wakesAgent: false } };
  const register = (name: string, description: string, properties: Record<string, unknown>, required: string[], handler: (args: JsonObject, context?: ToolCallContext) => unknown | Promise<unknown>) => {
    disposers.push(host.registerTool({ name, description, inputSchema: { type: "object", properties: properties as never, required } }, async (args, context) => {
      try { const result = await handler(args, context); return textResult(typeof result === "string" ? result : JSON.stringify(result), result); }
      catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
    }));
  };
  const publish = async (surfaceId: string, type: string, payload: unknown, actor = defaultActor, priority: HumanPlusPriority = "normal") => options.eventStore.append({ appId: options.appId, sessionId: options.sessionId, surfaceId, type, payload, actor, priority });

  register("tui_surfaces_list", "List addressable Fancy TUI surfaces and commands.", {}, [], () => options.registry.list().map((surface) => ({ id: surface.id, kind: surface.kind, label: surface.label, commands: surface.commands?.map((command) => ({ name: command.name, description: command.description, policy: command.policy ?? "execute", inputSchema: command.inputSchema })) ?? [] })));
  register("tui_surface_read", "Read a Fancy TUI surface by stable id.", { id: { type: "string" } }, ["id"], (args) => {
    const surface = options.registry.get(String(args.id)); if (!surface) throw new Error(`Unknown TUI surface: ${String(args.id)}`); return { id: surface.id, kind: surface.kind, state: surface.read() };
  });
  register("tui_action_invoke", "Invoke or propose an action on a Fancy TUI surface.", { surfaceId: { type: "string" }, command: { type: "string" }, input: { type: "object" } }, ["surfaceId", "command"], async (args) => {
    const surfaceId = String(args.surfaceId); const commandName = String(args.command); const surface = options.registry.get(surfaceId); if (!surface) throw new Error(`Unknown TUI surface: ${surfaceId}`);
    const command = surface.commands?.find((value) => value.name === commandName); if (!command) throw new Error(`Unknown command '${commandName}' on ${surfaceId}`);
    const policy = command.policy ?? "execute"; if (policy === "observe" || policy === "human-only") throw new Error(`Action ${surfaceId}.${commandName} is ${policy}`);
    const input = (args.input && typeof args.input === "object" && !Array.isArray(args.input) ? args.input : {}) as Record<string, unknown>;
    if (policy === "propose" || policy === "confirm") {
      const id = globalThis.crypto.randomUUID(); pending.set(id, { id, surfaceId, command: commandName, input, actor: defaultActor });
      await publish(surfaceId, "action.proposed", { id, command: commandName, input }, defaultActor, "attention"); return { pending: true, id };
    }
    const result = await command.invoke(input); await publish(surfaceId, "action.executed", { command: commandName, input, result });
    emitActivity({ agentId: defaultActor.id, agentName: defaultActor.name, target: { kind: "custom", elementId: surfaceId }, action: `tui_${commandName}`, timestamp: Date.now(), meta: { surfaceId } });
    return { executed: true, result };
  });
  register("tui_action_confirm", "Confirm and execute a pending TUI action.", { id: { type: "string" } }, ["id"], async (args) => {
    const id = String(args.id); const value = pending.get(id); if (!value) throw new Error(`Unknown pending action: ${id}`); const surface = options.registry.get(value.surfaceId); const command = surface?.commands?.find((x) => x.name === value.command); if (!command) throw new Error("Pending action target is no longer available");
    pending.delete(id); const result = await command.invoke(value.input); await publish(value.surfaceId, "action.confirmed", { id, command: value.command, result }, { kind: "human", id: "human" }); return { executed: true, result };
  });
  register("tui_action_reject", "Reject a pending TUI action.", { id: { type: "string" } }, ["id"], async (args) => { const id = String(args.id); const value = pending.get(id); if (!value) throw new Error(`Unknown pending action: ${id}`); pending.delete(id); await publish(value.surfaceId, "action.rejected", { id, command: value.command }, { kind: "human", id: "human" }); return { rejected: true }; });
  register("human_plus_events_list", "Pull durable Human+ events for a consumer.", { consumerId: { type: "string" }, after: { type: "number" }, limit: { type: "number" }, unacknowledgedOnly: { type: "boolean" } }, ["consumerId"], (args) => options.eventStore.list({ consumerId: String(args.consumerId), after: typeof args.after === "number" ? args.after : undefined, limit: typeof args.limit === "number" ? args.limit : undefined, unacknowledgedOnly: args.unacknowledgedOnly === true }));
  register("human_plus_events_ack", "Acknowledge durable Human+ events.", { consumerId: { type: "string" }, eventIds: { type: "array", items: { type: "string" } }, disposition: { type: "string" } }, ["consumerId", "eventIds"], async (args) => { const ids = Array.isArray(args.eventIds) ? args.eventIds.map(String) : []; await options.eventStore.acknowledge(String(args.consumerId), ids, ["seen", "handled", "rejected", "ignored"].includes(String(args.disposition)) ? String(args.disposition) as any : "handled"); return { acknowledged: ids.length }; });
  register("human_plus_events_subscribe", "Push matching Human+ events on this MCP transport while retaining them in the inbox.", { consumerId: { type: "string" }, types: { type: "array" }, surfaces: { type: "array" } }, ["consumerId"], (args, context) => { if (!context?.transport) throw new Error("Subscriptions require an attached MCP transport"); subscriptions.set(context.transport, { consumerId: String(args.consumerId), types: Array.isArray(args.types) ? args.types.map(String) : undefined, surfaces: Array.isArray(args.surfaces) ? args.surfaces.map(String) : undefined }); return { subscribed: true, delivery: "at-least-once", wakesAgent: false }; });

  const unsubscribeStore = options.eventStore.subscribe((event) => {
    const server = host as ToolHost & Pick<MicroMcpServer, "notify">;
    if (typeof server.notify !== "function") return;
    for (const [transport, subscription] of subscriptions) {
      if (subscription.types?.length && !subscription.types.includes(event.type)) continue;
      if (subscription.surfaces?.length && !subscription.surfaces.includes(event.surfaceId)) continue;
      server.notify({ jsonrpc: "2.0", method: "notifications/human_plus/event", params: event as never }, transport as Transport);
    }
  });
  return { id: "tui", title: "Fancy TUI", pending: () => [...pending.values()], dispose: () => { disposers.forEach((dispose) => dispose()); unsubscribeStore(); subscriptions.clear(); pending.clear(); } };
}
