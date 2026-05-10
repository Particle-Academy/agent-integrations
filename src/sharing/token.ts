/**
 * Session-token utilities. The token is a high-entropy secret; possession
 * grants read/write on the session. We don't HMAC frames — frames carry
 * the token directly (which is fine for in-process / same-origin / TLS
 * transports). For lower-trust transports, host apps can layer signing
 * on top of the BroadcastChannelTransport.
 */

const TOKEN_BYTES = 24; // 192 bits, base64url-encoded → 32 chars

export type SessionDescriptor = {
  /** Stable session identifier. Channel name = `fai:share:${id}`. */
  id: string;
  /** Secret token. Treat as a password — anyone with it can read/write. */
  token: string;
  /** Pretty hash for display (first 8 chars of token). */
  display: string;
};

export function createSessionDescriptor(): SessionDescriptor {
  const id = randomId(8);
  const token = randomToken();
  return { id, token, display: token.slice(0, 8) };
}

export function describeSession(id: string, token: string): SessionDescriptor {
  return { id, token, display: token.slice(0, 8) };
}

/** Build the shareable URL for the current page (preserves path, adds session+token). */
export function buildShareUrl(
  descriptor: SessionDescriptor,
  baseUrl: string = typeof window !== "undefined" ? window.location.href.split("?")[0] : "",
): string {
  const u = new URL(baseUrl);
  u.searchParams.set("session", descriptor.id);
  u.searchParams.set("token", descriptor.token);
  return u.toString();
}

/** Build the JSON config form (suitable for Claude Desktop / Cline / etc.). */
export function buildShareConfig(descriptor: SessionDescriptor, transport = "broadcast-channel") {
  return {
    name: `whiteboard-${descriptor.id}`,
    transport,
    session: descriptor.id,
    token: descriptor.token,
    channel: `fai:share:${descriptor.id}`,
    protocol_version: "2025-06-18",
  };
}

/** Read session descriptor from current URL, or null if not a shared link. */
export function readSessionFromUrl(): SessionDescriptor | null {
  if (typeof window === "undefined") return null;
  const params = new URL(window.location.href).searchParams;
  const id = params.get("session");
  const token = params.get("token");
  if (!id || !token) return null;
  return describeSession(id, token);
}

function randomToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function randomId(len: number): string {
  const bytes = new Uint8Array(Math.ceil((len * 3) / 4));
  crypto.getRandomValues(bytes);
  return base64Url(bytes).slice(0, len);
}

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time string compare so a mismatched token leaks no timing info. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
