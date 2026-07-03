import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  modelOptions: {
    providerOptions: {
      anthropic: {
        effort: "medium",
        thinking: { type: "adaptive" },
      },
    },
  },
  modelContextWindowTokens: 200_000,
  compaction: {
    thresholdPercent: 0.75,
  },
  build: {
    externalDependencies: ["@vercel/oidc", "@vercel/sandbox", "postgres"],
  },
});
