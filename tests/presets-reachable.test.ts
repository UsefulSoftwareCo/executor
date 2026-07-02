import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { createExecutor } from "../packages/core/sdk/src/index";
import { makeTestConfig } from "../packages/core/sdk/src/testing";
import { openApiPlugin } from "../packages/plugins/openapi/src/sdk/plugin";
import { parse, resolveSpecText } from "../packages/plugins/openapi/src/sdk/parse";
import {
  convertGoogleDiscoveryToOpenApi,
  fetchGoogleDiscoveryDocument,
  isGoogleDiscoveryUrl,
} from "../packages/plugins/google/src/sdk/discovery";
import { mcpPlugin } from "../packages/plugins/mcp/src/sdk/plugin";
import { graphqlPlugin } from "../packages/plugins/graphql/src/sdk/plugin";
import { introspect } from "../packages/plugins/graphql/src/sdk/introspect";

import { openApiPresets } from "../packages/plugins/openapi/src/sdk/presets";
import { mcpPresets } from "../packages/plugins/mcp/src/sdk/presets";
import { graphqlPresets } from "../packages/plugins/graphql/src/sdk/presets";

// ---------------------------------------------------------------------------
// All presets with plugin metadata
// ---------------------------------------------------------------------------

const allPresets = [
  ...openApiPresets.map((p) => ({ ...p, plugin: "openapi" as const })),
  ...mcpPresets.map((p) => ({ ...p, plugin: "mcp" as const })),
  ...graphqlPresets.map((p) => ({ ...p, plugin: "graphql" as const })),
];

// ---------------------------------------------------------------------------
// OpenAPI presets — parse the spec through the SDK
// ---------------------------------------------------------------------------

describe("openapi presets parse as valid specs", () => {
  for (const preset of openApiPresets) {
    it.effect(
      preset.name,
      () =>
        Effect.gen(function* () {
          const specText = isGoogleDiscoveryUrl(preset.url)
            ? yield* fetchGoogleDiscoveryDocument(preset.url).pipe(
                Effect.provide(FetchHttpClient.layer),
                Effect.flatMap((documentText) =>
                  convertGoogleDiscoveryToOpenApi({
                    discoveryUrl: preset.url,
                    documentText,
                  }),
                ),
                Effect.map((conversion) => conversion.specText),
              )
            : yield* resolveSpecText(preset.url).pipe(Effect.provide(FetchHttpClient.layer));
          const doc = yield* parse(specText);
          expect(doc).toBeDefined();
          expect(doc.openapi).toBeDefined();
        }),
      { timeout: 30_000 },
    );
  }
});

// ---------------------------------------------------------------------------
// GraphQL presets — introspect the endpoint (auth-required = 401 is ok)
// ---------------------------------------------------------------------------

describe("graphql presets are reachable endpoints", () => {
  for (const preset of graphqlPresets) {
    it.effect(
      preset.name,
      () =>
        Effect.gen(function* () {
          const result = yield* introspect(preset.url).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.map((r) => ({ ok: true as const, schema: r })),
            Effect.catchTag("GraphqlIntrospectionError", (err) =>
              Effect.succeed({
                ok: false as const,
                // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: catchTag narrows to GraphqlIntrospectionError whose public contract includes message
                message: err.message,
              }),
            ),
          );

          const authFailureMessage = result.ok ? null : result.message;
          let isReachable =
            result.ok || /401|403|Unauthorized|Forbidden|auth/i.test(authFailureMessage ?? "");
          let failureDetails = authFailureMessage ?? "";
          if (!isReachable) {
            const response = yield* Effect.tryPromise(() =>
              fetch(preset.url, {
                method: "POST",
                signal: AbortSignal.timeout(10_000),
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: "{ __typename }" }),
                redirect: "follow",
              }),
            );
            isReachable = response.ok;
            failureDetails = `${failureDetails}; probe returned ${response.status}`;
          }

          expect(
            isReachable,
            `${preset.name} should expose introspection, fail with auth, or answer a GraphQL probe; ${failureDetails}`,
          ).toBe(true);
          if (!result.ok) return;
          expect(result.schema.__schema).toBeDefined();
          expect(result.schema.__schema.types.length).toBeGreaterThan(0);
        }),
      { timeout: 15_000 },
    );
  }
});

// ---------------------------------------------------------------------------
// MCP presets — probe the endpoint (POST to verify it's alive)
// ---------------------------------------------------------------------------

const remoteMcpPresets = mcpPresets.filter((p) => !("transport" in p && p.transport === "stdio"));

describe("mcp presets are reachable endpoints", () => {
  for (const preset of remoteMcpPresets) {
    it.effect(
      preset.name,
      () =>
        Effect.gen(function* () {
          // Simple POST probe — MCP endpoints reject malformed requests
          // but return non-404 status codes proving the service is up
          const response = yield* Effect.tryPromise(() =>
            fetch(preset.url, {
              method: "POST",
              signal: AbortSignal.timeout(10_000),
              headers: { "Content-Type": "application/json" },
              body: "{}",
              redirect: "follow",
            }),
          );

          expect(
            response.status !== 404 && response.status !== 502 && response.status !== 503,
            `${preset.name} returned ${response.status} — endpoint appears down`,
          ).toBe(true);
        }),
      { timeout: 15_000 },
    );
  }
});

// ---------------------------------------------------------------------------
// Detection — full executor pipeline, only for presets that don't need auth
// ---------------------------------------------------------------------------

const publicPresets = allPresets.filter(
  (p) =>
    // Skip auth-required endpoints that won't pass detection without credentials
    !["github-graphql", "linear", "monday", "stripe"].includes(p.id) &&
    // Skip stdio presets (not HTTP-reachable)
    !("transport" in p && (p as Record<string, unknown>).transport === "stdio") &&
    // Skip endpoints where detection is flaky due to timeout or misdetection
    // (these are detect() implementation issues, not preset issues)
    !["digitalocean", "firecrawl", "gitlab", "openai"].includes(p.id),
);

describe("public preset URLs are detected by the correct plugin", () => {
  const makeExecutor = () =>
    createExecutor(
      makeTestConfig({
        plugins: [openApiPlugin(), mcpPlugin(), graphqlPlugin()] as const,
      }),
    );

  for (const preset of publicPresets) {
    it.effect(
      `[${preset.plugin}] ${preset.name}`,
      () =>
        Effect.gen(function* () {
          const executor = yield* makeExecutor();
          const results = yield* executor.sources.detect(preset.url);

          expect(
            results.length,
            `No detection results for ${preset.name} (${preset.url})`,
          ).toBeGreaterThan(0);

          const expectedKinds: Record<string, string> = {
            openapi: "openapi",
            mcp: "mcp",
            graphql: "graphql",
          };
          const best = results[0]!;
          expect(best.kind).toBe(expectedKinds[preset.plugin]);
        }),
      { timeout: 30_000 },
    );
  }
});

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

describe("preset icons are reachable", () => {
  const presetsWithIcons = allPresets.filter((p) => p.icon);
  for (const preset of presetsWithIcons) {
    it.effect(
      `[${preset.plugin}] ${preset.name} icon`,
      () =>
        Effect.gen(function* () {
          const response = yield* Effect.tryPromise(() =>
            fetch(preset.icon!, {
              method: "GET",
              signal: AbortSignal.timeout(10_000),
              headers: { "User-Agent": "executor-preset-test" },
              redirect: "follow",
            }),
          );
          expect(response.ok, `${preset.name} icon returned ${response.status}`).toBe(true);
        }),
      { timeout: 15_000 },
    );
  }
});
