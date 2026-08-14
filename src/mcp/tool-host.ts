import type {
  CallToolResult,
  JsonObject,
  RegisteredTool,
  ToolDefinition,
  ToolHandler,
} from "./types";

/**
 * ToolHost — the minimal surface a bridge needs to register its tools.
 *
 * Bridges (whiteboard, flow, sheets, code, charts, screens, scene, form)
 * speak only through this interface. The MCP server implements it
 * alongside its transport / JSON-RPC duties, and the standalone
 * {@link ToolRegistry} implements it for in-process agents that don't
 * need any of MCP's wire framing.
 *
 * Net effect: every bridge works equally well behind an MCP server
 * (browser ↔ external agents over SSE) or behind a plain registry
 * (in-process agent calling `host.callTool("sheet_set_cell", { … })`).
 */
export interface ToolHost {
  /** Register a tool. Returns a disposer that unregisters it. */
  registerTool(definition: ToolDefinition, handler: ToolHandler): () => void;

  /** Look up an already-registered tool's definition + handler, or null. */
  getTool(name: string): RegisteredTool | null;

  /** Snapshot of all currently-registered tool definitions. */
  listTools(): ToolDefinition[];

  /**
   * Invoke a registered tool directly, bypassing any transport layer.
   * Throws if no tool is registered under `name`.
   *
   * This is the single entry point in-process agents use to drive the
   * surface — no JSON-RPC framing, no transport plumbing.
   */
  callTool(name: string, args?: JsonObject): Promise<CallToolResult>;
}

/**
 * Standalone in-memory ToolHost. Use this when no MCP server is needed —
 * e.g. an in-process agent that just wants to register the same bridges
 * and call them directly.
 *
 * Example:
 *
 *   const host = new ToolRegistry();
 *   registerSheetsBridge(host, { adapter });
 *   const result = await host.callTool("sheet_set_cell", { address: "B3", value: 42 });
 *
 * Pair with a MicroMcpServer in the same app to expose the same tools
 * to remote agents over SSE while in-process agents still get
 * zero-overhead direct calls.
 */
export class ToolRegistry implements ToolHost {
  protected readonly tools = new Map<string, RegisteredTool>();

  /**
   * Tools that existed and were withdrawn, kept so a call that races an unmount
   * can say WHICH thing happened.
   *
   * The tool surface is dynamic by design — "site tools always, page tools while
   * mounted" — so an agent deciding to call a tool while the human navigates
   * away is normal traffic, not an edge case. Reporting that as `Unknown tool`
   * is the least useful thing available: it reads as "the agent is broken" or
   * "you asked for something imaginary", when the truth is "that surface just
   * closed".
   *
   * Names only. Nothing about the handler is retained, so this cannot keep a
   * disposed surface alive.
   */
  protected readonly withdrawn = new Set<string>();

  registerTool(definition: ToolDefinition, handler: ToolHandler): () => void {
    this.tools.set(definition.name, { definition, handler });
    // A remounted surface must stop apologising for a previous unmount.
    this.withdrawn.delete(definition.name);
    this.onToolsChanged();
    return () => {
      if (this.tools.delete(definition.name)) {
        this.withdrawn.add(definition.name);
        this.onToolsChanged();
      }
    };
  }

  /** Why `name` is not callable, phrased for whoever has to act on it. */
  protected missingToolMessage(name: string): string {
    return this.withdrawn.has(name)
      ? `Tool "${name}" was withdrawn: the surface it targets is no longer mounted. `
        + `Call tools/list for the current surface — the site-wide tools remain available.`
      : `Unknown tool: ${name}`;
  }

  getTool(name: string): RegisteredTool | null {
    return this.tools.get(name) ?? null;
  }

  listTools(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  async callTool(name: string, args: JsonObject = {}): Promise<CallToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(this.missingToolMessage(name));
    }
    return tool.handler(args);
  }

  /**
   * Hook for subclasses (e.g. MicroMcpServer) to notify subscribers
   * when the tool catalog changes. Default no-op.
   */
  protected onToolsChanged(): void {}
}
