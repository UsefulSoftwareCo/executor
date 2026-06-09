// ---------------------------------------------------------------------------
// Cloud app auth failure propagation (v2)
// ---------------------------------------------------------------------------
//
// Exercises the cloud HTTP API boundary:
//
//   test -> HttpApiClient -> ProtectedCloudApi -> execution engine
//        -> sandbox code -> OpenAPI tool invocation
//
// v2: a connection IS the credential. `addSpec` registers the integration with
// an apiKey auth template; a connection is then created whose value cannot
// resolve (a `from` reference to a WorkOS Vault item that was never stored).
// Invoking one of that connection's tools surfaces `connection_value_missing`
// to the model instead of an opaque internal tool error.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpApi, HttpApiClient, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
} from "@executor-js/sdk";
import { makeOpenApiHttpApiTestAddSpecPayload } from "@executor-js/plugin-openapi/testing";

import { ProtectedCloudApi, asOrg } from "../testing/api-harness";

const PingGroup = HttpApiGroup.make("default", { topLevel: true }).add(
  HttpApiEndpoint.get("ping", "/ping", { success: Schema.Unknown }),
);

const MissingAuthSourceApi = HttpApi.make("cloudAuthFailureSource").add(PingGroup);

const API_KEY_TEMPLATE = "apiKey";
// The cloud default credential provider is the WorkOS Vault; a `from` reference
// to an item id that was never stored resolves to `null`.
const VAULT_PROVIDER = ProviderKey.make("workos-vault");

type CloudApiShape = HttpApiClient.ForApi<typeof ProtectedCloudApi>;
type EffectSuccess<T> = T extends Effect.Effect<infer A, unknown, unknown> ? A : never;
type ExecuteResult = EffectSuccess<ReturnType<CloudApiShape["executions"]["execute"]>>;

const expectModelVisibleAuthFailure = (execution: ExecuteResult) => {
  expect(execution.status).toBe("completed");
  if (execution.status !== "completed") return;
  expect(execution.isError).toBe(false);
  expect(JSON.stringify(execution.structured)).not.toContain("Internal tool error");
  expect(JSON.stringify(execution.structured)).not.toContain("Internal Tool Error");
  expect(execution.structured).toMatchObject({
    status: "completed",
    result: {
      ok: false,
      error: {
        code: "connection_value_missing",
        details: {
          category: "authentication",
        },
      },
    },
  });
};

describe("cloud auth tool failures", () => {
  it.effect("cloud propagates a missing credential value as a model-visible auth failure", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const integration = IntegrationSlug.make(`auth_${crypto.randomUUID().replace(/-/g, "_")}`);
      const connection = ConnectionName.make("main");

      yield* asOrg(org, (client) =>
        client.openapi.addSpec({
          payload: {
            ...makeOpenApiHttpApiTestAddSpecPayload(MissingAuthSourceApi, {
              slug: integration,
              authenticationTemplate: [
                {
                  slug: AuthTemplateSlug.make(API_KEY_TEMPLATE),
                  type: "apiKey",
                  headers: {
                    Authorization: ["Bearer ", { type: "variable", name: "token" }],
                  },
                },
              ],
            }),
            baseUrl: "https://api.example.test",
          },
        }),
      );

      // Create an org connection whose value cannot resolve: a `from` reference
      // to a vault item that was never stored resolves to null.
      yield* asOrg(org, (client) =>
        client.connections.create({
          payload: {
            owner: "org",
            name: connection,
            integration,
            template: AuthTemplateSlug.make(API_KEY_TEMPLATE),
            from: {
              provider: VAULT_PROVIDER,
              id: ProviderItemId.make(`${integration}-missing`),
            },
          },
        }),
      );

      const execution = yield* asOrg(org, (client) =>
        client.executions.execute({
          payload: {
            code: [
              `const result = await tools.${integration}.org.${connection}.default.ping({});`,
              "return result;",
            ].join("\n"),
          },
        }),
      );

      expectModelVisibleAuthFailure(execution);
    }),
  );
});
