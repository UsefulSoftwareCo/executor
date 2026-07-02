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

import { buildExecuteDescription } from "./description";

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
// connected: one bare line per integration slug, deduped across connections,
// names only (no per-integration descriptions).
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

  it.effect("lists integration names only, with no descriptions", () =>
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

      // Bare slugs, sorted, with no per-integration description riding the line
      // (Slack's "Send and read workspace messages." is dropped).
      expect(description).toContain("- `github`");
      expect(description).toContain("- `slack`");
      expect(description).not.toContain("Send and read workspace messages");
      expect(description).not.toContain("- `slack` —");
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

  it.effect("omits the Available integrations section when no connections exist", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [] as const }));

      const description = yield* buildExecuteDescription(executor);

      expect(description).toContain("Execute TypeScript in a sandboxed runtime");
      expect(description).not.toContain("## Available integrations");
    }),
  );
});
