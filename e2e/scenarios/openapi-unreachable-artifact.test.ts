// Cross-target: an artifact whose OpenAPI query cannot reach its upstream gets
// an actionable network error, not the opaque defect mask. This walks the real
// path from a saved artifact through the nested shell, execute-action, sandbox,
// OpenAPI transport, and back into ArtifactError.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { ConnectionName, IntegrationSlug, type ArtifactId } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Mcp, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";
import type { McpSession } from "../src/surfaces/mcp";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

type DroppingUpstream = {
  readonly url: string;
  readonly requests: () => number;
  readonly close: () => void;
};

// Accept the request, then drop the socket before sending response headers.
// This produces a real transport failure without relying on a hardcoded or
// temporarily-unused port.
const serveDroppingUpstream = () =>
  Effect.acquireRelease(
    Effect.callback<DroppingUpstream>((resume) => {
      let hits = 0;
      const server = createServer((_request, response) => {
        hits += 1;
        response.destroy();
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}`,
            requests: () => hits,
            close: () => {
              server.close();
              server.closeAllConnections();
            },
          }),
        );
      });
    }),
    (server) => Effect.sync(server.close),
  );

const unreachableSpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Unreachable API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/things": {
        get: {
          tags: ["things"],
          operationId: "listThings",
          summary: "List things",
          responses: {
            "200": {
              description: "Things",
              content: {
                "application/json": {
                  schema: { type: "array", items: { type: "object" } },
                },
              },
            },
          },
        },
      },
    },
  });

const createConnectionCode = (slug: string) => `
const created = await tools.executor.coreTools.connections.create({
  owner: "org",
  name: "public",
  integration: ${JSON.stringify(slug)},
  template: "none",
});
return JSON.stringify(created.ok ? { ok: true } : { ok: false, error: created.error });
`;

const executeApproved = (session: McpSession, code: string) =>
  Effect.gen(function* () {
    let result = yield* session.call("execute", { code });
    let guard = 0;
    while (result.text.includes("executionId:") && guard < 10) {
      result = yield* session.approvePaused(result.text);
      guard += 1;
    }
    expect(result.ok, `execute completed (got: ${result.text.slice(0, 400)})`).toBe(true);
    return result.text;
  });

const artifactSource = (slug: string) => `
function App() {
  const query = useQuery(tools.${slug}.things.listThings.queryOptions({}));
  const result = query.data;
  return (
    <div className="flex h-full flex-col gap-4">
      <h2>Upstream status</h2>
      <div data-testid="upstream-state" className="min-h-0 flex-1">
        {query.isLoading ? (
          <ArtifactLoading />
        ) : query.error ? (
          <ArtifactError error={query.error} onRetry={query.refetch} />
        ) : result?.ok === false ? (
          <ArtifactError error={result.error} onRetry={query.refetch} />
        ) : (
          <p>Unexpected upstream success</p>
        )}
      </div>
    </div>
  );
}
`;

const structuredOf = (result: { readonly raw: unknown }): Record<string, unknown> =>
  ((result.raw as { structuredContent?: Record<string, unknown> }).structuredContent ??
    {}) as Record<string, unknown>;

const artifactContent = (page: Page) =>
  page.frameLocator('[data-testid="artifact-shell-frame"]').frameLocator("iframe");

scenario(
  "Artifacts · an unreachable OpenAPI host shows actionable retry guidance instead of an internal error",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const mcp = yield* Mcp;
      const { client: makeClient } = yield* Api;

      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const session = mcp.session(identity);
      const upstream = yield* serveDroppingUpstream();
      const slug = unique("unreachable");
      const title = `Unreachable upstream ${randomBytes(4).toString("hex")}`;
      let artifactId: ArtifactId | undefined;

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            payload: {
              spec: { kind: "blob", value: unreachableSpec(upstream.url) },
              slug,
              baseUrl: upstream.url,
            },
          });

          const created = yield* executeApproved(session, createConnectionCode(slug));
          expect(created, `the no-auth connection was created: ${created}`).toContain('"ok":true');

          const rendered = yield* session.call("create-artifact", {
            code: artifactSource(slug),
            title,
            description: "Shows whether the upstream API is reachable",
            connections: { [slug]: `${slug}.org.public` },
          });
          expect(rendered.ok, `create-artifact succeeded: ${rendered.text}`).toBe(true);

          const structured = structuredOf(rendered);
          artifactId = structured.artifactId as ArtifactId;
          expect(artifactId, "the artifact was persisted").toBeTruthy();

          yield* browser.session(identity, async ({ page, step }) => {
            await step("Open the artifact that reads from the unreachable API", async () => {
              await visit(page, String(structured.url));
              await page.getByRole("heading", { name: title }).waitFor({ timeout: 20_000 });
            });

            await step(
              "The artifact explains that the upstream host could not be reached",
              async () => {
                const state = artifactContent(page).getByTestId("upstream-state");
                await state.locator('[data-slot="artifact-error"]').waitFor({ timeout: 30_000 });
                const message = await state.innerText();

                expect(message, "the user gets actionable network guidance").toContain(
                  "Could not reach the upstream server",
                );
                expect(message, "the opaque defect mask never reaches the artifact").not.toContain(
                  "Internal tool error",
                );
                expect(message, "the request path is not leaked").not.toContain("/things");
              },
            );
          });

          expect(upstream.requests(), "the artifact made a real upstream request").toBeGreaterThan(
            0,
          );
        }),
        Effect.gen(function* () {
          if (artifactId !== undefined) {
            yield* client.artifacts.remove({ params: { artifactId } }).pipe(Effect.ignore);
          }
          yield* client.connections
            .remove({
              params: {
                owner: "org",
                integration: IntegrationSlug.make(slug),
                name: ConnectionName.make("public"),
              },
            })
            .pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
