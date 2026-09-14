import { describeCorsPolicy, parseCorsOrigins, type CorsPolicy } from "./cors";

/**
 * Settings resolution for `agent-integrations-relay`.
 *
 * **Precedence, for every setting: flag, then env var, then default.** A flag
 * is what the person starting the process typed; an env var is ambient and is
 * often set by a platform (Forge sets `PORT`; this package's Dockerfile sets
 * `HOST=0.0.0.0`), so the explicit one wins. When a flag overrides an env var
 * that is also set to something different, the override is reported in
 * `warnings` rather than applied silently — the relay's own deploy README once
 * told operators to set `CORS_ALLOW_ORIGIN` to override a start script that
 * passed `--cors`, and nothing ever said the env var was being ignored.
 *
 * An env var set to the empty string counts as unset, which is how platform
 * env editors write a cleared value.
 */

export type SettingSource = "flag" | "env" | "default";

export type RelayCliConfig = {
  port: number;
  host: string;
  prefix: string;
  ttlMs: number;
  cors: CorsPolicy;
  sources: { port: SettingSource; host: SettingSource; prefix: SettingSource; ttlMs: SettingSource; cors: SettingSource };
  warnings: string[];
  help: boolean;
};

export type ParseResult = { ok: true; config: RelayCliConfig } | { ok: false; error: string };

type Key = "port" | "host" | "prefix" | "ttlMs" | "cors";

const SETTINGS: Record<Key, { flag: string; env: string; fallback: string }> = {
  port: { flag: "--port", env: "PORT", fallback: "8787" },
  // Loopback by default: this relay fronts terminal_run (RCE) and register is
  // unauthenticated, so it must not listen on all interfaces unless the
  // operator explicitly opts in with --host 0.0.0.0.
  host: { flag: "--host", env: "HOST", fallback: "127.0.0.1" },
  prefix: { flag: "--prefix", env: "PREFIX", fallback: "" },
  ttlMs: { flag: "--ttl-ms", env: "TTL_MS", fallback: String(4 * 60 * 60 * 1000) },
  cors: { flag: "--cors", env: "CORS_ALLOW_ORIGIN", fallback: "*" },
};

export function parseRelayArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): ParseResult {
  const flags: Partial<Record<Key, string>> = {};
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }

    const key = (Object.keys(SETTINGS) as Key[]).find((k) => SETTINGS[k].flag === arg);
    if (!key) return { ok: false, error: `unknown flag: ${arg}` };

    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, error: `${arg} needs a value` };
    i++;

    // --cors is a LIST, so repeating it adds origins. Every other flag is a
    // single value, and the last one given wins.
    flags[key] = key === "cors" && flags.cors !== undefined ? `${flags.cors},${value}` : value;
  }

  const warnings: string[] = [];
  const raw = {} as Record<Key, string>;
  const sources = {} as Record<Key, SettingSource>;

  for (const key of Object.keys(SETTINGS) as Key[]) {
    const { flag, env: envName, fallback } = SETTINGS[key];
    const fromEnv = env[envName] === "" ? undefined : env[envName];
    const fromFlag = flags[key];

    if (fromFlag !== undefined) {
      raw[key] = fromFlag;
      sources[key] = "flag";
      if (fromEnv !== undefined && fromEnv !== fromFlag) {
        warnings.push(`${envName}=${fromEnv} is ignored: ${flag} ${fromFlag} was passed, and a flag wins over its env var.`);
      }
    } else if (fromEnv !== undefined) {
      raw[key] = fromEnv;
      sources[key] = "env";
    } else {
      raw[key] = fallback;
      sources[key] = "default";
    }
  }

  const named = (key: Key) => (sources[key] === "env" ? SETTINGS[key].env : SETTINGS[key].flag);

  const port = Number(raw.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, error: `invalid ${named("port")}: ${raw.port}` };
  }

  const ttlMs = Number(raw.ttlMs);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    return { ok: false, error: `invalid ${named("ttlMs")}: ${raw.ttlMs}` };
  }

  let cors: CorsPolicy;
  try {
    cors = parseCorsOrigins(raw.cors);
  } catch (e) {
    return { ok: false, error: `invalid ${named("cors")}: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Same-value warnings compare raw strings; compare the parsed policies too, so
  // `--cors "https://a,https://b"` against `CORS_ALLOW_ORIGIN="https://a, https://b"`
  // is not reported as a conflict.
  if (sources.cors === "flag" && env.CORS_ALLOW_ORIGIN) {
    try {
      if (describeCorsPolicy(parseCorsOrigins(env.CORS_ALLOW_ORIGIN)) === describeCorsPolicy(cors)) {
        const i = warnings.findIndex((w) => w.startsWith("CORS_ALLOW_ORIGIN="));
        if (i !== -1) warnings.splice(i, 1);
      }
    } catch {
      /* an unparseable env var that lost to the flag stays reported */
    }
  }

  return {
    ok: true,
    config: {
      port,
      host: raw.host,
      prefix: raw.prefix,
      ttlMs,
      cors,
      sources: sources as RelayCliConfig["sources"],
      warnings,
      help,
    },
  };
}
