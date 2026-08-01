import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 15_000,
    exclude: [
      ...configDefaults.exclude,
      "**/.worktrees/**",
      "**/worktrees/**",
    ],
  },
});
