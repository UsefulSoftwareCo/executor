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

// v2 port: available entries are saved connection prefixes, not integration
// slugs. Multiple saved connections can point at the same integration, and the
// callable path needs `<integration>.<owner>.<connection>`.
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

describe("buildExecuteDescription", () => {
  it.effect("renders real connection prefixes separately through the real executor flow", () =>
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

      // Stable anchor from the workflow preamble.
      expect(description).toContain("Execute TypeScript in a sandboxed runtime");
      expect(description).toContain("## Available connection prefixes");
      expect(description).toContain("- `github.org.prod`");
      expect(description).toContain("- `github.user.personal`");
      expect(description).not.toContain("## Available namespaces");
      expect(description).not.toContain("workspace messages");
      expect(description).not.toContain("`github-plugin`");
      expect(description).not.toContain("`slack-plugin`");
      expect(description).not.toContain("- `github`");

      const orgIdx = description.indexOf("`github.org.prod`");
      const userIdx = description.indexOf("`github.user.personal`");
      expect(orgIdx).toBeGreaterThan(-1);
      expect(userIdx).toBeGreaterThan(-1);
      expect(orgIdx).toBeLessThan(userIdx);
    }),
  );

  it.effect("annotates prefixes with connection or integration descriptions", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [slackPlugin, githubPlugin] as const }),
      );
      yield* executor["slack-plugin"].seed();
      yield* executor["github-plugin"].seed();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("prod"),
        integration: GITHUB,
        template: TEMPLATE,
        value: "org-token",
        description: "Production org — issues and PRs only.",
      });
      yield* executor.connections.create({
        owner: "user",
        name: ConnectionName.make("personal"),
        integration: GITHUB,
        template: TEMPLATE,
        value: "user-token",
      });

      const description = yield* buildExecuteDescription(executor);

      // The curated connection description rides its prefix line.
      expect(description).toContain("- `github.org.prod` — Production org — issues and PRs only.");
      // No connection description and the integration description ("GitHub")
      // just restates the slug — the line stays bare.
      expect(description).toContain("- `github.user.personal`");
      expect(description).not.toContain("- `github.user.personal` —");
    }),
  );

  it.effect("falls back to a meaningful integration description", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [slackPlugin, githubPlugin] as const }),
      );
      yield* executor["slack-plugin"].seed();
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: SLACK,
        template: TEMPLATE,
        value: "slack-token",
      });

      const description = yield* buildExecuteDescription(executor);

      expect(description).toContain("- `slack.org.main` — Send and read workspace messages.");
    }),
  );

  it.effect("omits the Available connection prefixes section when no connections exist", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [] as const }));

      const description = yield* buildExecuteDescription(executor);

      expect(description).toContain("Execute TypeScript in a sandboxed runtime");
      expect(description).not.toContain("## Available connection prefixes");
    }),
  );
});
