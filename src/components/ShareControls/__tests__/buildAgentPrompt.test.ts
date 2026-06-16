import { describe, it, expect } from "vitest";
import { buildAgentPrompt } from "../ShareControls";

const url = "https://ui.particle.academy/agent-playground?session=abc123&token=secret-tok";

describe("buildAgentPrompt", () => {
  it("embeds the session link verbatim", () => {
    const prompt = buildAgentPrompt(url);
    expect(prompt).toContain(url);
  });

  it("tells the agent NOT to open a browser (the whole point)", () => {
    const prompt = buildAgentPrompt(url).toLowerCase();
    expect(prompt).toContain("not");
    expect(prompt).toContain("browser");
    // explicitly steers away from browser/Playwright tooling
    expect(prompt).toContain("mcp");
  });

  it("gives the zero-install relay-client connect command", () => {
    const prompt = buildAgentPrompt(url);
    expect(prompt).toContain(`npx -y mcp-relay-client "${url}"`);
  });

  it("includes a shell fallback for agents without MCP support", () => {
    const prompt = buildAgentPrompt(url);
    expect(prompt).toContain("connect.sh");
    expect(prompt).toContain(`bash connect.sh "${url}" call page_describe`);
  });

  it("steers the agent to stable-handle tools, not DOM guessing", () => {
    const prompt = buildAgentPrompt(url);
    expect(prompt).toContain("page_describe");
    expect(prompt.toLowerCase()).toContain("handle");
  });
});
