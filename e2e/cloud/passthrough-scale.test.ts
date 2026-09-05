// Cloud: a passthrough MCP session over a production-shaped catalog serves
// every visible tool, and connects in time that is bounded by ONE batched read
// of the catalog, not one round-trip per tool.
//
// Passthrough (`?mode=passthrough`) has no `execute` to hide behind: the whole
// catalog goes on the wire as tool definitions. That is the mode's design
// constraint, so it is proven at the scale it will meet — the same seeded
// workspace the toolkit-perf scenario uses (one real OpenAPI spec plus synthetic
// integrations, ~3,300 tools over 11 integrations). Two things must hold:
//
//   1. Completeness: every tool `tools.list` shows the caller is served, under
//      an MCP-safe unique name. A silent cap would make tools unreachable with
//      no way to discover why.
//   2. Cost: the list is built from `tools.describeAll` (rows + $defs + the
//      policy rule set, each read once). A per-tool `schema()` or `resolve()`
//      here would be an N+1 that scales with catalog size and pushes the
//      connect past the client's timeout, exactly the regression the toolkit
//      scenario guards against.
//
// The `?integrations=` filter is proven here too, because at this scale it is
// how a real user trims the surface.

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";
import { catalogApi, seedLargeCatalog } from "../scenarios/support/large-catalog";

// The wall-clock a ~3,300-tool passthrough list is allowed to take, handshake
// included. A batched build is a few hundred ms of reads plus serialization of
// a few MB of schema; a per-tool N+1 is tens of seconds. 20s is decisive
// without being flaky on a loaded CI runner.
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
          // the passthrough list must match one-to-one — minus the plugins'
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

          // Completeness: one served tool per visible tool, no more, no less.
          expect(served.length, "every visible tool is served").toBe(visible.length);
          const names = served.map((tool) => tool.name);
          expect(new Set(names).size, "every served name is unique").toBe(names.length);
          for (const name of names) {
            expect(name, "every name fits the MCP grammar").toMatch(/^[A-Za-z0-9_-]{1,64}$/);
          }
          // Every integration in the catalog is represented under its prefix.
          for (const slug of seeded.integrationSlugs) {
            expect(
              names.some((name) => name.startsWith(`${slug}__`)),
              `integration ${slug} is served`,
            ).toBe(true);
          }
          // The codemode surface is absent.
          expect(names, "no execute").not.toContain("execute");
          expect(names, "no resume").not.toContain("resume");

          // Every served tool carries explicit hints and a usable schema: the
          // real Vercel spec has POST/DELETE operations (destructive) and GETs
          // (read-only), so both values must appear.
          const hints = new Set<string>();
          for (const tool of served) {
            const annotations = tool.annotations ?? {};
            expect(
              typeof annotations.destructiveHint,
              `${tool.name} sets destructiveHint explicitly`,
            ).toBe("boolean");
            expect(typeof annotations.readOnlyHint, `${tool.name} sets readOnlyHint`).toBe(
              "boolean",
            );
            hints.add(`${annotations.readOnlyHint}/${annotations.destructiveHint}`);
            expect(tool.inputSchema, `${tool.name} advertises an input schema`).toBeDefined();
          }
          expect(hints.has("true/false"), "some tools are read-only").toBe(true);
          expect(hints.has("false/true"), "some tools require approval").toBe(true);

          // `?integrations=` trims the surface to one integration.
          const one = seeded.integrationSlugs[0]!;
          const narrowed = mcp.session(identity, { mode: "passthrough", integrations: [one] });
          const narrowedNames = yield* narrowed.listTools();
          expect(narrowedNames.length, "the filter serves only one integration").toBe(
            visible.filter((tool) => String(tool.integration) === one).length,
          );
          for (const name of narrowedNames) {
            expect(name.startsWith(`${one}__`), `${name} belongs to ${one}`).toBe(true);
          }
        }),
        seeded.cleanup,
      );
    }),
  ),
);
