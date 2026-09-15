// Large catalogs stay server-side and remain searchable within the connect timeout.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { decodeToolSearch } from "../scenarios/support/search-invoke";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";
import { catalogApi, seedLargeCatalog } from "../scenarios/support/large-catalog";

// Catalog loading and the two-tool handshake must complete within 20 seconds.
const MAX_PASSTHROUGH_CONNECT_MS = 20_000;

scenario(
  "Passthrough · a production-shaped catalog is served completely, in bounded time",
  { timeout: 300_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const mcp = yield* Mcp;
      const { client: makeClient } = yield* Api;

      const identity = yield* target.newIdentity();
      const client = yield* makeClient(catalogApi, identity);
      const seeded = yield* seedLargeCatalog(client);

      yield* Effect.ensuring(
        Effect.gen(function* () {
          // What the caller can see through the typed API is the ground truth
          // search results must cover completely — minus the plugins'
          // static configuration tools (`executor.*`, `openapi.addSpec`, …),
          // which are codemode affordances and deliberately not served here.
          const visible = (yield* client.tools.list({ query: {} })).filter(
            (tool) => tool.static !== true,
          );
          expect(visible.length, "the seeded catalog is large").toBeGreaterThan(3000);

          const session = mcp.session(identity, { mode: "passthrough" });
          const startedAt = Date.now();
          const served = yield* session.describeTools();
          const elapsedMs = Date.now() - startedAt;

          expect(
            elapsedMs,
            `a ${visible.length}-tool passthrough connect stays bounded (took ${elapsedMs}ms)`,
          ).toBeLessThan(MAX_PASSTHROUGH_CONNECT_MS);

          expect(served.map((tool) => tool.name).sort()).toEqual(["invoke", "search"]);
          const first = decodeToolSearch(
            (yield* session.call("search", { query: "org", limit: 20 })).raw,
          ).structuredContent;
          expect(first.total).toBe(visible.length);
          expect(first.items).toHaveLength(20);
          expect(first.nextOffset).toBe(20);
          const last = decodeToolSearch(
            (yield* session.call("search", { query: "org", offset: visible.length - 1 })).raw,
          ).structuredContent;
          expect(last.items).toHaveLength(1);
          expect(last.hasMore).toBe(false);
          expect(last.nextOffset).toBeNull();
          for (const slug of seeded.integrationSlugs) {
            const found = decodeToolSearch(
              (yield* session.call("search", { query: slug })).raw,
            ).structuredContent;
            expect(
              found.items.some((tool) => tool.integration === slug),
              `${slug} is discoverable`,
            ).toBe(true);
          }
        }),
        seeded.cleanup,
      );
    }),
  ),
);
