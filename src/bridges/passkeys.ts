import { textResult, errorResult } from "../mcp/server";
import type { ToolHost } from "../mcp/tool-host";
import type { JsonObject } from "../mcp/types";
import type { Bridge } from "./types";
import { wrapToolWithActivity } from "../presence/wrap-tool-with-activity";
import type { AgentTarget } from "../presence/types";
import { pushUndoEntry } from "../undo/undo-stack";
import { ensureUndoToolsRegistered } from "../undo/undo-tools";

/**
 * Bridge for `@particle-academy/fancy-passkeys-ui` — the **management** half of
 * a passkey (WebAuthn) surface, and only that half.
 *
 * ## The absence is the design
 *
 * There is **no tool here that completes an authentication or registration
 * ceremony**, and there must never be one. Not `passkey_authenticate`, not
 * `passkey_sign_in`, not `passkey_complete`, not a "headless" variant behind a
 * flag.
 *
 * The reason is construction, not policy. `navigator.credentials.get()` requires
 * a user gesture and a biometric or PIN — both things only the person at the
 * keyboard has. An agent-drivable passkey login would be a bypass of the exact
 * property that makes a passkey worth more than a password: that possession of
 * the credential cannot be delegated, replayed, or phished. A bridge offering
 * one would quietly turn a phishing-resistant factor back into a bearer token.
 *
 * So the boundary sits where the cryptography already puts it, and the tool set
 * is drawn to match: **read the management surface, rename, propose, ask the
 * human to start a ceremony.** `bridges/__tests__/passkeys.test.ts` asserts the
 * registered tool names against a closed list, so "finishing" this bridge with a
 * sign-in tool fails CI rather than shipping.
 *
 * ## What it does do
 *
 *   passkey_list              the user's credentials (whitelisted fields only)
 *   passkey_status            browser support + what the surface currently shows
 *   passkey_rename            relabel one credential, by credential ID (undoable)
 *   passkey_revoke            **STAGES** a revoke for the human to confirm
 *   passkey_begin_enrollment  opens the enrollment prompt; returns immediately
 *
 * `passkey_revoke` never revokes. Revoking a passkey is destructive and revoking
 * the last one is a lockout, so the confirming click comes from the human at the
 * surface — there is deliberately **no `pendingMode: false`**, no `confirm: true`
 * argument, and no host hook that turns staging off. On this bridge staging is
 * not a mode.
 *
 * The adapter type is declared LOCALLY (like `features` / `catalog`) so the
 * bridge builds and type-checks with the sibling package absent. A host wiring a
 * live `PasskeyManager` satisfies it structurally, with no import.
 */

/**
 * One credential as the bridge is willing to describe it — the `PasskeySummary`
 * shape both passkey backends already serialise.
 *
 * Everything the server stores that is NOT on this list — the COSE public key,
 * the user handle, the signature counter, the attestation statement and trust
 * path — is absent on purpose, and {@link toSummary} re-projects onto exactly
 * these keys rather than trusting the adapter to have withheld them. A host that
 * hands `list()` its raw ORM model (the obvious thing to do) therefore cannot
 * leak credential material through an MCP tool by accident.
 */
export type PasskeySummaryLike = {
  /** base64url credential ID — the handle every action here is keyed by. */
  id: string;
  /** Human-chosen label, or null when the user never named it. */
  name: string | null;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601, or null when never used to sign in. */
  lastUsedAt: string | null;
  /** Transport hints ("internal", "hybrid", "usb", …). */
  transports: string[];
  /** True for a synced passkey (BE/BS flags); false means this device only. */
  backedUp: boolean;
  /** Authenticator model id. Stored, never a trust decision. */
  aaguid: string;
  /** ISO-8601 when the signature counter regressed — a suspected clone. */
  clonedAt: string | null;
};

