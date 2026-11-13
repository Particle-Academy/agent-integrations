// ───────────── Text safety ─────────────
//
// Shared by every bridge that hands an agent a string it did not author: a
// page's labels (navigation), a signer's decline reason or name (sign).
//
// The tool TEXT is what lands in the agent's context, so a line break inside a
// hostile string would let its author write their own lines there: a forged
// action, a forged heading, forged tool framing. Each such string is therefore
// rendered on ONE line, with C0/C1 controls and the Unicode line/paragraph
// separators replaced, and capped. (Control characters are tested by code
// point, so no escape sequence is involved.)
//
// Internal: not exported from the package barrel.

export const isControl = (code: number) =>
  code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;

/** One line, controls replaced by spaces, whitespace collapsed, capped at `max`. */
export function oneLine(value: unknown, max: number): string {
  const raw = typeof value === "string" ? value : value == null ? "" : String(value);
  // Bound the work on a hostile multi-megabyte string before scanning it.
  const bounded = raw.length > max * 4 ? raw.slice(0, max * 4) : raw;
  let out = "";
  for (const c of bounded) out += isControl(c.charCodeAt(0)) ? " " : c;
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? out.slice(0, max - 3) + "..." : out;
}
