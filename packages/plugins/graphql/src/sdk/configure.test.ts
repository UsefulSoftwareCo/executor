// ---------------------------------------------------------------------------
// GraphQL plugin — `configureAuth` (custom auth method merge-append) coverage.
//
// `configureAuth` merge-appends apiKey/oauth2 templates onto an existing
// integration's opaque `authenticationTemplate`. These tests exercise the
// extension method directly (the same path the HTTP `configure` handler calls):
//   - round-trip: add a custom apiKey method → `getConfig` shows it,
//   - append: a configured method does not drop the integration's existing
//     declared methods,
//   - slug generation: a method with a blank slug is assigned `custom_<id>`,
//   - dedupe: a matching slug replaces in place; two slug-less methods in one
//     call get distinct generated slugs,
//   - unknown slug is a no-op (returns []).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { createExecutor } from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { graphqlPlugin } from "./plugin";
import type { AuthTemplate } from "./types";

const makeExecutor = () =>
  createExecutor(
    makeTestConfig({
      plugins: [memoryCredentialsPlugin(), graphqlPlugin()] as const,
    }),
  );

const customApiKey: AuthTemplate = {
  kind: "apiKey",
  slug: "my_custom",
  in: "header",
  name: "X-Api-Key",
};

describe("GraphQL Plugin — configureAuth (custom auth method)", () => {
  it.effect("adds a custom apiKey method and getConfig reflects it", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();

      yield* executor.graphql.addIntegration({
        endpoint: "https://x.example/graphql",
        slug: "cfg_api",
      });

      const merged = yield* executor.graphql.configureAuth("cfg_api", {
        authenticationTemplate: [customApiKey],
      });

      expect(merged).toHaveLength(1);
      expect(merged[0]!.slug).toBe("my_custom");

      const config = yield* executor.graphql.getConfig("cfg_api");
      const template = config?.authenticationTemplate ?? [];
      expect(template).toEqual([
        { kind: "apiKey", slug: "my_custom", in: "header", name: "X-Api-Key" },
      ]);
    }),
  );

  it.effect("appends to an existing declared template without dropping entries", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();

      yield* executor.graphql.addIntegration({
        endpoint: "https://x.example/graphql",
        slug: "cfg_append",
        authenticationTemplate: [{ kind: "apiKey", slug: "seed", in: "header", name: "X-Seed" }],
      });

      const merged = yield* executor.graphql.configureAuth("cfg_append", {
        authenticationTemplate: [customApiKey],
      });

      expect(merged.map((m: AuthTemplate) => m.slug)).toEqual(["seed", "my_custom"]);
    }),
  );

  it.effect("generates a custom_<id> slug for a method submitted with a blank slug", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();

      yield* executor.graphql.addIntegration({
        endpoint: "https://x.example/graphql",
        slug: "cfg_genslug",
      });

      const merged = yield* executor.graphql.configureAuth("cfg_genslug", {
        authenticationTemplate: [{ kind: "apiKey", slug: "", in: "header", name: "X-Api-Key" }],
      });

      expect(merged).toHaveLength(1);
      expect(merged[0]!.slug).toMatch(/^custom_[a-z0-9]+$/);
    }),
  );

  it.effect("dedupes: a matching slug replaces in place; two slug-less get distinct slugs", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();

      yield* executor.graphql.addIntegration({
        endpoint: "https://x.example/graphql",
        slug: "cfg_dedupe",
        authenticationTemplate: [customApiKey],
      });

      const merged = yield* executor.graphql.configureAuth("cfg_dedupe", {
        authenticationTemplate: [
          // Re-submit the same slug with a different placement → replace in place.
          {
            kind: "apiKey",
            slug: "my_custom",
            in: "header",
            name: "X-Other",
          },
          { kind: "apiKey", slug: "", in: "query", name: "api_key" },
          { kind: "apiKey", slug: "", in: "query", name: "token" },
        ],
      });

      const slugs = merged.map((m: AuthTemplate) => m.slug);
      expect(slugs.filter((s: string) => s === "my_custom")).toHaveLength(1);
      expect(merged).toHaveLength(3);
      const generated = slugs.filter((s: string) => s.startsWith("custom_"));
      expect(generated).toHaveLength(2);
      expect(new Set(generated).size).toBe(2);

      const replaced = merged.find((m: AuthTemplate) => m.slug === "my_custom")!;
      expect(replaced).toEqual({
        kind: "apiKey",
        slug: "my_custom",
        in: "header",
        name: "X-Other",
      });
    }),
  );

  it.effect("replace mode overwrites the auth template array", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();

      yield* executor.graphql.addIntegration({
        endpoint: "https://x.example/graphql",
        slug: "cfg_replace",
        authenticationTemplate: [
          { kind: "apiKey", slug: "seed", in: "header", name: "X-Seed" },
          customApiKey,
        ],
      });

      const merged = yield* executor.graphql.configureAuth("cfg_replace", {
        authenticationTemplate: [{ kind: "apiKey", slug: "seed", in: "header", name: "X-Seed" }],
        mode: "replace",
      });

      expect(merged.map((m: AuthTemplate) => m.slug)).toEqual(["seed"]);
    }),
  );

  it.effect("configureAuth is a no-op for an unknown integration", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const merged = yield* executor.graphql.configureAuth("nope", {
        authenticationTemplate: [customApiKey],
      });
      expect(merged).toEqual([]);
    }),
  );

  it.effect("getConfig returns null for an unknown integration", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      expect(yield* executor.graphql.getConfig("nope")).toBeNull();
    }),
  );
});
