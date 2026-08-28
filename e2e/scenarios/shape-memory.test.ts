// Cross-target: muscle memory — runtime-observed output shapes. Most OpenAPI
// operations declare no response schema, so `tools.describe.tool()` used to
// render `data: unknown` forever and the model had to guess response shapes.
// This journey proves the warm path end to end through public surfaces only:
// a schemaless tool describes as `unknown`, one real invocation against a live
// upstream teaches the shape, and the very next describe serves a real
// TypeScript type marked as observed.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

/** One GET operation whose 200 declares no response schema — the shape the
 *  model would otherwise have to guess. */
const issuesSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Issues API", version: "1.0.0" },
  paths: {
    "/issues": {
      get: {
        operationId: "listIssues",
        summary: "List issues",
        responses: { "200": { description: "issues" } },
      },
    },
  },
});

/** A live upstream for the single invocation that teaches the shape. */
const serveIssuesFixture = Effect.acquireRelease(
  Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          issues: [
            { id: 1, title: "first", open: true },
            { id: 2, title: "second", open: false },
          ],
          total: 2,
        }),
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const addressInfo = server.address();
      const port = typeof addressInfo === "object" && addressInfo !== null ? addressInfo.port : 0;
      resume(
        Effect.succeed({
          url: `http://127.0.0.1:${port}`,
          close: () => {
            server.close();
            server.closeAllConnections();
          },
        }),
      );
    });
  }),
  (fixture) => Effect.sync(fixture.close),
);

const describeCode = (slug: string) => `
const details = await tools.describe.tool({ path: "${slug}.org.main.issues.listIssues" });
return {
  outputTypeScript: details.outputTypeScript ?? null,
  note: details.outputTypeScriptNote ?? null,
  error: details.error ?? null,
};
`;

type DescribeOutcome = {
  readonly outputTypeScript: string | null;
  readonly note: string | null;
  readonly error: unknown;
};

scenario(
  "Muscle memory · a schemaless tool's observed output shape reaches describe",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const slug = IntegrationSlug.make(`shape_memory_${randomBytes(4).toString("hex")}`);
      const upstream = yield* serveIssuesFixture;

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            payload: {
              spec: { kind: "blob", value: issuesSpec },
              slug,
              baseUrl: upstream.url,
              authenticationTemplate: [
                {
                  slug: "apiKey",
                  type: "apiKey",
                  headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
                },
              ],
            },
          });
          yield* client.connections.create({
            payload: {
              owner: "org",
              name: ConnectionName.make("main"),
              integration: slug,
              template: AuthTemplateSlug.make("apiKey"),
              value: `key_${randomBytes(8).toString("hex")}`,
            },
          });

          const describe = Effect.gen(function* () {
            const executed = yield* client.executions.execute({
              payload: { code: describeCode(String(slug)), autoApprove: true },
            });
            expect(executed.status, executed.text).toBe("completed");
            return JSON.parse(executed.text) as DescribeOutcome;
          });

          // Cold: no declared response schema — the model sees unknown.
          const cold = yield* describe;
          expect(cold.error, "the tool resolves").toBeNull();
          expect(cold.outputTypeScript, "cold describe has no shape").toContain("data: unknown;");
          expect(cold.note, "cold describe carries no provenance note").toBeNull();

          // One real call against the live upstream teaches the shape.
          const invoked = yield* client.executions.execute({
            payload: {
              code: `
const result = await tools.${slug}.org.main.issues.listIssues({});
return { ok: result.ok };
`,
              autoApprove: true,
            },
          });
          expect(invoked.status, invoked.text).toBe("completed");
          expect(JSON.parse(invoked.text), "the teaching call succeeded").toEqual({ ok: true });

          // Warm: the observed shape is served, marked as observed.
          const warm = yield* describe;
          expect(warm.outputTypeScript, "warm describe serves the observed shape").toContain(
            "issues",
          );
          expect(warm.outputTypeScript, "field types come from the live payload").toContain(
            "total",
          );
          expect(warm.outputTypeScript, "the shape no longer collapses").not.toContain(
            "data: unknown;",
          );
          expect(warm.note, "provenance is explicit").toContain("observed from 1 live response");
        }),
        Effect.gen(function* () {
          yield* client.connections
            .remove({
              params: {
                owner: "org",
                integration: slug,
                name: ConnectionName.make("main"),
              },
            })
            .pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
