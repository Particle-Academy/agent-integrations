/**
 * Shared plumbing for bridges whose adapter mutators may commit asynchronously
 * (screens since 0.49.0, forms since 0.52.0). Internal: not an entry point.
 *
 * The contract: a mutator returns `void` (sync, unchanged behaviour) or a
 * Promise resolving to `void` or `{ ok: true } | { ok: false; error }`. The
 * bridge awaits it, and only an accepted commit counts as success.
 */

/** What an async mutator may resolve to, to acknowledge or refuse a commit. */
export type HostCommitResult = { ok: true } | { ok: false; error: string; code?: string };

export type CommitOutcome = { ok: true } | { ok: false; error: string };

/**
 * The agent-facing text for a host failure. Only the message is used — never
 * `stack`, which carries file paths — matching the other bridges. A message
 * that itself embeds stack frames is cut at the first frame. A non-Error
 * rejection (a plain object, a response) has no reliable message, so it gets
 * the fallback rather than "[object Object]".
 */
export function hostErrorMessage(e: unknown, fallback: string): string {
  let msg: string | undefined;
  if (e instanceof Error) msg = e.message;
  else if (typeof e === "string") msg = e;
  else if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    msg = (e as { message: string }).message;
  }
  const firstFrame = msg ? msg.search(/\n\s+at\s/) : -1;
  if (msg && firstFrame >= 0) msg = msg.slice(0, firstFrame);
  msg = msg?.trim();
  return msg ? msg : fallback;
}

/** Run one adapter commit, await it, and normalise every way it can fail. Never rejects. */
export async function commit(
  run: () => void | Promise<void | HostCommitResult>,
  fallback: string,
): Promise<CommitOutcome> {
  try {
    const r = await run();
    if (r && typeof r === "object" && r.ok === false) {
      return { ok: false, error: hostErrorMessage(r.error, fallback) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: hostErrorMessage(e, fallback) };
  }
}
