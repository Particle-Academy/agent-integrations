# Standalone MCP relay broker — `npx agent-integrations-relay` baked
# into a minimal image. Deploy anywhere a container runs (Fly, Railway,
# Render, ECS, Cloud Run, Docker host). PORT is honoured; everything
# else is configurable via env vars or CLI flags.

FROM node:22-alpine AS app
WORKDIR /app

# Cache the install layer — only re-install when manifests change.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

# Bring in the compiled dist (built outside the image via `npm run build`).
COPY dist/ ./dist/

EXPOSE 8787
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0

# Cheap healthcheck — the relay returns 200 on GET / without auth.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O- "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["node", "dist/relay-server-cli.js"]
