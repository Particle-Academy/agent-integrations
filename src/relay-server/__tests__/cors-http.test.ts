// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createNodeRelay } from "../node";
import { call, register, startRelay, TOKEN, type RunningRelay } from "./http";

/**
 * CORS: a list of origins has to mean a list of origins.
 *
 * `Access-Control-Allow-Origin` holds exactly ONE origin, or `*`. The relay
 * documented `corsAllowOrigin` as "comma-separated origins (or `*`)" and then
 * sent the string verbatim, so the Particle Academy relay's
 * `--cors "https://particle.academy,https://www.particle.academy"` produced a
 * header no browser matches — every cross-origin read from either site failed,
 * and nothing on the server said so.
 *
 * The contract now: a listed Origin is echoed back, `Vary: Origin` tells caches
 * the answer depends on who asked, an unlisted Origin gets NO allow-origin
 * header at all, and `*` stays `*` because someone wrote `*`.
 */

let running: RunningRelay | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

const LIST = "https://particle.academy,https://www.particle.academy";

describe("a comma-separated origin list", () => {
  it("echoes back a listed Origin, not the whole list", async () => {
    running = await startRelay({ corsAllowOrigin: LIST });

    const res = await call(`${running.base}/register`, {
      method: "OPTIONS",
      headers: { origin: "https://www.particle.academy", "access-control-request-method": "POST" },
    });

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://www.particle.academy");
  });

  it("echoes the OTHER listed origin for a request from it", async () => {
    running = await startRelay({ corsAllowOrigin: LIST });

    const res = await call(`${running.base}/register`, {
      method: "POST",
      headers: { origin: "https://particle.academy", "content-type": "application/json" },
      body: JSON.stringify({ session: "cors-1", token: TOKEN }),
    });

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://particle.academy");
  });

  it("says Vary: Origin, so a cache cannot hand one site's answer to the other", async () => {
    running = await startRelay({ corsAllowOrigin: LIST });

    const res = await call(`${running.base}/register`, {
      method: "OPTIONS",
      headers: { origin: "https://particle.academy" },
    });

    expect(String(res.headers["vary"] ?? "").toLowerCase()).toContain("origin");
  });

  it("NEVER reflects an unlisted origin", async () => {
    running = await startRelay({ corsAllowOrigin: LIST });

    const res = await call(`${running.base}/register`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(String(res.headers["vary"] ?? "").toLowerCase()).toContain("origin");
  });

  it("does not answer `null` for an unlisted origin — a sandboxed iframe's Origin IS `null`", async () => {
    // Emitting `Access-Control-Allow-Origin: null` as the "matches nothing"
    // value is the classic mistake: every sandboxed iframe and file:// page
    // sends `Origin: null`, so that header grants exactly the pages least
    // entitled to it.
    running = await startRelay({ corsAllowOrigin: LIST });

    const res = await call(`${running.base}/register`, { method: "OPTIONS", headers: { origin: "null" } });

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("tolerates spaces after the commas and a trailing slash on an entry", async () => {
    running = await startRelay({ corsAllowOrigin: "https://a.example/ ,  https://b.example" });

    const a = await call(`${running.base}/register`, { method: "OPTIONS", headers: { origin: "https://a.example" } });
    const b = await call(`${running.base}/register`, { method: "OPTIONS", headers: { origin: "https://b.example" } });

    expect(a.headers["access-control-allow-origin"]).toBe("https://a.example");
    expect(b.headers["access-control-allow-origin"]).toBe("https://b.example");
  });

  it("applies to the session routes too, not just register", async () => {
    running = await startRelay({ corsAllowOrigin: LIST });
    await register(running.base, "cors-2");

    const inbox = await call(`${running.base}/cors-2/inbox?token=${TOKEN}`, {
      method: "POST",
      headers: { origin: "https://particle.academy", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/x" }),
    });
    const poll = await call(`${running.base}/cors-2/poll?token=${TOKEN}&wait=0`, {
      headers: { origin: "https://www.particle.academy" },
    });

    expect(inbox.headers["access-control-allow-origin"]).toBe("https://particle.academy");
    expect(poll.headers["access-control-allow-origin"]).toBe("https://www.particle.academy");
  });
});

describe("`*`", () => {
  it("is still the default, and is sent as `*`", async () => {
    running = await startRelay();

    const res = await call(`${running.base}/register`, { method: "OPTIONS", headers: { origin: "https://any.example" } });

    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("is sent as `*` when asked for explicitly", async () => {
    running = await startRelay({ corsAllowOrigin: "*" });

    const res = await call(`${running.base}/register`, { method: "OPTIONS", headers: { origin: "https://any.example" } });

    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("cannot be mixed into a list — that is two policies, and the relay will not guess", () => {
    expect(() => createNodeRelay({ corsAllowOrigin: "*,https://a.example", reapIntervalMs: 0 })).toThrow(/\*/);
  });
});

describe("allowedOrigins (the array form)", () => {
  it("echoes a listed origin", async () => {
    running = await startRelay({ allowedOrigins: ["https://a.example"] });

    const res = await call(`${running.base}/register`, { method: "OPTIONS", headers: { origin: "https://a.example" } });

    expect(res.headers["access-control-allow-origin"]).toBe("https://a.example");
    expect(String(res.headers["vary"] ?? "").toLowerCase()).toContain("origin");
  });

  it("sends no allow-origin header for an unlisted origin (it used to send `null`)", async () => {
    running = await startRelay({ allowedOrigins: ["https://a.example"] });

    const res = await call(`${running.base}/register`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("wins over corsAllowOrigin, as documented", async () => {
    running = await startRelay({ allowedOrigins: ["https://a.example"], corsAllowOrigin: "*" });

    const res = await call(`${running.base}/register`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
