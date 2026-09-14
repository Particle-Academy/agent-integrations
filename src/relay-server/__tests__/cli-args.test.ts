// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseRelayArgs } from "../args";

/**
 * How `agent-integrations-relay` resolves its settings: FLAG, then ENV VAR,
 * then DEFAULT — for every setting, CORS included.
 *
 * The relay's own README once told operators to "set CORS_ALLOW_ORIGIN to
 * override the start-script default", while the start script passed `--cors`,
 * which has always won. So the documented knob did nothing and nothing said so.
 *
 * Flag-over-env is kept rather than inverted, because it is the rule every
 * other setting already follows and the one container images rely on: the
 * Dockerfile sets `HOST=0.0.0.0`, and `docker run … --host 127.0.0.1` must mean
 * what it says. What changes is that a losing env var is REPORTED instead of
 * being silently ignored.
 */

function ok(argv: string[], env: Record<string, string | undefined> = {}) {
  const result = parseRelayArgs(argv, env);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.config;
}

describe("defaults", () => {
  it("binds loopback on 8787 with `*` CORS and a 4h TTL", () => {
    const config = ok([]);

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
    expect(config.prefix).toBe("");
    expect(config.ttlMs).toBe(4 * 60 * 60 * 1000);
    expect(config.cors).toEqual({ kind: "any" });
    expect(config.sources.cors).toBe("default");
    expect(config.warnings).toEqual([]);
  });
});

describe("CORS", () => {
  it("--cors takes a comma-separated list", () => {
    const config = ok(["--cors", "https://particle.academy,https://www.particle.academy"]);

    expect(config.cors).toEqual({
      kind: "list",
      origins: ["https://particle.academy", "https://www.particle.academy"],
    });
    expect(config.sources.cors).toBe("flag");
  });

  it("--cors may be repeated, and the values add up", () => {
    const config = ok(["--cors", "https://particle.academy", "--cors", "https://www.particle.academy"]);

    expect(config.cors).toEqual({
      kind: "list",
      origins: ["https://particle.academy", "https://www.particle.academy"],
    });
  });

  it("CORS_ALLOW_ORIGIN applies when no --cors is passed", () => {
    const config = ok([], { CORS_ALLOW_ORIGIN: "https://a.example, https://b.example" });

    expect(config.cors).toEqual({ kind: "list", origins: ["https://a.example", "https://b.example"] });
    expect(config.sources.cors).toBe("env");
  });

  it("--cors wins over CORS_ALLOW_ORIGIN — and says the env var was ignored", () => {
    const config = ok(["--cors", "https://a.example"], { CORS_ALLOW_ORIGIN: "https://b.example" });

    expect(config.cors).toEqual({ kind: "list", origins: ["https://a.example"] });
    expect(config.sources.cors).toBe("flag");
    expect(config.warnings.join("\n")).toMatch(/CORS_ALLOW_ORIGIN.*ignored.*--cors/);
  });

  it("does not warn when the flag and the env var agree", () => {
    const config = ok(["--cors", "https://a.example"], { CORS_ALLOW_ORIGIN: "https://a.example" });

    expect(config.warnings).toEqual([]);
  });

  it("treats an empty env var as unset, the way platform env editors write one", () => {
    const config = ok([], { CORS_ALLOW_ORIGIN: "" });

    expect(config.cors).toEqual({ kind: "any" });
    expect(config.sources.cors).toBe("default");
  });

  it("rejects an invalid --cors instead of starting with a policy nobody wrote", () => {
    const result = parseRelayArgs(["--cors", "*,https://a.example"], {});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--cors/);
  });

  it("rejects an invalid CORS_ALLOW_ORIGIN, naming the env var", () => {
    const result = parseRelayArgs([], { CORS_ALLOW_ORIGIN: "not-an-origin" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/CORS_ALLOW_ORIGIN/);
  });
});

describe("the same precedence for every other setting", () => {
  it("env vars apply without flags", () => {
    const config = ok([], { PORT: "9000", HOST: "0.0.0.0", PREFIX: "/relay", TTL_MS: "60000" });

    expect(config).toMatchObject({ port: 9000, host: "0.0.0.0", prefix: "/relay", ttlMs: 60000 });
    expect(config.sources).toMatchObject({ port: "env", host: "env", prefix: "env", ttlMs: "env" });
  });

  it("flags win over env vars, with a warning per ignored env var", () => {
    const config = ok(["--port", "9001", "--host", "127.0.0.1"], { PORT: "9000", HOST: "0.0.0.0" });

    expect(config).toMatchObject({ port: 9001, host: "127.0.0.1" });
    expect(config.warnings).toHaveLength(2);
    expect(config.warnings.join("\n")).toMatch(/HOST=0\.0\.0\.0.*ignored.*--host/);
  });

  it("rejects an invalid port", () => {
    expect(parseRelayArgs(["--port", "nope"], {}).ok).toBe(false);
    expect(parseRelayArgs([], { PORT: "-1" }).ok).toBe(false);
  });

  it("rejects a flag with no value", () => {
    const result = parseRelayArgs(["--cors"], {});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--cors/);
  });

  it("rejects an unknown flag", () => {
    const result = parseRelayArgs(["--nope"], {});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--nope/);
  });

  it("reports --help", () => {
    expect(ok(["--help"]).help).toBe(true);
    expect(ok(["-h"]).help).toBe(true);
  });
});
