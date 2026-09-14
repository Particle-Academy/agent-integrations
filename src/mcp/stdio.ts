import { stderr, stdin, stdout } from "node:process";
import { StringDecoder } from "node:string_decoder";
import type { MicroMcpServer, Transport } from "./server";
import type { JsonRpcMessage } from "./types";

/**
 * StdioTransport — newline-delimited JSON-RPC over a byte stream pair.
 *
 * This is the framing every MCP client uses when it launches a server as a
 * subprocess (Claude Code, Codex, Cursor, Claude Desktop): one JSON-RPC message
 * per line on stdin, one per line on stdout. Anything else a server wants to say
 * goes to stderr, because a stray write to stdout corrupts the stream and the
 * client sees a parse error instead of a message.
 *
 * NODE ONLY, which is why it is its own subpath (`/mcp/stdio`) rather than part
 * of `/mcp`: browser bundles import `/mcp`, and `node:*` imports there would
 * break them.
 *
 *   import { MicroMcpServer } from "@particle-academy/agent-integrations/mcp";
 *   import { attachStdio } from "@particle-academy/agent-integrations/mcp/stdio";
 *
 *   const server = new MicroMcpServer({ info: { name: "my-server", version: "1.0.0" } });
 *   server.registerTool(...);
 *   attachStdio(server);
 *
 * What it deliberately does:
 *
 * - **A bad line costs that line, not the session.** A line that is not JSON, or
 *   is JSON but not a single JSON-RPC message (a number, `null`, a batch), is
 *   reported through `onError` and skipped. No reply is written for it — there
 *   is no request id to address one to, and stdout carries protocol frames only.
 * - **Input ending does not drop a reply that is still owed.** `printf
 *   '<request>\n' | server` closes stdin straight after the request; replies
 *   already in flight are delivered, then the transport closes.
 * - **Bytes, not chunks, are decoded.** A chunk boundary can cut a multi-byte
 *   character in half; decoding chunk by chunk would corrupt it.
 */

/** The readable half. `process.stdin` and any Node `Readable` satisfy it. */
export interface StdioInput {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  pause?(): unknown;
}

/** The writable half. `process.stdout` and any Node `Writable` satisfy it. */
export interface StdioOutput {
  write(chunk: string): unknown;
  on?(event: "error", listener: (error: Error) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
}

export type StdioOptions = {
  /** Defaults to `process.stdin`. */
  input?: StdioInput;
  /** Defaults to `process.stdout`. */
  output?: StdioOutput;
  /**
   * A line that could not be served, or a stream error. Defaults to one line on
   * `process.stderr` — the channel the MCP spec reserves for exactly this.
   */
  onError?: (error: Error) => void;
  /** Called once, when the transport closes (input ended, or `close()`). */
  onClose?: () => void;
};

export class StdioTransport implements Transport {
  private server?: MicroMcpServer;
  private readonly input: StdioInput;
  private readonly output: StdioOutput;
  private readonly reportError: (error: Error) => void;
  private readonly onClose?: () => void;
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private closed = false;
  private started = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(options: StdioOptions = {}) {
    this.input = options.input ?? stdin;
    this.output = options.output ?? stdout;
    const onError = options.onError ?? ((error: Error) => stderr.write(`[mcp stdio] ${error.message}\n`));
    // A host's error handler that throws must not take the session down with
    // it: it runs inside a stream callback, where a throw is an uncaught error.
    this.reportError = (error) => {
      try {
        onError(error);
      } catch {
        /* nothing useful left to report it to */
      }
    };
    this.onClose = options.onClose;
  }

  /** Bind to a server. `attachStdio` does this for you. */
  bindServer(server: MicroMcpServer): void {
    this.server = server;
  }

  /** Begin reading input. `attachStdio` does this for you. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.input.on("data", this.onData);
    this.input.on("end", this.onEnd);
    this.input.on("error", this.onStreamError);
    this.output.on?.("error", this.onStreamError);
  }

  /** Server → client: one message, one line. `JSON.stringify` escapes every newline inside it. */
  send(message: JsonRpcMessage): void {
    if (this.closed) return;
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.removeListener("data", this.onData);
    this.input.removeListener("end", this.onEnd);
    this.input.removeListener("error", this.onStreamError);
    this.output.removeListener?.("error", this.onStreamError);
    // Removing the data listener does not stop a flowing stream by itself, and
    // a flowing stdin keeps the process alive.
    this.input.pause?.();
    this.onClose?.();
  }

  private readonly onData = (chunk: unknown): void => {
    if (this.closed) return;
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk as Uint8Array);

    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.serve(line);
      newline = this.buffer.indexOf("\n");
    }
  };

  private readonly onEnd = (): void => {
    if (this.closed) return;
    this.buffer += this.decoder.end();
    const last = this.buffer;
    this.buffer = "";
    this.serve(last);

    // Deliver what is owed before closing, or a request followed immediately by
    // end-of-input never gets its reply.
    void Promise.allSettled([...this.inFlight]).then(() => {
      this.server?.detach(this);
      this.close();
    });
  };

  private readonly onStreamError = (error: Error): void => {
    this.reportError(error);
  };

  private serve(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") return;

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.reportError(new Error(`Ignored a line that is not JSON (${(error as Error).message}): ${preview(line)}`));
      return;
    }

    if (message === null || typeof message !== "object") {
      this.reportError(new Error(`Ignored a line that is JSON but not a JSON-RPC message: ${preview(line)}`));
      return;
    }
    if (Array.isArray(message)) {
      this.reportError(new Error(`Ignored a JSON-RPC batch; this transport serves one message per line: ${preview(line)}`));
      return;
    }
    if (!this.server) {
      this.reportError(new Error("StdioTransport has no bound server; use attachStdio(server)."));
      return;
    }

    const pending: Promise<void> = this.server
      .receive(this, message as JsonRpcMessage)
      .catch((error: unknown) => this.reportError(error instanceof Error ? error : new Error(String(error))))
      .finally(() => this.inFlight.delete(pending));
    this.inFlight.add(pending);
  }
}

function preview(line: string): string {
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/**
 * Serve `server` over stdio (or the streams you pass). Returns the transport;
 * `server.detach(transport)` or `transport.close()` stops it.
 */
export function attachStdio(server: MicroMcpServer, options: StdioOptions = {}): StdioTransport {
  const transport = new StdioTransport(options);
  transport.bindServer(server);
  server.attach(transport);
  transport.start();
  return transport;
}
