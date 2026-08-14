import type { MicroMcpServer } from "../mcp/server";

/**
 * A page's contribution to the shared tool surface.
 *
 * Return the disposer that withdraws it — typically the `Bridge`'s own
 * `dispose`, or the function `registerTool` returns. Returning nothing is
 * allowed (the original `extraBridges` was typed that way) but means the
 * contribution can never be withdrawn.
 */
export type BridgeContribution = (server: MicroMcpServer) => (() => void) | void;

/**
 * The registry behind **"site tools always; page tools while mounted"**.
 *
 * `useCoBrowseSession` already had an `extraBridges` hook and already called it.
 * What that shape could not express is a tool surface that CHANGES under the
 * agent mid-session, because the callback is invoked exactly once while the
 * server is being built:
 *
 *   - a page that mounts later never gets a chance to contribute;
 *   - a page that unmounts cannot withdraw, so the agent keeps a tool aimed at
 *     a surface that is gone and only finds out by calling it.
 *
 * Both are silent. Nothing errors; the agent just never sees the tools, or sees
 * dead ones. So contributions live in a registry that is applied when a server
 * appears, re-applied if it is replaced, and withdrawn when the page unmounts —
 * rather than a callback captured at construction.
 *
 * Withdrawal needs no notification machinery of its own: a bridge's disposer
 * unregisters its tools, `ToolRegistry` fires `onToolsChanged`, and
 * `MicroMcpServer` broadcasts `notifications/tools/list_changed`. That was
 * verified before this was written — a grep for `unregisterTool` reads as
 * "nothing unregisters", which is a false negative, because bridges use the
 * disposer `registerTool` returns.
 */
export class BridgeContributions {
  private readonly contributions = new Map<symbol, BridgeContribution>();
  private readonly applied = new Map<symbol, () => void>();
  private server: MicroMcpServer | null = null;

  /**
   * Contribute bridges for as long as the returned disposer is uncalled.
   *
   * Applies immediately when a server is already live, and is held for the next
   * one otherwise — so a page need not know whether sharing has started.
   */
  add(contribute: BridgeContribution): () => void {
    const key = Symbol("bridge-contribution");
    this.contributions.set(key, contribute);
    if (this.server) this.apply(key, contribute, this.server);

    return () => {
      this.contributions.delete(key);
      this.withdraw(key);
    };
  }

  /** Attach a server and apply every live contribution to it. */
  bind(server: MicroMcpServer): void {
    if (this.server === server) return;
    if (this.server) this.unbind();
    this.server = server;
    for (const [key, contribute] of this.contributions) this.apply(key, contribute, server);
  }

  /**
   * Detach the current server, withdrawing what was applied to it. Contributions
   * themselves are KEPT: a session can be stopped and restarted under a page
   * that never unmounted, and its tools must come back rather than silently
   * vanish.
   */
  unbind(): void {
    for (const key of [...this.applied.keys()]) this.withdraw(key);
    this.server = null;
  }

  private apply(key: symbol, contribute: BridgeContribution, server: MicroMcpServer): void {
    const dispose = contribute(server);
    if (typeof dispose === "function") this.applied.set(key, dispose);
  }

  private withdraw(key: symbol): void {
    const dispose = this.applied.get(key);
    this.applied.delete(key);
    dispose?.();
  }
}
