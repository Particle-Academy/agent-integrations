import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../../mcp/tool-host";
import {
  registerPasskeyBridge,
  PASSKEY_BRIDGE_TOOLS,
  type PasskeyBridgeAdapter,
  type PasskeySummaryLike,
} from "../passkeys";
import { resetAllUndoStacks } from "../../undo/undo-stack";

/**
 * An in-memory management surface standing in for a live `PasskeyManager`.
 *
 * `list()` deliberately returns records CARRYING SECRETS the real server also
 * holds — the COSE public key, the user handle, the signature counter — because
 * that is what a host passing its ORM model straight through would hand us. The
 * bridge is only safe if it re-projects.
 */
function makeAdapter() {
  const passkeys: Array<PasskeySummaryLike & Record<string, unknown>> = [
    {
      id: "cred-one",
      name: "MacBook Touch ID",
      createdAt: "2026-03-04T09:12:00Z",
      lastUsedAt: "2026-07-30T18:41:00Z",
      transports: ["internal", "hybrid"],
      backedUp: true,
      aaguid: "adce0002-35bc-c60a-648b-0b25f1f05503",
      clonedAt: null,
      // ── none of these may ever reach an agent ──
      publicKey: "pQECAyYgASFYIJ…",
      userHandle: "dXNlci1oYW5kbGU",
      signCount: 42,
      attestationType: "none",
      trustPath: { type: "empty" },
    },
    {
      id: "cred-two",
      name: "YubiKey 5C",
      createdAt: "2026-01-19T14:02:00Z",
      lastUsedAt: null,
      transports: ["usb", "nfc"],
      backedUp: false,
      aaguid: "cb69481e-8ff7-4039-93ec-0a2729a154a8",
      clonedAt: "2026-07-28T22:15:00Z",
      publicKey: "pQECAyYgASFYIKKK…",
      userHandle: "dXNlci1oYW5kbGU",
      signCount: 7,
    },
  ];

  const revoked: string[] = [];
  const staged: string[] = [];
  const enrollments: Array<string | undefined> = [];

  const adapter: PasskeyBridgeAdapter = {
    id: "test-passkeys",
    list: () => passkeys,
    rename: ({ id, name }) => {
      const record = passkeys.find((p) => p.id === id);
      if (record) record.name = name === "" ? null : name;
    },
    proposeRevoke: ({ id }) => {
      staged.push(id);
      return { staged: true, isLastPasskey: passkeys.length <= 1 };
    },
    beginEnrollment: ({ name }) => {
      enrollments.push(name);
    },
    support: () => ({ supported: true, platformAuthenticator: true, conditionalUi: false }),
    state: () => ({ status: "idle", error: null, pendingRevoke: null, renamingId: null }),
  };

  return { adapter, passkeys, revoked, staged, enrollments };
}

const text = (r: any) => r.content?.[0]?.text ?? "";
const sc = (r: any) => r.structuredContent;

