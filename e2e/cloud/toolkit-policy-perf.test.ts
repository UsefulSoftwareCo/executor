// Cloud: a toolkit MCP endpoint must connect in time that does NOT scale with
// the size of the surrounding catalog.
//
// When a client (OpenCode, Claude Code, mcporter) connects to
// /mcp/toolkits/<slug>, the server builds the `execute` tool's description,
// which lists the workspace's connections, which (for a toolkit session) runs
// the policy engine over the WHOLE catalog to decide tool visibility. A
// per-tool policy resolution there is an N+1 that scales with total catalog
// size, not toolkit size: a workspace with thousands of tools across a dozen
// sources pushes the connect past the MCP client's connect timeout, and the
// toolkit appears permanently "failed" even though nothing is broken.
//
// This scenario seeds a production-shaped catalog (one real OpenAPI spec plus
// enough synthetic sources to look like a working workspace, ~3,300 tools over
// 11 sources) and asserts the catalog size adds only a small, bounded cost to
// connect. The control is a fresh identity with a near-empty catalog: it pays
// the same OAuth + MCP handshake, so the DIFFERENCE isolates the catalog-walk
// cost the fix removes. Before the fix this delta is tens of seconds (and in
// production, a hard timeout); after it, it is sub-second.

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";
import type { McpSurface } from "../src/surfaces/mcp";
import type { Identity } from "../src/target";
import {
  catalogApi,
  seedLargeCatalog,
  unique,
  type SeededCatalog,
} from "../scenarios/support/large-catalog";

const toolkitUrl = (baseUrl: string, slug: string): string =>
  new URL(`/mcp/toolkits/${slug}`, baseUrl).toString();

// The extra wall-clock a ~3,300-tool catalog is allowed to add to a toolkit
// connect over a near-empty one. Post-fix the catalog walk is a couple of
// batched reads (~tens of ms); pre-fix it is 2 uncached reads PER TOOL, tens
// of seconds. 10s sits an order of magnitude below the regression and well
// above OAuth/scheduling jitter, so it is decisive without being flaky.
const MAX_CATALOG_CONNECT_OVERHEAD_MS = 10_000;

// One-operation OpenAPI spec for the control identity: a real toolkit session,
// minimal catalog, so its connect time is "the handshake without the walk".
const tinySpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Tiny API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/ping/{id}": {
        get: {
          operationId: "getPing",
          security: [{ apiKey: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
    components: { securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "x-tok" } } },
  });

/** Time how long a fresh MCP client takes to connect to a toolkit endpoint and
 *  read its advertised tools (the path that pays the catalog-walk cost). */
const timeToolkitConnect = (mcp: McpSurface, identity: Identity, url: string) =>
  Effect.gen(function* () {
    const session = mcp.session(identity, { url });
    const startedAt = Date.now();
    const defs = yield* session.describeTools();
    const elapsedMs = Date.now() - startedAt;
    return { elapsedMs, toolNames: defs.map((d) => d.name) };
  });

scenario(
  "Toolkits · connect time does not scale with catalog size",
  { timeout: 240_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const mcp = yield* Mcp;
      const { client: makeClient } = yield* Api;

      // --- control: a fresh identity with a near-empty catalog ---------------
      const controlIdentity = yield* target.newIdentity();
      const controlClient = yield* makeClient(catalogApi, controlIdentity);
      const controlIntegration = unique("tiny");
      const controlToolkitName = unique("control-kit");

      const control = yield* Effect.gen(function* () {
        yield* controlClient.openapi.addSpec({
          payload: {
            spec: { kind: "blob", value: tinySpec("https://tiny.example") },
            slug: IntegrationSlug.make(controlIntegration),
            baseUrl: "https://tiny.example",
            authenticationTemplate: [
              {
                slug: "apiKey",
                type: "apiKey",
                headers: { "x-tok": [{ type: "variable", name: "token" }] },
              },
            ],
          },
        });
        yield* controlClient.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("conn0"),
            integration: IntegrationSlug.make(controlIntegration),
            template: AuthTemplateSlug.make("apiKey"),
            value: "unused-token",
          },
        });
        const toolkit = yield* controlClient.toolkits.create({
          payload: { owner: "org", name: controlToolkitName },
        });
        yield* controlClient.toolkits.createConnection({
          params: { toolkitId: toolkit.id },
          payload: { pattern: `${controlIntegration}.org.conn0.*` },
        });
        return yield* timeToolkitConnect(
          mcp,
          controlIdentity,
          toolkitUrl(target.baseUrl, toolkit.slug),
        );
      }).pipe(
        Effect.ensuring(
          controlClient.openapi
            .removeSpec({ params: { slug: controlIntegration } })
            .pipe(Effect.ignore),
        ),
      );

      expect(control.toolNames, "control toolkit advertises the execute tool").toContain("execute");

      // --- subject: a fresh identity with a large, production-shaped catalog -
      const bigIdentity = yield* target.newIdentity();
      const bigClient = yield* makeClient(catalogApi, bigIdentity);
      let seededCatalog: SeededCatalog | undefined;

      yield* Effect.gen(function* () {
        // 1 real source (Vercel, 322 ops) + 10 synthetic = 11 sources, ~2,200
        // tools. Sized so the pre-fix N+1 connect (~27s here) still completes
        // under the MCP client's connect timeout, so the regression surfaces as
        // a failed ASSERTION on the overhead rather than a connect crash.
        const seeded = yield* seedLargeCatalog(bigClient, {
          includeRealSpec: true,
          syntheticSources: 10,
          opsPerSource: 190,
        });
        seededCatalog = seeded;
        expect(
          seeded.toolCount,
          "the seeded catalog is large enough to expose the N+1 (thousands of tools)",
        ).toBeGreaterThan(2_000);
        expect(
          seeded.integrationSlugs.length,
          "the catalog spans a production-like number of sources",
        ).toBeGreaterThanOrEqual(11);

        const big = yield* timeToolkitConnect(
          mcp,
          bigIdentity,
          toolkitUrl(target.baseUrl, seeded.toolkitSlug),
        );
        expect(big.toolNames, "large-catalog toolkit advertises the execute tool").toContain(
          "execute",
        );

        const overhead = big.elapsedMs - control.elapsedMs;
        expect(
          overhead,
          `catalog of ${seeded.toolCount} tools across ${seeded.integrationSlugs.length} sources ` +
            `added ${overhead}ms to connect (big ${big.elapsedMs}ms vs control ${control.elapsedMs}ms); ` +
            `the per-tool policy N+1 would make this scale into tens of seconds`,
        ).toBeLessThan(MAX_CATALOG_CONNECT_OVERHEAD_MS);
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() => seededCatalog?.cleanup ?? Effect.void).pipe(Effect.ignore),
        ),
      );
    }),
  ),
);
