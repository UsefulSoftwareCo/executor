import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  createExecutor,
  definePlugin,
  type CredentialProvider,
} from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";

import { buildExecuteDescription, parseIntegrationInventory } from "./description";

const memoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
    has: (id) => Effect.sync(() => store.has(String(id))),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((key) => ({
          id: ProviderItemId.make(key),
          name: key,
        })),
      ),
  };
};

const GITHUB = IntegrationSlug.make("github");
const SLACK = IntegrationSlug.make("slack");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

// The execute description lists the top-level integrations the user has
// connected: one line per integration slug, deduped across connections, with
// the integration's capability description when the catalog carries a real one
// (legacy slug/name-only descriptions are suppressed).
const githubPlugin = definePlugin(() => ({
  id: "github-plugin" as const,
  credentialProviders: [memoryProvider()],
  storage: () => ({}),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: GITHUB,
        description: "GitHub",
        config: {},
      }),
  }),
}))();

const slackPlugin = definePlugin(() => ({
  id: "slack-plugin" as const,
  storage: () => ({}),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: SLACK,
        name: "Slack",
        description: "Send and read workspace messages.",
        config: {},
      }),
  }),
}))();

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("buildExecuteDescription", () => {
  it.effect("lists the connected integrations, not the connection prefixes", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [slackPlugin, githubPlugin] as const }),
      );
      yield* executor["slack-plugin"].seed();
      yield* executor["github-plugin"].seed();
      yield* executor.connections.create({
        owner: "user",
        name: ConnectionName.make("personal"),
        integration: GITHUB,
        template: TEMPLATE,
        value: "user-token",
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("prod"),
        integration: GITHUB,
        template: TEMPLATE,
        value: "org-token",
      });

      const description = yield* buildExecuteDescription(executor);

      // Stable anchor from the short preamble.
      expect(description).toContain("Execute TypeScript in a sandboxed runtime");
      // The full how-to now lives behind the `skills` tool, so the description
      // points there rather than inlining the workflow/rules.
      expect(description).toContain('skills({ name: "execute" })');
      expect(description).not.toContain("Use `emit(value)` to append user-visible output");
      expect(description).not.toContain("## Workflow");
      expect(description).not.toContain("## Rules");
      // Top-level integration slug, deduped across the two github connections.
      expect(description).toContain("## Available integrations");
      expect(description).toContain("- `github`");
      expect(occurrences(description, "- `github`")).toBe(1);
      // The per-connection prefixes are gone.
      expect(description).not.toContain("github.org.prod");
      expect(description).not.toContain("github.user.personal");
      // Slack is registered but unconnected, so it is not listed.
      expect(description).not.toContain("- `slack`");
      expect(description).not.toContain("workspace messages");
      expect(description).not.toContain("`github-plugin`");
      expect(description).not.toContain("`slack-plugin`");
    }),
  );

  it.effect("renders capability descriptions, suppressing slug/name repeats", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [slackPlugin, githubPlugin] as const }),
      );
      yield* executor["slack-plugin"].seed();
      yield* executor["github-plugin"].seed();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: SLACK,
        template: TEMPLATE,
        value: "slack-token",
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("prod"),
        integration: GITHUB,
        template: TEMPLATE,
        value: "org-token",
      });

      const description = yield* buildExecuteDescription(executor);

      // Slack's real capability description rides its line; github's legacy
      // description ("GitHub", a name repeat) is suppressed.
      expect(description).toContain("- `slack` — Send and read workspace messages.");
      expect(description).toContain("- `github`\n");
      expect(description).not.toContain("- `github` —");
    }),
  );

  it.effect("dedupes many connections of one integration into a single line", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [githubPlugin] as const }));
      yield* executor["github-plugin"].seed();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("prod"),
        integration: GITHUB,
        template: TEMPLATE,
        value: "org-token",
      });
      yield* executor.connections.create({
        owner: "user",
        name: ConnectionName.make("personal"),
        integration: GITHUB,
        template: TEMPLATE,
        value: "user-token",
      });

      const description = yield* buildExecuteDescription(executor);

      expect(occurrences(description, "- `github`")).toBe(1);
      expect(description).not.toContain(".org.prod");
      expect(description).not.toContain(".user.personal");
    }),
  );

  it.effect("truncates long descriptions to one scannable line", () =>
    Effect.gen(function* () {
      const verbosePlugin = definePlugin(() => ({
        id: "verbose-plugin" as const,
        credentialProviders: [memoryProvider()],
        storage: () => ({}),
        extension: (ctx) => ({
          seed: () =>
            ctx.core.integrations.register({
              slug: IntegrationSlug.make("verbose"),
              name: "Verbose",
              description: `${"word ".repeat(60).trim()} trailing\nsecond line ignored`,
              config: {},
            }),
        }),
      }))();
      const executor = yield* createExecutor(makeTestConfig({ plugins: [verbosePlugin] as const }));
      yield* executor["verbose-plugin"].seed();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make("verbose"),
        template: TEMPLATE,
        value: "verbose-token",
      });

      const description = yield* buildExecuteDescription(executor);
      const line = description.split("\n").find((l) => l.startsWith("- `verbose`")) ?? "";

      expect(line.startsWith("- `verbose` — word")).toBe(true);
      expect(line.endsWith("…")).toBe(true);
      expect(line.length).toBeLessThan(140);
      expect(line).not.toContain("trailing");
      expect(line).not.toContain("second line");
    }),
  );

  it.effect("omits the Available integrations section when no connections exist", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [] as const }));

      const description = yield* buildExecuteDescription(executor);

      expect(description).toContain("Execute TypeScript in a sandboxed runtime");
      expect(description).not.toContain("## Available integrations");
    }),
  );
});

describe("parseIntegrationInventory", () => {
  it.effect("round-trips the slugs a built description lists", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [slackPlugin, githubPlugin] as const }),
      );
      yield* executor["slack-plugin"].seed();
      yield* executor["github-plugin"].seed();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: SLACK,
        template: TEMPLATE,
        value: "slack-token",
      });
      yield* executor.connections.create({
        owner: "user",
        name: ConnectionName.make("personal"),
        integration: GITHUB,
        template: TEMPLATE,
        value: "user-token",
      });

      const description = yield* buildExecuteDescription(executor);

      expect(parseIntegrationInventory(description)).toEqual(["github", "slack"]);
    }),
  );

  it("returns nothing for a description without an inventory block", () => {
    expect(parseIntegrationInventory("Execute TypeScript in a sandboxed runtime.")).toEqual([]);
  });

  it("reads item lines only, not the overflow marker, prose, or descriptions", () => {
    const description = [
      "Execute TypeScript in a sandboxed runtime.",
      "",
      "## Available integrations",
      "",
      "Integrations you have connected. Their tools live under `tools.<integration>.…`.",
      "- `github`",
      "- `google_gmail` — search, read, and send mail",
      "- ... 3 more",
    ].join("\n");

    expect(parseIntegrationInventory(description)).toEqual(["github", "google_gmail"]);
  });
});
