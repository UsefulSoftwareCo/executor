import { randomBytes } from "node:crypto";
import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";
import { createEmulatorInstance } from "../src/emulator-instance";
import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([openApiHttpPlugin()] as const);
const outcome = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Boolean,
    http: Schema.optional(Schema.Struct({ status: Schema.Number })),
    error: Schema.optional(Schema.Struct({ code: Schema.String })),
  }),
);

scenario(
  "OpenAPI · wildcard paths execute with the declared parameter",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(api, identity);
    const slug = IntegrationSlug.make(`wildcard-${randomBytes(4).toString("hex")}`);
    const baseUrl = yield* createEmulatorInstance("resend", "wildcard-path");
    yield* Effect.gen(function* () {
      yield* client.openapi.addSpec({
        payload: {
          slug,
          name: "Wildcard paths",
          baseUrl,
          spec: {
            kind: "blob",
            value: JSON.stringify({
              openapi: "3.0.3",
              info: { title: "Wildcard paths", version: "1" },
              servers: [{ url: baseUrl }],
              paths: {
                "/{*identifier}": {
                  get: {
                    operationId: "readPath",
                    parameters: [
                      {
                        name: "identifier",
                        in: "path",
                        required: true,
                        schema: { type: "string" },
                      },
                    ],
                    responses: { "200": { description: "Public emulator manifest" } },
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
      const tools = yield* client.tools.list({ query: {} });
      const tool = tools.find((t) => String(t.integration) === slug && t.name.includes("readPath"));
      expect(tool).toBeDefined();
      const schema = yield* client.tools.schema({ query: { address: tool!.address } });
      expect(schema.inputSchema).toMatchObject({ required: ["identifier"] });
      const outcomes = [];
      for (const args of [
        { identifier: "_emulate/manifest" },
        {},
        { identifier: "../_emulate/manifest" },
      ]) {
        const executed = yield* client.executions.execute({
          payload: {
            code: `const parts = ${JSON.stringify(tool!.address)}.split('.').slice(1); let tool = tools; for (const part of parts) tool = tool[part]; return JSON.stringify(await tool(${JSON.stringify(args)}));`,
            autoApprove: true,
          },
        });
        expect(executed.status).toBe("completed");
        const result = yield* Schema.decodeUnknownEffect(outcome)(executed.text);
        outcomes.push(result);
      }
      expect(outcomes).toMatchObject([
        { ok: true, http: { status: 200 } },
        { ok: false, error: { code: "invalid_tool_arguments" } },
        { ok: false, error: { code: "invalid_tool_arguments" } },
      ]);
      yield* browser.session(identity, async ({ page, step }) => {
        await step("Inspect the integration after its wildcard tool succeeds", async () => {
          await visit(page, `/integrations/${slug}`);
          await page.getByText("Wildcard paths", { exact: true }).first().waitFor();
        });
      });
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
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
