# Contributing to @particle-academy/agent-integrations

Notes for anyone, human or agent, working ON this package's code. How to USE the
package is in [AGENTS.md](./AGENTS.md); what it is, is in [README.md](./README.md).
`CLAUDE.md` is a symlink to this file, so Claude Code reads these notes when it
works in this repo.

## Build and test

```bash
npm run build   # tsup
npm run dev     # tsup --watch
npm run lint    # tsc --noEmit && eslint .
npm test        # vitest run (pretest runs the build first)
```

Tests live next to the code in `__tests__/` directories under `src/` (bridges,
cowork, mcp, relay-server, dom-navigation, components, ...).

## Things tests hold you to

- **`/mcp` and `/mcp/stdio` stay headless.** `/mcp` imports no package at all
  and `/mcp/stdio` imports only Node built-ins; `src/mcp/__tests__/headless.test.ts`
  walks both import graphs.
- **Forbidden tool names.** The agent-chat and sign bridges expose no tool that
  decides, sends, signs or confirms on the human's behalf;
  `AGENT_CHAT_FORBIDDEN_TOOL_NAME` and `SIGN_FORBIDDEN_TOOL_NAME` are the
  patterns a test holds every tool name against.

## Changelog

Update `CHANGELOG.md` (Keep a Changelog, `[Unreleased]` at the top) in the same
commit as the change.
