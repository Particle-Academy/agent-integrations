import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import { registerFeaturesBridge, type FeaturesBridgeAdapter, type FeatureDefinition } from "../features";
import { resetAllUndoStacks } from "../../undo/undo-stack";

/**
 * A tiny in-memory feature manager standing in for a real fancy-features
 * `FeatureManager`. Boolean features only: a feature is "enabled" for a subject
 * when the subject is in a group that contains it. Enough to exercise the bridge
 * end-to-end (define → grant → check → revoke) without the sibling package.
 */
function makeAdapter() {
  const registry = new Map<string, FeatureDefinition>();
  // group key -> feature keys it grants
  const groups = new Map<string, string[]>([["pro", ["advanced-reports", "export"]]]);
  // subject key -> assigned group keys
  const assignments = new Map<string, Set<string>>();
  const keyOf = (s: unknown) => (s && typeof s === "object" && "id" in s ? String((s as any).id) : String(s));

  const groupsFor = (subject: unknown) => [...(assignments.get(keyOf(subject)) ?? [])];
  const featuresFor = (subject: unknown) => new Set(groupsFor(subject).flatMap((g) => groups.get(g) ?? []));

  const adapter: FeaturesBridgeAdapter = {
    id: "test-features",
    canAccess: (feature, subject) => featuresFor(subject).has(feature),
    remaining: () => null, // boolean features ⇒ no quota
    enabled: (subject) => [...featuresFor(subject)],
    registerFeature: (key, def) => registry.set(key, def),
    registryKeys: () => [...registry.keys()],
    definition: (key) => registry.get(key) ?? null,
    assignGroup: (subject, groupKey) => {
      const k = keyOf(subject);
      const set = assignments.get(k) ?? new Set<string>();
      set.add(groupKey);
      assignments.set(k, set);
    },
    detachGroup: (subject, groupKey) => { assignments.get(keyOf(subject))?.delete(groupKey); },
    listGroups: (subject) => groupsFor(subject),
  };
  return { adapter, registry, assignments };
}

const text = (r: any) => r.content?.[0]?.text ?? "";
const sc = (r: any) => r.structuredContent;

describe("registerFeaturesBridge", () => {
  it("registers the features_* tools plus undo tools", () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    registerFeaturesBridge(host, { adapter: makeAdapter().adapter });
    const names = host.listTools().map((t) => t.name);
    for (const n of [
      "features_list",
      "features_check",
      "features_explain",
      "features_define",
      "features_grant",
      "features_revoke",
      "features_groups",
      "features_consume",
      "agent_undo",
    ]) {
      expect(names).toContain(n);
    }
  });

  it("defines a feature into the registry", async () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    const { adapter, registry } = makeAdapter();
    registerFeaturesBridge(host, { adapter });

    await host.callTool("features_define", { key: "advanced-reports", type: "boolean", name: "Advanced reports" });
    expect(registry.has("advanced-reports")).toBe(true);
    expect(registry.get("advanced-reports")).toMatchObject({ type: "boolean", name: "Advanced reports" });
  });

  it("grant (confirmed) flips a subject's access; check + list reflect it", async () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    const { adapter, assignments } = makeAdapter();
    registerFeaturesBridge(host, { adapter });
    const subject = { id: "user-7" };

    // Before: no access.
    const before = await host.callTool("features_check", { feature: "advanced-reports", subject });
    expect(sc(before).allowed).toBe(false);

    // Grant via the "pro" group (confirmed).
    await host.callTool("features_grant", { subject, group: "pro", confirm: true });
    expect(assignments.get("user-7")?.has("pro")).toBe(true);

    const after = await host.callTool("features_check", { feature: "advanced-reports", subject });
    expect(sc(after).allowed).toBe(true);

    const list = await host.callTool("features_list", { subject });
    expect(sc(list).enabled).toContain("export");
  });

  it("stages features_grant in pendingMode until confirm:true", async () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    const { adapter, assignments } = makeAdapter();
    registerFeaturesBridge(host, { adapter }); // pendingMode defaults true
    const subject = "user-9";

    const staged = await host.callTool("features_grant", { subject, group: "pro" });
    expect(staged.isError).toBe(true);
    expect(text(staged)).toContain("staged");
    expect(assignments.get("user-9")).toBeUndefined();
  });

  it("revoke (confirmed) removes the group; undo restores it", async () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    const { adapter, assignments } = makeAdapter();
    registerFeaturesBridge(host, { adapter });
    const subject = "user-3";

    await host.callTool("features_grant", { subject, group: "pro", confirm: true });
    await host.callTool("features_revoke", { subject, group: "pro", confirm: true });
    expect(assignments.get("user-3")?.has("pro")).toBe(false);

    await host.callTool("agent_undo", {});
    expect(assignments.get("user-3")?.has("pro")).toBe(true);
  });

  it("features_consume reports ok:false when host wires no metering", async () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    const { adapter } = makeAdapter();
    registerFeaturesBridge(host, { adapter });
    const res = await host.callTool("features_consume", { feature: "ai-tokens", subject: "u" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("metering");
  });
});
