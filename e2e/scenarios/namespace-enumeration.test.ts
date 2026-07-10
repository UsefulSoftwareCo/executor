// Cross-target: an integration's tool catalog is enumerable from the sandbox.
// tools.search with a namespace and an EMPTY query is enumeration: the whole
// catalog, path-sorted and paged, whose `total` reconciles exactly against
// the toolCount that executor.integrations.list reports. Before this
// guarantee an agent could only lower-bound a catalog by unioning keyword
// searches (issue #1383): the count was available and the contents were not.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

/** Three operations whose names share no verb, so no single keyword search
 *  could ever return all of them — only enumeration can. */
const spec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Enumerable API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/alpha": {
        get: {
          operationId: "alphaOp",
          summary: "First operation",
          responses: { "200": { description: "ok" } },
        },
      },
      "/bravo": {
        post: {
          operationId: "bravoOp",
          summary: "Second operation",
          responses: { "200": { description: "ok" } },
        },
      },
      "/charlie": {
        delete: {
          operationId: "charlieOp",
          summary: "Third operation",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });

scenario(
  "Discovery · an integration's full tool catalog is enumerable and reconciles with its reported toolCount",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(api, identity);
    const slug = unique("enum");

    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* client.openapi.addSpec({
          payload: {
            spec: { kind: "blob", value: spec("http://127.0.0.1:59999") },
            slug,
            baseUrl: "http://127.0.0.1:59999", // never contacted: discovery only
            authenticationTemplate: [
              {
                slug: "apiKey",
                type: "apiKey",
                headers: { "x-api-key": [{ type: "variable", name: "token" }] },
              },
            ],
          },
        });
        yield* client.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("main"),
            integration: IntegrationSlug.make(slug),
            template: AuthTemplateSlug.make("apiKey"),
            value: "tok_enum",
          },
        });

        // Everything below runs inside the execute sandbox — the exact
        // surface an agent has.
        const executed = yield* client.executions.execute({
          payload: {
            code: `
const integrations = await tools.executor.integrations.list({ limit: 50 });
const mine = integrations.items.find((item) => item.id === ${JSON.stringify(slug)});

const enumerated = await tools.search({ namespace: ${JSON.stringify(slug)}, query: "", limit: 50 });

// Paged enumeration walks the same census.
const paged = [];
let offset = 0;
for (let i = 0; i < 10; i++) {
  const page = await tools.search({ namespace: ${JSON.stringify(slug)}, query: "", limit: 2, offset });
  paged.push(...page.items.map((item) => item.path));
  if (!page.hasMore) break;
  offset = page.nextOffset;
}

// No namespace + empty query stays empty (no arbitrary workspace dump).
const unscoped = await tools.search({ query: "" });

return JSON.stringify({
  toolCount: mine ? mine.toolCount : null,
  enumeratedTotal: enumerated.total,
  enumeratedPaths: enumerated.items.map((item) => item.path),
  pagedPaths: paged,
  unscopedTotal: unscoped.total,
});
`,
            autoApprove: true,
          },
        });
        expect(executed.status, "the sandbox execution completed").toBe("completed");
        const outcome = JSON.parse(executed.text) as {
          readonly toolCount: number | null;
          readonly enumeratedTotal: number;
          readonly enumeratedPaths: readonly string[];
          readonly pagedPaths: readonly string[];
          readonly unscopedTotal: number;
        };

        // THE guarantee: enumeration returns the whole catalog, and its
        // total reconciles exactly against the integration's toolCount.
        expect(outcome.toolCount, "the integration reports its toolCount").toBe(3);
        expect(outcome.enumeratedTotal, "enumeration returns the full census").toBe(3);
        expect(
          outcome.enumeratedPaths.map((path) => path.split(".").at(-1)).sort(),
          "all three operations are enumerated, despite sharing no searchable verb",
        ).toEqual(["alphaOp", "bravoOp", "charlieOp"]);
        expect(
          outcome.enumeratedPaths,
          "enumeration is path-sorted, so paging is deterministic",
        ).toEqual([...outcome.enumeratedPaths].sort());
        expect(outcome.pagedPaths, "paged enumeration walks the same census in order").toEqual(
          outcome.enumeratedPaths,
        );
        expect(
          outcome.unscopedTotal,
          "an empty query without a namespace still returns nothing",
        ).toBe(0);
      }),
      Effect.gen(function* () {
        yield* client.connections
          .remove({
            params: {
              owner: "org",
              integration: IntegrationSlug.make(slug),
              name: ConnectionName.make("main"),
            },
          })
          .pipe(Effect.ignore);
        yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
      }),
    );
  }),
);
