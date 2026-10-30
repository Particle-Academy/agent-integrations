import type { ToolHost } from "../mcp/tool-host";

/**
 * One bridge serving N instances on a host (docs/multi-form-hosts.md, option A).
 * Internal: not an entry point.
 *
 * A bridge whose tool names are not scoped to its adapter (`form_set_value`,
 * not `form_billing_set_value`) can only serve one instance per host unless the
 * instances share the tools. This is the sharing: the FIRST instance of a family
 * on a host installs the family's tools; later ones join a per-host router; each
 * tool resolves its target instance from an argument (`form`); the tools are
 * withdrawn when the last instance leaves. The tool list therefore stays the
 * same size however many instances come and go.
 *
 * Resolution rules, which are the agent-facing contract:
 *  - exactly one instance mounted: the argument is optional;
 *  - two or more: a call without it is refused with the ids listed;
 *  - an id that is not mounted is refused with the ids listed, even when only
 *    one is mounted (a call aimed at a form that closed must not land on another).
 *
 * The router does not register tools itself. `install` does, under one owner
 * the bridge chooses, so the 0.51.0 refusal still stops an unrelated registrant
 * taking a family tool name. If `install` throws (a name is already held), no
 * router is left behind.
 */

export type InstanceResolution<T> =
  | { ok: true; id: string; instance: T }
  | { ok: false; error: string };

export type InstanceRouter<T> = {
  /** Mounted instance ids, in mount order. */
  ids(): string[];
  /** Mounted instances, in mount order. */
  entries(): Array<[string, T]>;
  /** Pick the instance a tool call targets, from the raw argument value. */
  resolve(requested: unknown): InstanceResolution<T>;
};

export type InstanceRouterOptions<T> = {
  /** Family key: one router per (host, family). E.g. "form". */
  family: string;
  /** Name of the tool argument that selects an instance. E.g. "form". */
  argument: string;
  /** The family's listing tool, named in errors so an agent can recover. E.g. "form_list". */
  listTool: string;
  /**
   * Register the family's shared tools on `host`, dispatching through `router`.
   * Called once, when the first instance joins. Returns the disposer that
   * withdraws them, called when the last instance leaves.
   */
  install: (router: InstanceRouter<T>) => () => void;
};

export type InstanceMembership<T> = {
  router: InstanceRouter<T>;
  /** Remove THIS instance. Idempotent; a no-op if a later join replaced it. */
  leave: () => void;
};

type RouterState<T> = {
  instances: Map<string, T>;
  router: InstanceRouter<T>;
  uninstall: () => void;
};

const routers = new WeakMap<ToolHost, Map<string, RouterState<unknown>>>();

const quoteAll = (ids: string[]) => ids.map((id) => `"${id}"`).join(", ");

/**
 * Join `instance` under `id` to the host's router for `options.family`,
 * creating (and installing) the router if this is the first instance.
 *
 * A second join under an id that is already mounted REPLACES that entry: it
 * cannot be told apart from a remount whose cleanup has not run yet, and the
 * earlier membership's `leave` then becomes a no-op, so a late cleanup cannot
 * take the newer instance down.
 */
export function joinInstanceRouter<T>(
  host: ToolHost,
  options: InstanceRouterOptions<T>,
  id: string,
  instance: T,
): InstanceMembership<T> {
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error(
      `A ${options.family} on a shared host needs a non-empty string id (got ${JSON.stringify(id)}); `
        + `agents select it by that id through the "${options.argument}" argument.`,
    );
  }

  let byFamily = routers.get(host);
  if (!byFamily) {
    byFamily = new Map();
    routers.set(host, byFamily);
  }

  let state = byFamily.get(options.family) as RouterState<T> | undefined;
  if (!state) {
    const instances = new Map<string, T>();
    const router: InstanceRouter<T> = {
      ids: () => [...instances.keys()],
      entries: () => [...instances.entries()],
      resolve: (requested) => resolve(options, instances, requested),
    };
    // Installing may throw (a tool name held by an unrelated registrant). Nothing
    // has been recorded yet, so a failed install leaves no router behind.
    const uninstall = options.install(router);
    state = { instances, router, uninstall };
    byFamily.set(options.family, state as RouterState<unknown>);
  }

  const current = state;
  current.instances.set(id, instance);
  // Re-insertion keeps Map order; a remount should not jump the listing order.

  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    if (current.instances.get(id) !== instance) return; // replaced by a later join
    current.instances.delete(id);
    if (current.instances.size === 0 && byFamily!.get(options.family) === current) {
      byFamily!.delete(options.family);
      current.uninstall();
    }
  };

  return { router: current.router, leave };
}

function resolve<T>(
  options: InstanceRouterOptions<T>,
  instances: Map<string, T>,
  requested: unknown,
): InstanceResolution<T> {
  const ids = [...instances.keys()];
  const { family, argument, listTool } = options;
  if (requested === undefined || requested === null || requested === "") {
    if (ids.length === 1) return { ok: true, id: ids[0], instance: instances.get(ids[0]) as T };
    if (ids.length === 0) return { ok: false, error: `No ${family} is mounted.` };
    return {
      ok: false,
      error:
        `${ids.length} ${family}s are mounted, so pass "${argument}" with one of: ${quoteAll(ids)}. `
        + `${listTool} describes them.`,
    };
  }
  if (typeof requested !== "string") {
    return { ok: false, error: `"${argument}" must be a ${family} id string. Mounted: ${quoteAll(ids)}.` };
  }
  if (!instances.has(requested)) {
    return {
      ok: false,
      error:
        `No ${family} "${requested}" is mounted. `
        + (ids.length ? `Mounted: ${quoteAll(ids)}. ` : "")
        + `${listTool} lists what is open.`,
    };
  }
  return { ok: true, id: requested, instance: instances.get(requested) as T };
}
