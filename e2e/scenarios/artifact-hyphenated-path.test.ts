import { randomBytes } from "node:crypto";
import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  ArtifactId,
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
} from "@executor-js/sdk/shared";

import { createEmulatorInstance } from "../src/emulator-instance";
import { scenario } from "../src/scenario";
import { Api, Browser, Mcp, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([openApiHttpPlugin()] as const);
const decodeCreatedArtifact = Schema.decodeUnknownSync(
  Schema.Struct({ structuredContent: Schema.Struct({ artifactId: ArtifactId }) }),
);

scenario(
  "Artifacts · a hyphenated integration renders live tool data through a bracket path",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const mcp = yield* Mcp;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(api, identity);
    const session = mcp.session(identity);
    const slug = IntegrationSlug.make(`artifact-schema-${randomBytes(4).toString("hex")}`);
    const baseUrl = yield* createEmulatorInstance("resend", "artifact-path");
    let artifactId: ArtifactId | undefined;

    yield* Effect.gen(function* () {
      // The emulator's public schema is a real JSON endpoint. Its descriptive
      // title gives the rendered query a stable caller-visible result.
      yield* client.openapi.addSpec({
        payload: {
          slug,
          baseUrl,
          spec: {
            kind: "blob",
            value: JSON.stringify({
              openapi: "3.0.3",
              info: { title: "Service schema", version: "1" },
              servers: [{ url: baseUrl }],
              paths: {
                "/openapi.json": {
                  get: {
                    operationId: "readSchema",
                    responses: { "200": { description: "Schema" } },
                  },
                },
              },
            }),
          },
        },
      });
      yield* client.connections.create({
        payload: {
          owner: "org",
          name: ConnectionName.make("public"),
          integration: slug,
          template: AuthTemplateSlug.make("none"),
          values: {},
        },
      });
      const created = yield* session.call("create-artifact", {
        title: `Service schema ${slug}`,
        code: `function App() {
          const query = useQuery(tools['${slug}'].openapiJson.readSchema.queryOptions({}));
          return <pre data-testid="live-schema">{query.isPending ? "Loading schema" : JSON.stringify(query.data ?? query.error)}</pre>;
        }`,
      });
      expect(created.ok, created.text).toBe(true);
      const envelope = decodeCreatedArtifact(created.raw);
      artifactId = envelope.structuredContent.artifactId;
      yield* browser.session(identity, async ({ page, step }) => {
        await step("Open the artifact and read the service schema", async () => {
          await visit(page, `/artifacts/${artifactId}`);
          const data = page
            .frameLocator('[data-testid="artifact-shell-frame"]')
            .frameLocator("iframe")
            .getByTestId("live-schema");
          await data.waitFor({ timeout: 30_000 });
          await data.filter({ hasText: /Resend/i }).waitFor({ timeout: 30_000 });
          expect(await data.textContent()).toContain("openapi");
        });
      });
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (artifactId !== undefined)
            yield* client.artifacts.remove({ params: { artifactId } }).pipe(Effect.ignore);
          yield* client.connections
            .remove({
              params: { owner: "org", integration: slug, name: ConnectionName.make("public") },
            })
            .pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      ),
    );
  }),
);
