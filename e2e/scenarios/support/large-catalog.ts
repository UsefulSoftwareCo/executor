// Seeds a production-shaped catalog for the toolkit-policy performance
// scenarios, plus the pure builders behind it.
//
// Why a large catalog at all: a toolkit MCP endpoint resolves tool visibility
// by running the policy engine over the WHOLE catalog on connect (the
// getDescription -> connections.list -> toolsList path), not just the toolkit's
// own connections. A per-tool resolution there is an N+1 that scales with total
// catalog size, so a realistic workspace (a real spec plus enough sources to
// look like one) is what surfaces the regression.
//
// `catalogApi` is exported so scenarios build their client from the SAME
// composition `seedLargeCatalog` is typed against — that keeps the seeding
// fully typed (no structural-client gymnastics) while staying DRY across the
// deterministic guard and the OpenCode recording.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import type { HttpApi, HttpApiClient } from "effect/unstable/httpapi";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { toolkitsPlugin } from "@executor-js/plugin-toolkits/server";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

export const unique = (prefix: string): string => `${prefix}_${randomBytes(4).toString("hex")}`;

const VERCEL_SPEC_PATH = fileURLToPath(
  new URL("../../../packages/plugins/openapi/fixtures/vercel.json", import.meta.url),
);

/** The real Vercel OpenAPI fixture (322 operations) as a JSON string. */
export const vercelSpecText = (): string => readFileSync(VERCEL_SPEC_PATH, "utf-8");

/** An OpenAPI 3 doc with `ops` independent GET operations, shaped like a real
 *  REST surface (path params, an apiKey scheme, JSON responses). */
export const syntheticSpec = (title: string, ops: number, baseUrl: string): string => {
  const paths: Record<string, unknown> = {};
  for (let i = 0; i < ops; i++) {
    paths[`/resource${i}/{id}`] = {
      get: {
        operationId: `get_resource_${i}`,
        summary: `Fetch resource ${i}`,
        security: [{ apiKey: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { type: "object", properties: { id: { type: "string" } } },
              },
            },
          },
        },
      },
    };
  }
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title, version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths,
    components: { securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "x-tok" } } },
  });
};

export interface SeedSource {
  readonly slug: string;
  readonly specText: string;
  readonly baseUrl: string;
  readonly description?: string;
}

export interface SeedPlan {
  readonly sources: ReadonlyArray<SeedSource>;
  /** The first source's slug — the one the toolkit is scoped to. */
  readonly firstSlug: string;
  /** Connection pattern the toolkit binds (the first source, org, conn0). */
  readonly toolkitConnectionPattern: string;
}

export interface SeedOptions {
  /** Synthetic sources on top of the real spec. Default 10. */
  readonly syntheticSources?: number;
  /** Operations per synthetic source. Default 300. */
  readonly opsPerSource?: number;
  /** Include the real Vercel fixture (322 ops) as one source. Default true. */
  readonly includeRealSpec?: boolean;
}

/**
 * Plan a large, production-shaped catalog. With the defaults (1 real + 10
 * synthetic sources, 300 ops each) it is ~3,300 tools across 11 sources, where
 * the per-tool policy N+1 turns a toolkit connect from sub-second into a 30s+
 * client timeout. Each source gets exactly one org connection at `conn0`.
 */
export const planLargeCatalog = (options: SeedOptions = {}): SeedPlan => {
  const syntheticSources = options.syntheticSources ?? 10;
  const opsPerSource = options.opsPerSource ?? 300;
  const includeRealSpec = options.includeRealSpec ?? true;

  const sources: SeedSource[] = [];
  if (includeRealSpec) {
    sources.push({
      slug: unique("vercel"),
      specText: vercelSpecText(),
      baseUrl: "https://api.vercel.com",
      description: "Vercel API",
    });
  }
  for (let s = 0; s < syntheticSources; s++) {
    sources.push({
      slug: unique("svc"),
      specText: syntheticSpec(`Service ${s}`, opsPerSource, "https://service.example"),
      baseUrl: "https://service.example",
    });
  }

  const firstSlug = sources[0]!.slug;
  return {
    sources,
    firstSlug,
    toolkitConnectionPattern: `${firstSlug}.org.conn0.*`,
  };
};

// ---------------------------------------------------------------------------
// Typed seeding. Scenarios build their client from `catalogApi` so the client
// type here matches theirs exactly.
// ---------------------------------------------------------------------------

/** The plugin API the seeding (and the scenarios) speak: OpenAPI specs +
 *  toolkits. Build the scenario's client from THIS so types line up. */
export const catalogApi = composePluginApi([openApiHttpPlugin(), toolkitsPlugin()] as const);

type GroupsOf<A> = A extends HttpApi.HttpApi<infer _Id, infer Groups> ? Groups : never;
export type CatalogClient = HttpApiClient.Client<GroupsOf<typeof catalogApi>>;

export interface SeededCatalog {
  /** The org toolkit slug to point an MCP client at: /mcp/toolkits/<slug>. */
  readonly toolkitSlug: string;
  readonly toolkitId: string;
  /** Total tools in the identity's catalog after seeding (the N+1 multiplier). */
  readonly toolCount: number;
  /** Integration slugs created, for assertions / debugging. */
  readonly integrationSlugs: ReadonlyArray<string>;
  /** Remove every spec + toolkit this seeder created. */
  readonly cleanup: Effect.Effect<void>;
}

/**
 * Build the planned catalog under the current identity (one org connection per
 * source) and a toolkit scoped to the first source, then report the total tool
 * count and a finalizer. The toolkit's own surface is small; the connect cost
 * the scenarios guard comes from the policy engine walking the whole catalog.
 */
export const seedLargeCatalog = (
  client: CatalogClient,
  options: SeedOptions = {},
): Effect.Effect<SeededCatalog, unknown> =>
  Effect.gen(function* () {
    const plan = planLargeCatalog(options);

    for (const source of plan.sources) {
      yield* client.openapi.addSpec({
        payload: {
          spec: { kind: "blob", value: source.specText },
          slug: IntegrationSlug.make(source.slug),
          baseUrl: source.baseUrl,
          ...(source.description ? { description: source.description } : {}),
          authenticationTemplate: [
            {
              slug: "apiKey",
              type: "apiKey",
              headers: { "x-tok": [{ type: "variable", name: "token" }] },
            },
          ],
        },
      });
      yield* client.connections.create({
        payload: {
          owner: "org",
          name: ConnectionName.make("conn0"),
          integration: IntegrationSlug.make(source.slug),
          template: AuthTemplateSlug.make("apiKey"),
          value: "unused-token",
        },
      });
    }

    const allTools = yield* client.tools.list({ query: {} });
    const toolCount = allTools.length;

    const toolkit = yield* client.toolkits.create({
      payload: { owner: "org", name: unique("perf-kit") },
    });
    yield* client.toolkits.createConnection({
      params: { toolkitId: toolkit.id },
      payload: { pattern: plan.toolkitConnectionPattern },
    });

    const integrationSlugs = plan.sources.map((source) => source.slug);
    const cleanup = Effect.gen(function* () {
      yield* client.toolkits.remove({ params: { toolkitId: toolkit.id } }).pipe(Effect.ignore);
      yield* Effect.forEach(
        integrationSlugs,
        (slug) => client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore),
        { discard: true },
      );
    }).pipe(Effect.ignore);

    return {
      toolkitSlug: toolkit.slug,
      toolkitId: toolkit.id,
      toolCount,
      integrationSlugs,
      cleanup,
    };
  });
