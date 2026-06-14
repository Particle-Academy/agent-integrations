// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ConnectorButtons } from "../ConnectorButtons";

const server = { serverName: "Decksmith", mcpUrl: "https://decksmith.dev/mcp" };

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<ConnectorButtons>", () => {
  it("renders the default clients (no claude-desktop without a bundle url)", () => {
    render(<ConnectorButtons {...server} />);
    expect(screen.getByText("Add to Claude")).toBeTruthy();
    expect(screen.getByText("Add to Cursor")).toBeTruthy();
    expect(screen.getByText("Add to VS Code")).toBeTruthy();
    expect(screen.getByText("Manual setup")).toBeTruthy();
    expect(screen.queryByText("Claude Desktop")).toBeNull();
  });

  it("shows the Claude Desktop download only when a bundle url is given", () => {
    render(<ConnectorButtons {...server} mcpbDownloadUrl="/decksmith.mcpb" />);
    const link = screen.getByText("Claude Desktop").closest("a")!;
    expect(link.getAttribute("href")).toBe("/decksmith.mcpb");
    expect(link.hasAttribute("download")).toBe(true);
  });

  it("renders cursor/vscode as deeplink anchors", () => {
    render(<ConnectorButtons {...server} />);
    const cursor = screen.getByText("Add to Cursor").closest("a")!;
    expect(cursor.getAttribute("href")).toContain(
      "cursor://anysphere.cursor-deeplink/mcp/install",
    );
    const vscode = screen.getByText("Add to VS Code").closest("a")!;
    expect(vscode.getAttribute("href")).toContain("vscode://mcp/install?");
  });

  it("copies the URL and opens Claude's connectors page", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<ConnectorButtons {...server} />);
    fireEvent.click(screen.getByText("Add to Claude"));
    expect(open).toHaveBeenCalledWith(
      "https://claude.ai/settings/connectors",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("toggles the manual popover with the config snippet", () => {
    render(<ConnectorButtons {...server} />);
    expect(screen.queryByText(/claude_desktop_config\.json/)).toBeNull();
    fireEvent.click(screen.getByText("Manual setup"));
    // the snippet (a <pre>) should now contain the mcp-remote wrapper
    expect(screen.getByText(/"mcp-remote"/)).toBeTruthy();
  });

  it("honors an explicit clients list + label overrides", () => {
    render(
      <ConnectorButtons
        {...server}
        clients={["cursor"]}
        labels={{ cursor: "Cursor ↗" }}
      />,
    );
    expect(screen.getByText("Cursor ↗")).toBeTruthy();
    expect(screen.queryByText("Add to Claude")).toBeNull();
  });
});