describe("registerPasskeyBridge", () => {
  it("registers exactly the passkey_* tools it declares, plus the undo tools", () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    registerPasskeyBridge(host, { adapter: makeAdapter().adapter });

    const passkeyTools = host
      .listTools()
      .map((t) => t.name)
      .filter((n) => n.startsWith("passkey"))
      .sort();

    expect(passkeyTools).toEqual([...PASSKEY_BRIDGE_TOOLS].sort());
    expect(host.listTools().map((t) => t.name)).toContain("agent_undo");
  });

  /**
   * The load-bearing test in this file.
   *
   * An agent must never be able to sign a user in: a passkey ceremony needs a
   * user gesture and a biometric, and a tool that performed one would turn a
   * phishing-resistant factor back into a bearer token. The guarantee is only
   * as good as something that fails when someone "finishes" the bridge, so this
   * asserts the shape of the tool NAMES rather than trusting review.
   */
  it("exposes NO tool that can complete a ceremony", () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    registerPasskeyBridge(host, { adapter: makeAdapter().adapter });

    const forbidden = /authenticat|sign_?in|log_?in|complete|assert|ceremony|credentials_get|verify/i;
    const offenders = host
      .listTools()
      .filter((t) => t.name.startsWith("passkey"))
      .filter((t) => forbidden.test(t.name));

    expect(offenders.map((t) => t.name)).toEqual([]);
  });

  it("lists passkeys without ever leaking credential material", async () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    registerPasskeyBridge(host, { adapter: makeAdapter().adapter });

    const result = await host.callTool("passkey_list", {});
    const body = text(result);

    // The summary fields are all there…
    expect(sc(result).count).toBe(2);
    expect(sc(result).passkeys[0]).toEqual({
      id: "cred-one",
      name: "MacBook Touch ID",
      createdAt: "2026-03-04T09:12:00Z",
      lastUsedAt: "2026-07-30T18:41:00Z",
      transports: ["internal", "hybrid"],
      backedUp: true,
      aaguid: "adce0002-35bc-c60a-648b-0b25f1f05503",
      clonedAt: null,
    });

    // …and nothing the server keeps private survived the projection, in either
    // the structured payload or the text an agent actually reads.
    for (const secret of ["publicKey", "userHandle", "signCount", "attestationType", "trustPath"]) {
      expect(body).not.toContain(secret);
      expect(JSON.stringify(sc(result))).not.toContain(secret);
    }
    expect(body).not.toContain("dXNlci1oYW5kbGU");
  });

  it("reports support + surface state, and says plainly that it cannot sign anyone in", async () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    registerPasskeyBridge(host, { adapter: makeAdapter().adapter });

    const result = await host.callTool("passkey_status", {});
    expect(sc(result).support.supported).toBe(true);
    expect(sc(result).state.status).toBe("idle");
    expect(sc(result).canCompleteCeremony).toBe(false);
    expect(text(result)).toContain("biometric");
  });

  it("renames by credential id and undoes back to the previous label", async () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    const { adapter, passkeys } = makeAdapter();
    registerPasskeyBridge(host, { adapter });

    await host.callTool("passkey_rename", { id: "cred-two", name: "Backup key" });
    expect(passkeys.find((p) => p.id === "cred-two")!.name).toBe("Backup key");

    await host.callTool("agent_undo", {});
    expect(passkeys.find((p) => p.id === "cred-two")!.name).toBe("YubiKey 5C");
  });

  it("refuses to rename a credential it cannot find", async () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    const { adapter } = makeAdapter();
    const rename = vi.spyOn(adapter, "rename");
    registerPasskeyBridge(host, { adapter });

    const result = await host.callTool("passkey_rename", { id: "nope", name: "x" });
    expect((result as any).isError).toBe(true);
    expect(rename).not.toHaveBeenCalled();
  });

  it("gates renames behind the host confirm hook when confirmRename is on", async () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    const { adapter, passkeys } = makeAdapter();
    registerPasskeyBridge(host, { adapter, confirmRename: true, confirm: () => false });

    const result = await host.callTool("passkey_rename", { id: "cred-one", name: "Not mine" });
    expect((result as any).isError).toBe(true);
    expect(passkeys[0].name).toBe("MacBook Touch ID");
  });

  it("STAGES a revoke and never revokes — there is no confirm argument that would", async () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    const { adapter, passkeys, staged } = makeAdapter();
    registerPasskeyBridge(host, { adapter });

    const result = await host.callTool("passkey_revoke", { id: "cred-one" });

    expect(sc(result)).toMatchObject({ id: "cred-one", staged: true, awaitingHuman: true });
    expect(staged).toEqual(["cred-one"]);
    // Still there. The human confirms on the surface or it does not happen.
    expect(passkeys).toHaveLength(2);

    // `confirm: true` is the escape hatch other bridges have; here the schema
    // does not even accept it, so an agent cannot stumble into a direct revoke.
    const schema = host.getTool("passkey_revoke")!.definition.inputSchema as any;
    expect(Object.keys(schema.properties)).toEqual(["id"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("warns in the response when the staged revoke is the account's last passkey", async () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    const { adapter, passkeys } = makeAdapter();
    passkeys.splice(1); // one credential left
    registerPasskeyBridge(host, { adapter });

    const result = await host.callTool("passkey_revoke", { id: "cred-one" });
    expect(sc(result).isLastPasskey).toBe(true);
    expect(text(result)).toContain("LAST passkey");
  });

  it("opens an enrollment prompt and returns without waiting for the human", async () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    const { adapter, enrollments } = makeAdapter();
    registerPasskeyBridge(host, { adapter });

    const result = await host.callTool("passkey_begin_enrollment", { name: "Work laptop" });
    expect(sc(result)).toEqual({ awaitingHuman: true, name: "Work laptop" });
    expect(enrollments).toEqual(["Work laptop"]);
    expect(text(result)).toContain("no tool that can finish it");
  });

  it("disposes every tool it registered", () => {
    resetAllUndoStacks();
    const host = new ToolRegistry();
    const bridge = registerPasskeyBridge(host, { adapter: makeAdapter().adapter });

    expect(host.listTools().some((t) => t.name.startsWith("passkey"))).toBe(true);
    bridge.dispose();
    expect(host.listTools().some((t) => t.name.startsWith("passkey"))).toBe(false);
  });
});