/** What the browser can do, as the three `./client` predicates report it. */
export type PasskeySupport = {
  supported: boolean;
  /** Touch ID / Windows Hello present? `null` while unknown. */
  platformAuthenticator?: boolean | null;
  /** Can the browser offer a passkey from a username field? `null` while unknown. */
  conditionalUi?: boolean | null;
};

/** A read of what the management surface is currently showing. */
export type PasskeySurfaceState = {
  status?: "idle" | "busy" | "error";
  /** `{ code, message }` as carried in surface state — never an Error. */
  error?: { code: string; message: string } | null;
  /** The revoke awaiting a human's confirmation, if any. */
  pendingRevoke?: { id: string; isLastPasskey: boolean } | null;
  /** Credential ID currently being renamed, if any. */
  renamingId?: string | null;
};

/**
 * Host-provided access to the management surface. Mirrors the props a
 * `PasskeyManager` is already wired with, so a host usually passes the same four
 * callbacks it passed the component.
 */
export type PasskeyBridgeAdapter = {
  /** Stable id for this surface instance. Surfaces in activity logs. */
  id?: string;
  title?: string;
  screenId?: string;

  /** The signed-in user's credentials. */
  list(): PasskeySummaryLike[] | Promise<PasskeySummaryLike[]>;

  /** Relabel one credential. Cosmetic, reversible, and undoable here. */
  rename(input: { id: string; name: string }): void | Promise<void>;

  /**
   * **Stage** a revoke for human confirmation — the `pendingRevoke` the surface
   * renders a confirm/cancel dialog for. It must NOT revoke; a host that wires
   * this to a delete call has removed the human from the loop the bridge was
   * built around.
   */
  proposeRevoke(input: { id: string }): PasskeyProposal | Promise<PasskeyProposal>;

  /**
   * Open the enrollment prompt on the human's screen and return immediately.
   * The ceremony completes on their authenticator or not at all.
   */
  beginEnrollment?(input: { name?: string }): void | Promise<void>;

  /** Browser capability flags, if the host tracks them. */
  support?(): PasskeySupport | Promise<PasskeySupport>;

  /** What the surface currently shows. */
  state?(): PasskeySurfaceState | Promise<PasskeySurfaceState>;
};

export type PasskeyProposal = { staged: true; isLastPasskey: boolean };

export type PasskeyBridgeOptions = {
  adapter: PasskeyBridgeAdapter;
  agent?: { id: string; name?: string; color?: string };
  /**
   * Also route `passkey_rename` through {@link confirm}. Off by default: a
   * rename is cosmetic, reversible and pushed onto the undo stack. Worth turning
   * on where the label itself carries trust — a rogue credential relabelled
   * "Glenn's iPhone" survives a human's audit of the list.
   */
  confirmRename?: boolean;
  /**
   * Host confirmation hook for renames, when {@link confirmRename} is on.
   *
   * Note there is no revoke case: a revoke is staged into the surface and
   * confirmed there, never through a hook the agent's own host supplies.
   */
  confirm?: (req: { action: "passkey_rename"; id: string; name: string }) => boolean | Promise<boolean>;
};

const DEFAULT_AGENT = { id: "agent", name: "Agent", color: "#a855f7" };

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/**
 * Project an adapter record onto exactly the public summary fields.
 *
 * Deliberately a whitelist and not a `delete` of known-bad keys: a blacklist has
 * to be updated every time a backend grows a column, and the failure mode of
 * forgetting is silently publishing credential material to every agent in the
 * session.
 */
function toSummary(record: PasskeySummaryLike): PasskeySummaryLike {
  return {
    id: str(record?.id),
    name: typeof record?.name === "string" ? record.name : null,
    createdAt: str(record?.createdAt),
    lastUsedAt: typeof record?.lastUsedAt === "string" ? record.lastUsedAt : null,
    transports: Array.isArray(record?.transports) ? record.transports.map((t) => String(t)) : [],
    backedUp: record?.backedUp === true,
    aaguid: str(record?.aaguid),
    clonedAt: typeof record?.clonedAt === "string" ? record.clonedAt : null,
  };
}

