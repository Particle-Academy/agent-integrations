import { type CSSProperties, useState } from "react";

export type SimulateUsersButtonProps = {
  /** Endpoint that injects the fake active users. Default `/active-users/simulate`. */
  endpoint?: string;
  /** How many fake users to simulate (sent as `count`). Default `10`. */
  count?: number;
  /** Button label. Default `Simulate {count} active users`. */
  label?: string;
  /**
   * CSRF token sent as `X-CSRF-TOKEN`. If omitted, falls back to a
   * `<meta name="csrf-token">` on the page (the Laravel default).
   */
  csrfToken?: string;
  /** Called after a successful trigger. */
  onTriggered?: () => void;
  /** Called if the request fails. */
  onError?: (error: unknown) => void;
  className?: string;
  style?: CSSProperties;
};

function resolveCsrf(explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (typeof document === "undefined") return undefined;
  return document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content;
}

/**
 * A button that asks the host to inject N **fake** active users (injected
 * dummies, not real accounts) so the live ActiveUser stream / presence overlay
 * has something to animate in a demo. POSTs `{ count }` to `endpoint`.
 *
 * Self-contained (inline styles, no react-fancy dependency) so it drops into any
 * host. The fakes + their staggered activity are produced server-side; this
 * button only triggers them.
 */
export function SimulateUsersButton({
  endpoint = "/active-users/simulate",
  count = 10,
  label,
  csrfToken,
  onTriggered,
  onError,
  className,
  style,
}: SimulateUsersButtonProps) {
  const [busy, setBusy] = useState(false);

  async function trigger() {
    if (busy) return;
    setBusy(true);
    try {
      const token = resolveCsrf(csrfToken);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          ...(token ? { "X-CSRF-TOKEN": token } : {}),
        },
        credentials: "same-origin",
        body: JSON.stringify({ count }),
      });
      if (!res.ok) throw new Error(`Simulate request failed: ${res.status}`);
      onTriggered?.();
    } catch (err) {
      onError?.(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      data-fai-simulate-users=""
      className={["fai-simulate-users", className ?? ""].filter(Boolean).join(" ")}
      onClick={trigger}
      disabled={busy}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 14px",
        borderRadius: 8,
        border: "1px solid rgba(139,92,246,0.4)",
        background: busy ? "rgba(139,92,246,0.15)" : "rgba(139,92,246,0.1)",
        color: "#7c3aed",
        font: "inherit",
        fontSize: 13,
        fontWeight: 500,
        cursor: busy ? "progress" : "pointer",
        opacity: busy ? 0.7 : 1,
        ...style,
      }}
    >
      <span aria-hidden>{busy ? "⏳" : "✨"}</span>
      {label ?? `Simulate ${count} active users`}
    </button>
  );
}
