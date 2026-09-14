import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { createNodeRelay, type NodeRelay, type NodeRelayOptions } from "../node";

/**
 * A real relay on a real socket, for tests that assert what goes over the wire.
 *
 * `node:http` rather than `fetch` because CORS is the point of several of these
 * tests: `Origin` is a forbidden header for a browser's fetch, and a test that
 * cannot set it cannot ask the question.
 */

export const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz01";

export type RunningRelay = { base: string; relay: NodeRelay; close: () => Promise<void> };

export async function startRelay(opts: NodeRelayOptions = {}): Promise<RunningRelay> {
  // No reaper tick: a test that wants reaping drives the broker itself.
  const relay = createNodeRelay({ reapIntervalMs: 0, ...opts });
  const server = createServer((req, res) => void relay.handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    relay,
    close: () =>
      new Promise<void>((resolve) => {
        relay.broker.dispose();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type Reply = {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  ms: number;
};

export function call(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {},
): Promise<Reply> {
  const started = Date.now();

  return new Promise<Reply>((resolve, reject) => {
    const req = request(url, { method: init.method ?? "GET", headers: init.headers, signal: init.signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let json: unknown = null;
        try {
          json = JSON.parse(body);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json, ms: Date.now() - started });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

export function post(url: string, frame: unknown): Promise<Reply> {
  return call(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof frame === "string" ? frame : JSON.stringify(frame),
  });
}

export async function register(base: string, session: string, token = TOKEN): Promise<void> {
  const res = await post(`${base}/register`, { session, token });
  if (res.status !== 200) throw new Error(`register failed: ${res.status} ${res.body}`);
}

export type Stream = {
  status: number;
  headers: IncomingHttpHeaders;
  /** Raw SSE text received so far. */
  text: () => string;
  /** Parsed `event: mcp` frames received so far. */
  frames: () => unknown[];
  /** Resolves when the server ends the response. */
  ended: Promise<void>;
  close: () => void;
};

/** Open an SSE leg and keep reading it until the server ends it or the test closes it. */
export function openStream(url: string): Promise<Stream> {
  return new Promise<Stream>((resolve, reject) => {
    const ctrl = new AbortController();
    let text = "";
    const req = request(url, { headers: { accept: "text/event-stream" }, signal: ctrl.signal }, (res) => {
      let markEnded!: () => void;
      const ended = new Promise<void>((r) => (markEnded = r));
      res.on("data", (c: Buffer) => (text += c.toString("utf8")));
      res.on("end", () => markEnded());
      res.on("close", () => markEnded());
      res.on("error", () => markEnded());

      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: () => text,
        frames: () =>
          text
            .split("\n\n")
            .filter((block) => block.split("\n").includes("event: mcp"))
            .map((block) =>
              JSON.parse(
                block
                  .split("\n")
                  .filter((l) => l.startsWith("data: "))
                  .map((l) => l.slice(6))
                  .join("\n"),
              ),
            ),
        ended,
        close: () => ctrl.abort(),
      });
    });
    req.on("error", (e: Error & { name?: string }) => {
      if (e.name !== "AbortError") reject(e);
    });
    req.end();
  });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll `predicate` until it holds or `ms` elapses. */
export async function until(predicate: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}
