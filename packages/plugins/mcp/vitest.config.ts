import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `src/react/**/*.test.ts` is the plugin-side auth converter (pure logic);
    // react component tests would be `.test.tsx` and need a DOM env.
    include: ["src/sdk/**/*.test.ts", "src/api/**/*.test.ts", "src/react/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
