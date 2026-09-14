/**
 * CORS policy for the relay: `*`, or an allowlist of origins.
 *
 * `Access-Control-Allow-Origin` carries exactly ONE origin or `*` — a browser
 * matches the header's value against its own origin and nothing else. So a list
 * cannot be sent as a list. It has to be checked per request: echo the request's
 * `Origin` back when it is listed, send `Vary: Origin` so a cache does not hand
 * one origin's answer to another, and send no allow-origin header at all when
 * the origin is not listed.
 *
 * Not `null` for "matches nothing": sandboxed iframes and `file://` pages send
 * `Origin: null`, so that value grants exactly the pages least entitled to it.
 */

export type CorsPolicy = { kind: "any" } | { kind: "list"; origins: string[] };

/**
 * Parse `*`, a comma-separated origin list, or an array of origins.
 *
 * Throws on anything that is not unambiguously one of those — an empty value,
 * `*` mixed with named origins, `null`, or an entry with a path — because a
 * relay that starts with a policy nobody wrote fails later, in a browser, where
 * the operator cannot see why.
 */
export function parseCorsOrigins(value: string | readonly string[]): CorsPolicy {
  const entries = (typeof value === "string" ? value.split(",") : [...value])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    throw new Error("CORS origin list is empty: pass `*` or one or more origins, e.g. https://example.com");
  }

  if (entries.includes("*")) {
    if (entries.length === 1) return { kind: "any" };
    throw new Error(
      "CORS `*` cannot be combined with named origins — `*` already allows every origin, so the list would mean nothing. Pass either `*` or the origins.",
    );
  }

  const origins: string[] = [];
  for (const entry of entries) {
    const origin = normalizeOrigin(entry);
    if (!origins.includes(origin)) origins.push(origin);
  }

  return { kind: "list", origins };
}

/**
 * The form a browser sends in `Origin`: lower-case scheme and host, no default
 * port, no path. One trailing slash is forgiven, since that is how origins get
 * copied out of an address bar.
 */
function normalizeOrigin(raw: string): string {
  if (raw.toLowerCase() === "null") {
    throw new Error("CORS origin `null` is refused: it is what sandboxed iframes and file:// pages send.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`CORS origin "${raw}" is not an origin — expected scheme://host[:port], e.g. https://example.com`);
  }

  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.username || url.password) {
    throw new Error(`CORS origin "${raw}" has a path, query or credentials — an origin is only scheme://host[:port]`);
  }

  // Special schemes (http, https, …) have a tuple origin; `URL` serialises it.
  if (url.origin !== "null") return url.origin;

  // A non-special scheme (chrome-extension://id, …) has no tuple origin in the
  // URL spec, but a browser still sends scheme://host for it.
  if (url.host) return `${url.protocol}//${url.host}`;

  throw new Error(`CORS origin "${raw}" is not an origin — expected scheme://host[:port], e.g. https://example.com`);
}

/** The allow-origin value for one request, or `null` for "send none". */
export function allowOriginFor(policy: CorsPolicy, requestOrigin: string | undefined): string | null {
  if (policy.kind === "any") return "*";
  return requestOrigin !== undefined && policy.origins.includes(requestOrigin) ? requestOrigin : null;
}

/** Human-readable policy, for a startup log line. */
export function describeCorsPolicy(policy: CorsPolicy): string {
  return policy.kind === "any" ? "*" : policy.origins.join(",");
}
