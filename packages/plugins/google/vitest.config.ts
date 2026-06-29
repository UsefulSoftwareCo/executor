import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `.test.ts` only. React component tests are `.test.tsx` and need a DOM
    // env, so they're excluded; the plugin-side converters are pure `.ts`
    // logic and run here from `src/react/`.
    include: ["src/**/*.test.ts"],
    exclude: ["src/api/**", "src/react/**/*.test.tsx"],
    testTimeout: 15_000,
  },
});
