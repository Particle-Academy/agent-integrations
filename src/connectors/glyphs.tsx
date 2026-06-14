// Brand-ish glyph marks for each MCP host, so consumers don't have to redraw
// them. Deliberately simple, single-path, `currentColor` SVGs — they inherit
// the button's text color and stay crisp at 14px.

import type { SVGProps } from "react";

type GlyphProps = SVGProps<SVGSVGElement>;

export function ClaudeMark(props: GlyphProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M12 2 L 14 10 L 22 12 L 14 14 L 12 22 L 10 14 L 2 12 L 10 10 Z" />
    </svg>
  );
}

export function CursorMark(props: GlyphProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M3 3 L 20 11 L 12 13 L 9 21 Z" />
    </svg>
  );
}

export function VscodeMark(props: GlyphProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M17 2 L 22 4.5 V 19.5 L 17 22 L 6.5 13.2 L 3 16 L 1.5 15 V 9 L 3 8 L 6.5 10.8 Z M 17 6.5 L 10 12 L 17 17.5 Z" />
    </svg>
  );
}

export function DesktopMark(props: GlyphProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M3 4 H 21 A 1 1 0 0 1 22 5 V 16 A 1 1 0 0 1 21 17 H 14 V 19 H 16 V 21 H 8 V 19 H 10 V 17 H 3 A 1 1 0 0 1 2 16 V 5 A 1 1 0 0 1 3 4 Z" />
    </svg>
  );
}

export function WrenchMark(props: GlyphProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M21 4 a 5 5 0 0 1 -6.5 6.5 L 6 19 l -3 -3 l 8.5 -8.5 A 5 5 0 0 1 17 1 l -2.5 2.5 l 1.5 3 l 3 1.5 Z" />
    </svg>
  );
}

import type { ComponentType } from "react";
import type { ConnectorClient } from "./targets";

/** Glyph component for a given client. */
export const CONNECTOR_GLYPHS: Record<
  ConnectorClient,
  ComponentType<GlyphProps>
> = {
  "claude-web": ClaudeMark,
  "claude-desktop": DesktopMark,
  cursor: CursorMark,
  vscode: VscodeMark,
  manual: WrenchMark,
};
