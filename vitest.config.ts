import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // jsdom gives the connector tests `btoa`, `navigator.clipboard`, and a DOM
    // for the <ConnectorButtons> render test. Pure-builder tests run here too.
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
