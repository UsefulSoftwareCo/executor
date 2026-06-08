// Connection endpoints — create / list / get / remove round-trip and error
// fidelity within a single org (v2).
//
// Ports the v1 "secrets api" suite. In v2 a connection IS the credential:
// owner-scoped, bound 1:1 to an integration, identified by (owner, integration,
// name). There is no scope id and no separate secret value endpoint — the value
// is stored through the connection's provider and never echoed back.

import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  connectionIdentifier,
} from "@executor-js/sdk";
import { makeOpenApiHttpApiTestAddSpecPayload } from "@executor-js/plugin-openapi/testing";

import { asOrg } from "../testing/api-harness";

const PingApi = HttpApi.make("connectionsApiTest")
  .add(
    HttpApiGroup.make("default", { topLevel: true }).add(
      HttpApiEndpoint.get("ping", "/ping", { success: Schema.Unknown }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "Connections API Test", version: "1.0.0" }));

const TEMPLATE_API_KEY = AuthTemplateSlug.make("apiKey");
const canonicalConnectionName = (name: ConnectionName): ConnectionName =>
  connectionIdentifier(String(name));

// Registers a minimal openapi integration so connections have something to bind
// to, then returns its slug.
const registerIntegration = (org: string) =>
  Effect.gen(function* () {
    const slug = IntegrationSlug.make(`ns_${crypto.randomUUID().replace(/-/g, "_")}`);
    yield* asOrg(org, (client) =>
      client.openapi.addSpec({
        payload: makeOpenApiHttpApiTestAddSpecPayload(PingApi, {
          slug,
          baseUrl: "http://example.com",
        }),
      }),
    );
    return slug;
  });

describe("connections api (HTTP)", () => {
  it.effect("create → list → get returns connection metadata without the value", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const integration = yield* registerIntegration(org);
      const name = ConnectionName.make(`conn_${crypto.randomUUID().slice(0, 8)}`);
      const storedName = canonicalConnectionName(name);

      const secretValue = "sk-test-abc";
      const created = yield* asOrg(org, (client) =>
        client.connections.create({
          payload: {
            owner: "org",
            name,
            integration,
            template: TEMPLATE_API_KEY,
            identityLabel: "My API Token",
            value: secretValue,
          },
        }),
      );
      expect(created.name).toBe(storedName);
      expect(created.owner).toBe("org");
      expect(JSON.stringify(created)).not.toContain(secretValue);

      const list = yield* asOrg(org, (client) =>
        client.connections.list({ query: { integration } }),
      );
      expect(list.find((c) => c.name === storedName)?.identityLabel).toBe("My API Token");
      expect(JSON.stringify(list)).not.toContain(secretValue);

      const fetched = yield* asOrg(org, (client) =>
        client.connections.get({ params: { owner: "org", integration, name: storedName } }),
      );
      expect(fetched.name).toBe(storedName);
      expect(fetched.integration).toBe(integration);
    }),
  );

  it.effect("get on an unknown connection fails with ConnectionNotFoundError", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const integration = yield* registerIntegration(org);
      const missing = ConnectionName.make(`missing_${crypto.randomUUID().slice(0, 8)}`);

      const result = yield* asOrg(org, (client) =>
        client.connections
          .get({ params: { owner: "org", integration, name: missing } })
          .pipe(Effect.result),
      );
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it.effect("remove deletes the connection; list drops it and get fails", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const integration = yield* registerIntegration(org);
      const name = ConnectionName.make(`conn_${crypto.randomUUID().slice(0, 8)}`);
      const storedName = canonicalConnectionName(name);

      yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          yield* client.connections.create({
            payload: { owner: "org", name, integration, template: TEMPLATE_API_KEY, value: "v" },
          });
          const removed = yield* client.connections.remove({
            params: { owner: "org", integration, name: storedName },
          });
          expect(removed.removed).toBe(true);
        }),
      );

      const list = yield* asOrg(org, (client) =>
        client.connections.list({ query: { integration } }),
      );
      expect(list.map((c) => c.name)).not.toContain(storedName);

      const afterGet = yield* asOrg(org, (client) =>
        client.connections
          .get({ params: { owner: "org", integration, name: storedName } })
          .pipe(Effect.result),
      );
      expect(Result.isFailure(afterGet)).toBe(true);
    }),
  );

  it.effect("remove on an unknown connection fails with ConnectionNotFoundError", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const integration = yield* registerIntegration(org);
      const missing = ConnectionName.make(`missing_${crypto.randomUUID().slice(0, 8)}`);

      const result = yield* asOrg(org, (client) =>
        client.connections
          .remove({ params: { owner: "org", integration, name: missing } })
          .pipe(Effect.result),
      );
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it.effect("create with the same (owner, integration, name) twice updates the metadata", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const integration = yield* registerIntegration(org);
      const name = ConnectionName.make(`conn_${crypto.randomUUID().slice(0, 8)}`);
      const storedName = canonicalConnectionName(name);

      const first = yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          yield* client.connections.create({
            payload: {
              owner: "org",
              name,
              integration,
              template: TEMPLATE_API_KEY,
              identityLabel: "first",
              value: "first-value",
            },
          });
          return yield* client.connections.list({ query: { integration } });
        }),
      );
      expect(first.find((c) => c.name === storedName)?.identityLabel).toBe("first");

      const second = yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          yield* client.connections.create({
            payload: {
              owner: "org",
              name,
              integration,
              template: TEMPLATE_API_KEY,
              identityLabel: "updated",
              value: "second-value",
            },
          });
          return yield* client.connections.list({ query: { integration } });
        }),
      );
      expect(second.find((c) => c.name === storedName)?.identityLabel).toBe("updated");
    }),
  );
});
