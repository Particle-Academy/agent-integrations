import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry, type ToolHost } from "../../mcp/tool-host";
import type { RegisteredTool, ToolDefinition } from "../../mcp/types";
import { resetAllUndoStacks } from "../../undo/undo-stack";
import { registerArtboardBridge } from "../artboard";
import { registerCatalogBridge } from "../catalog";
import { registerChartsBridge } from "../charts";
import { registerCmsBridge } from "../cms";
import { registerCodeBridge } from "../code";
import { registerFeaturesBridge } from "../features";
import { registerFilesBridge } from "../files";
import { registerFlowBridge } from "../flow";
import { registerFormBridge } from "../forms";
import { registerGitBridge } from "../git";
import { registerGridBridge } from "../grid";
import { registerMapBridge } from "../map";
import { registerNavigationBridge } from "../navigation";
import { registerPasskeyBridge } from "../passkeys";
import { registerSceneBridge } from "../scene";
import { registerScreenDocBridge } from "../screen-doc";
import { registerScreensBridge } from "../screens";
import { registerSheetsBridge } from "../sheets";
import { registerSlidesBridge } from "../slides";
import { registerTerminalBridge } from "../terminal";
import { registerTuiBridge } from "../tui";
import { registerWhiteboardBridge } from "../whiteboard";

/**
 * Which first-party bridges claim the same tool name?
 *
 * `registerTool` now refuses a name held by a different registrant, so two
 * first-party bridges that share a tool name can no longer be mounted on one
 * host. Before, the second silently took the name and the first became
 * unreachable. This census is the measurement: each bridge on a recording host
 * of its own, so a collision is SEEN rather than thrown on, and then every
 * bridge on one real registry, which is the claim an app actually relies on.
 *
 * The shared undo tools are excluded from the census on purpose: every bridge
 * ensures them, under one owner.
 */

const SHARED = new Set(["agent_undo", "agent_redo", "agent_history"]);

/** An adapter that answers anything, so a bridge can be constructed without its package. */
function anything(): any {
  const target = function () {};
  const proxy: any = new Proxy(target, {
    get: (_t, key) => {
      if (key === Symbol.toPrimitive) return () => "x";
      if (key === "then") return undefined;
      return proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

/** Each bridge, keyed by its entry point. Adapter ids are distinct per bridge kind. */
const BRIDGES: Record<string, (host: ToolHost) => unknown> = {
  registerArtboardBridge: (h) => registerArtboardBridge(h, { adapter: anything() } as never),
  registerCatalogBridge: (h) => registerCatalogBridge(h, { adapter: anything() } as never),
  registerChartsBridge: (h) => registerChartsBridge(h, { adapter: anything() } as never),
  registerCmsBridge: (h) => registerCmsBridge(h, { adapter: anything() } as never),
  registerCodeBridge: (h) => registerCodeBridge(h, { adapter: anything() } as never),
  registerFeaturesBridge: (h) => registerFeaturesBridge(h, { adapter: anything() } as never),
  registerFilesBridge: (h) => registerFilesBridge(h, { adapter: anything() } as never),
  registerFlowBridge: (h) => registerFlowBridge(h, { adapter: anything() } as never),
  registerFormBridge: (h) => registerFormBridge(h, { adapter: anything() } as never),
  registerGitBridge: (h) => registerGitBridge(h, { adapter: anything() } as never),
  registerGridBridge: (h) => registerGridBridge(h, { adapter: anything() } as never),
  registerMapBridge: (h) => registerMapBridge(h, { adapter: anything() } as never),
  registerNavigationBridge: (h) => registerNavigationBridge(h, { adapter: anything() } as never),
  registerPasskeyBridge: (h) => registerPasskeyBridge(h, { adapter: anything() } as never),
  registerSceneBridge: (h) => registerSceneBridge(h, { adapter: anything() } as never),
  registerScreenDocBridge: (h) => registerScreenDocBridge(h, { adapter: anything() } as never),
  registerScreensBridge: (h) => registerScreensBridge(h, { adapter: anything() } as never),
  registerSheetsBridge: (h) => registerSheetsBridge(h, { adapter: anything() } as never),
  registerSlidesBridge: (h) => registerSlidesBridge(h, { adapter: anything() } as never),
  registerTerminalBridge: (h) => registerTerminalBridge(h, { adapter: anything() } as never),
  registerTuiBridge: (h) =>
    registerTuiBridge(h, { registry: anything(), eventStore: anything(), appId: "census" } as never),
  registerWhiteboardBridge: (h) => registerWhiteboardBridge(h, { adapter: anything() } as never),
};

/** Records every registration and refuses none, so the census sees collisions instead of tripping on them. */
class RecordingHost implements ToolHost {
  readonly names: string[] = [];
  registerTool(definition: ToolDefinition): () => void {
    this.names.push(definition.name);
    return () => {};
  }
  getTool(): RegisteredTool | null {
    return null;
  }
  listTools(): ToolDefinition[] {
    return [];
  }
  async callTool(): Promise<never> {
    throw new Error("census host does not call tools");
  }
}

describe("first-party bridge tool-name census", () => {
  beforeEach(() => resetAllUndoStacks());

  it("covers every bridge entry point in src/bridges", () => {
    // A bridge added later must join the census, or a collision it introduces
    // goes unmeasured.
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const declared = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) => [...readFileSync(join(dir, f), "utf8").matchAll(/^export function (register\w+Bridge)\b/gm)].map((m) => m[1]))
      // The generic doc bridge is reached through cms + screen-doc, which fix its surface.
      .filter((name) => name !== "registerDocBridge")
      .sort();

    expect(Object.keys(BRIDGES).sort()).toEqual(declared);
  });

  it("no two bridges claim the same tool name", () => {
    const claims = new Map<string, string[]>();
    for (const [bridge, register] of Object.entries(BRIDGES)) {
      const host = new RecordingHost();
      register(host);
      expect(host.names.length, `${bridge} registered nothing`).toBeGreaterThan(0);
      for (const name of new Set(host.names)) {
        if (SHARED.has(name)) continue;
        claims.set(name, [...(claims.get(name) ?? []), bridge]);
      }
    }

    const collisions = [...claims].filter(([, by]) => by.length > 1).map(([name, by]) => `${name}: ${by.join(", ")}`);
    expect(collisions).toEqual([]);
  });

  it("every bridge mounts on ONE real registry without a refusal", () => {
    const host = new ToolRegistry();
    for (const [bridge, register] of Object.entries(BRIDGES)) {
      expect(() => register(host), bridge).not.toThrow();
    }
    for (const n of SHARED) expect(host.getTool(n)).not.toBeNull();
  });
});
