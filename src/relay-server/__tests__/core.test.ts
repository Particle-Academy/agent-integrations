import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RelayBroker } from "../core";

const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz01"; // 16..128 chars

describe("RelayBroker frame validation (M1)", () => {
  let broker: RelayBroker;

  beforeEach(() => {
    broker = new RelayBroker();
    expect(broker.register("sess", TOKEN).ok).toBe(true);
  });
  afterEach(() => broker.dispose());

  it("accepts a well-formed JSON-RPC request", () => {
    expect(broker.inbox("sess", TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }))).toBe(true);
  });

  it("rejects a substring-only, non-JSON payload", () => {
    expect(broker.inbox("sess", TOKEN, 'garbage "jsonrpc" garbage')).toBe(false);
  });

  it("rejects peer-forged broker control frames", () => {
    for (const method of ["notifications/peer_joined", "notifications/peer_left"]) {
      expect(broker.inbox("sess", TOKEN, JSON.stringify({ jsonrpc: "2.0", method, params: {} }))).toBe(false);
    }
  });

  it("rejects a frame with the wrong jsonrpc version", () => {
    expect(broker.inbox("sess", TOKEN, JSON.stringify({ jsonrpc: "1.0", id: 1, method: "x" }))).toBe(false);
  });

  it("still enforces the token", () => {
    expect(broker.inbox("sess", "wrong-token-wrong-token", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" }))).toBe(
      false,
    );
  });
});