/**
 * The complete set of tools this bridge may ever register.
 *
 * Exported so the test suite — and anyone auditing what an agent can reach —
 * can assert the registered names against it rather than eyeballing the file.
 */
export const PASSKEY_BRIDGE_TOOLS = [
  "passkey_list",
  "passkey_status",
  "passkey_rename",
  "passkey_revoke",
  "passkey_begin_enrollment",
] as const;

/**
 * registerPasskeyBridge — MCP tools over a passkey **management** surface.
 *
 * Read the credential list, read browser support and surface state, rename a
 * credential, propose a revoke for the human to confirm, and ask for an
 * enrollment prompt. Nothing signs anyone in; see the file header for why that
 * is a property rather than a gap.
 */
export function registerPasskeyBridge(host: ToolHost, options: PasskeyBridgeOptions): Bridge {
  const { adapter } = options;
  const agent = { ...DEFAULT_AGENT, ...(options.agent ?? {}) };
  const surfaceId = adapter.id ?? "passkeys";
  const disposers: Array<() => void> = [];

  ensureUndoToolsRegistered(host, { defaultAgentId: agent.id });

  const target = (elementId?: string, label?: string): AgentTarget => ({
    kind: "custom",
    screenId: adapter.screenId,
    elementId,
    label: label ?? surfaceId,
  });

  const reg = (
    name: string,
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
          screenId: adapter.screenId,
          resolveTarget: ({ args }) => resolveTarget(args as JsonObject),
        })
      : wrapped;
    disposers.push(
      host.registerTool(
        {
          name,
          description,
          inputSchema: {
            type: "object",
            properties: properties as Record<string, never>,
            required,
            additionalProperties: false,
          },
        },
        final as never,
      ),
    );
  };

  const findById = async (id: string): Promise<PasskeySummaryLike | null> =>
    (await adapter.list()).map(toSummary).find((p) => p.id === id) ?? null;

  // ─── Read ────────────────────────────────────────────────────────────────

  reg(
    "passkey_list",
    "List the signed-in user's passkeys: credential id, label, when it was added and last used, transports, whether it is a synced passkey, and whether the server flagged it as a possible clone. Read-only. Public keys, user handles and signature counters are never returned.",
    {},
    [],
    async () => {
      const passkeys = (await adapter.list()).map(toSummary);
      return textResult(JSON.stringify(passkeys, null, 2), { passkeys, count: passkeys.length });
    },
    false,
  );

  reg(
    "passkey_status",
    "Read what this browser can do (passkey support, a built-in authenticator, autofill sign-in) and what the management surface is currently showing (busy/error, a revoke awaiting confirmation, a rename in progress).",
    {},
    [],
    async () => {
      const support = adapter.support ? await adapter.support() : null;
      const state = adapter.state ? await adapter.state() : null;
      const out = {
        support,
        state,
        // Said in the payload, not only in the docs: an agent reading this to
        // work out "how do I sign the user in" should find the answer here.
        canCompleteCeremony: false,
        note: "A passkey ceremony needs a user gesture and a biometric or PIN. No tool on this bridge can perform one; ask the human to complete it on their device.",
      };
      return textResult(JSON.stringify(out, null, 2), out);
    },
    false,
  );

  // ─── Rename (undoable) ───────────────────────────────────────────────────

  reg(
    "passkey_rename",
    "Rename one passkey, by credential id (from passkey_list). Cosmetic and undoable with agent_undo.",
    {
      id: { type: "string", description: "base64url credential id." },
      name: { type: "string", description: "New label, e.g. 'MacBook Touch ID'. Empty string clears it." },
    },
    ["id", "name"],
    async (args) => {
      const id = str(args.id);
      const name = str(args.name);
      if (!id) return errorResult("id is required.");

      const existing = await findById(id);
      if (!existing) return errorResult(`No passkey with id ${id}.`);

      if (options.confirmRename) {
        if (!options.confirm) {
          return errorResult(
            "passkey_rename requires confirmation (confirmRename), but the host wired no confirm hook.",
          );
        }
        const ok = await options.confirm({ action: "passkey_rename", id, name });
        if (!ok) return errorResult(`Declined: rename ${id} (human did not confirm).`);
      }

      const previous = existing.name ?? "";
      await adapter.rename({ id, name });
      pushUndoEntry(agent.id, {
        timestamp: Date.now(),
        bridgeId: surfaceId,
        action: "passkey_rename",
        label: `Renamed passkey to ${name || "(unnamed)"}`,
        undo: () => void adapter.rename({ id, name: previous }),
        redo: () => void adapter.rename({ id, name }),
      });

      return textResult(`Renamed passkey ${id} to ${name || "(unnamed)"}`, { id, name, previous });
    },
    (args) => target(str(args.id), `rename ${str(args.id)}`),
  );

  // ─── Revoke — PROPOSAL ONLY ──────────────────────────────────────────────

  reg(
    "passkey_revoke",
    "PROPOSE revoking one passkey. This does NOT revoke it: the request is staged on the surface and the human confirms or cancels there. Revoking the last passkey can lock the user out, and the response says when that is the case so you can tell them before they confirm.",
    { id: { type: "string", description: "base64url credential id." } },
    ["id"],
    async (args) => {
      const id = str(args.id);
      if (!id) return errorResult("id is required.");

      const existing = await findById(id);
      if (!existing) return errorResult(`No passkey with id ${id}.`);

      const proposal = await adapter.proposeRevoke({ id });
      const isLastPasskey = proposal?.isLastPasskey === true;
      const out = {
        id,
        name: existing.name,
        staged: true as const,
        awaitingHuman: true as const,
        isLastPasskey,
      };

      return textResult(
        isLastPasskey
          ? `Staged a revoke of ${existing.name ?? id}. This is the account's LAST passkey — confirming it removes passkey sign-in entirely. Waiting for the human to confirm or cancel.`
          : `Staged a revoke of ${existing.name ?? id}. Waiting for the human to confirm or cancel on the surface.`,
        out,
      );
    },
    (args) => target(str(args.id), `propose revoke ${str(args.id)}`),
  );

  // ─── Enrollment — opens the prompt, never completes it ───────────────────

  reg(
    "passkey_begin_enrollment",
    "Ask the surface to start enrolling a new passkey. This only opens the prompt: the ceremony completes on the human's authenticator (Touch ID, Windows Hello, phone, security key) or it does not complete at all. Returns immediately.",
    { name: { type: "string", description: "Optional label to pre-fill for the new passkey." } },
    [],
    async (args) => {
      if (!adapter.beginEnrollment) return errorResult("Host did not wire beginEnrollment().");
      const name = args.name === undefined ? undefined : str(args.name);
      await adapter.beginEnrollment(name === undefined ? {} : { name });
      const out = { awaitingHuman: true as const, ...(name === undefined ? {} : { name }) };
      return textResult(
        "Enrollment prompt opened. The human has to complete it on their authenticator — there is no tool that can finish it for them.",
        out,
      );
    },
    (args) => target(undefined, `begin enrollment${args.name ? ` (${str(args.name)})` : ""}`),
  );

  // ── There is deliberately NO tool below that completes a ceremony. ────────
  // No passkey_authenticate, no passkey_sign_in, no passkey_complete, no
  // passkey_assert. Do not "finish" this bridge by adding one — see the header,
  // and see the closed-tool-list test that will fail if you do.

  return {
    id: `passkeys:${surfaceId}`,
    title: adapter.title ?? "Passkeys",
    dispose: () => {
      for (const d of disposers.splice(0)) d();
    },
  };
}
