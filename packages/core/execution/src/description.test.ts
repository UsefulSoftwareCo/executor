import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { createExecutor, definePlugin, makeTestConfig } from "@executor-js/sdk";

import { buildExecuteDescription } from "./description";

const EmptyInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

// Two plugins registering static sources whose ids are distinct from their
// pluginIds/names. If `buildExecuteDescription` ever renders the wrong field
// (e.g. pluginId, an internal UUID, or the source name), these assertions
// fail — which is the class of bug a hand-rolled fake `Executor` would miss.
const githubPlugin = definePlugin(() => ({
  id: "github-plugin" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "github",
      kind: "in-memory",
      name: "GitHub",
      tools: [
        {
          name: "noop",
          description: "noop",
          inputSchema: EmptyInputSchema,
          handler: () => Effect.succeed(null),
        },
      ],
    },
  ],
}));

const slackPlugin = definePlugin(() => ({
  id: "slack-plugin" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "slack",
      kind: "in-memory",
      name: "Slack Workspace",
      tools: [
        {
          name: "noop",
          description: "noop",
          inputSchema: EmptyInputSchema,
          handler: () => Effect.succeed(null),
        },
      ],
    },
  ],
}));

describe("buildExecuteDescription", () => {
  it.effect("renders real source ids as namespaces (sorted) through the real executor flow", () =>
    Effect.gen(function* () {
      // Intentionally register in non-alphabetical order — the formatter
      // is expected to sort by source id.
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [slackPlugin(), githubPlugin()] as const }),
      );

      const description = yield* buildExecuteDescription(executor);

      // Stable anchor from the workflow preamble.
      expect(description).toContain("Execute TypeScript in a sandboxed runtime");
      // The namespaces section header.
      expect(description).toContain("## Available namespaces");
      // Each source renders with its ACTUAL id, without display labels or plugin ids.
      expect(description).toContain("- `github`");
      expect(description).toContain("- `slack`");
      expect(description).not.toContain("GitHub");
      expect(description).not.toContain("Slack Workspace");
      expect(description).not.toContain("`github-plugin`");
      expect(description).not.toContain("`slack-plugin`");

      // Sort order: `github` before `slack`.
      const githubIdx = description.indexOf("`github`");
      const slackIdx = description.indexOf("`slack`");
      expect(githubIdx).toBeGreaterThan(-1);
      expect(slackIdx).toBeGreaterThan(-1);
      expect(githubIdx).toBeLessThan(slackIdx);
    }),
  );

  it.effect("omits the Available namespaces section when no plugins register sources", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [] as const }));

      const description = yield* buildExecuteDescription(executor);

      expect(description).toContain("Execute TypeScript in a sandboxed runtime");
      expect(description).not.toContain("## Available namespaces");
    }),
  );
});
