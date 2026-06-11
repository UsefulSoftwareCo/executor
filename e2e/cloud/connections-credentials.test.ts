// Cloud-only: the connection (credential) lifecycle over the real wire. In v2 a
// connection IS the credential — owner-scoped, bound 1:1 to an integration,
// identified by (owner, integration, name), with its value stored through the
// real vault. The product promises under test: the secret goes in but NEVER
// comes back out of any endpoint; metadata round-trips; re-creating the same
// connection replaces it instead of duplicating; removal really removes; and
// unknown connections fail with a typed not-found error.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

const TEMPLATE_API_KEY = AuthTemplateSlug.make("apiKey");

/** Minimal OpenAPI spec with a single GET /ping — never contacted here. */
const pingSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Ping API", version: "1.0.0" },
  paths: {
    "/ping": {
      get: { operationId: "ping", summary: "Ping", responses: { "200": { description: "pong" } } },
    },
  },
});

/** Registers a fresh apiKey-authenticated integration for connections to bind to. */
const registerIntegration = (client: Client) =>
  Effect.gen(function* () {
    const slug = IntegrationSlug.make(`conn-scn-${randomBytes(4).toString("hex")}`);
    yield* client.openapi.addSpec({
      payload: {
        spec: { kind: "blob", value: pingSpec },
        slug,
        baseUrl: "http://127.0.0.1:59999", // never contacted during registration
        authenticationTemplate: [
          {
            slug: "apiKey",
            type: "apiKey",
            headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
          },
        ],
      },
    });
    return slug;
  });

// Already in canonical identifier form, so the name round-trips unchanged.
const freshConnectionName = () => ConnectionName.make(`conn${randomBytes(4).toString("hex")}`);

scenario(
  "Connections · a stored credential round-trips as metadata and never echoes its value",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: apiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiClient(api, identity);
    const integration = yield* registerIntegration(client);
    const name = freshConnectionName();
    const secretValue = `sk-test-${randomBytes(8).toString("hex")}`;

    const created = yield* client.connections.create({
      payload: {
        owner: "org",
        name,
        integration,
        template: TEMPLATE_API_KEY,
        identityLabel: "My API Token",
        value: secretValue,
      },
    });
    expect(created.name, "create returns the stored connection name").toBe(name);
    expect(created.owner, "the connection is filed under its owner").toBe("org");
    expect(JSON.stringify(created), "the create response never carries the secret").not.toContain(
      secretValue,
    );

    const list = yield* client.connections.list({ query: { integration } });
    const listed = list.find((connection) => connection.name === name);
    expect(listed?.identityLabel, "the listed connection keeps its label").toBe("My API Token");
    expect(JSON.stringify(list), "the list never carries the secret").not.toContain(secretValue);

    const fetched = yield* client.connections.get({
      params: { owner: "org", integration, name },
    });
    expect(fetched.name, "get returns the connection by its identifier").toBe(name);
    expect(fetched.integration, "get returns the connection bound to its integration").toBe(
      integration,
    );
    expect(JSON.stringify(fetched), "get never carries the secret").not.toContain(secretValue);
  }),
);

scenario(
  "Connections · re-creating the same connection replaces it instead of duplicating",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: apiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiClient(api, identity);
    const integration = yield* registerIntegration(client);
    const name = freshConnectionName();

    yield* client.connections.create({
      payload: {
        owner: "org",
        name,
        integration,
        template: TEMPLATE_API_KEY,
        identityLabel: "first key",
        value: "first-value",
      },
    });
    const first = yield* client.connections.list({ query: { integration } });
    expect(
      first.filter((connection) => connection.name === name).map((c) => c.identityLabel),
      "the first create stores one row with its label",
    ).toEqual(["first key"]);

    yield* client.connections.create({
      payload: {
        owner: "org",
        name,
        integration,
        template: TEMPLATE_API_KEY,
        identityLabel: "rotated key",
        value: "second-value",
      },
    });
    const second = yield* client.connections.list({ query: { integration } });
    expect(
      second.filter((connection) => connection.name === name).map((c) => c.identityLabel),
      "re-creating the same (owner, integration, name) updates the row in place",
    ).toEqual(["rotated key"]);
  }),
);

scenario(
  "Connections · a removed connection disappears from both list and get",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: apiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiClient(api, identity);
    const integration = yield* registerIntegration(client);
    const name = freshConnectionName();

    yield* client.connections.create({
      payload: { owner: "org", name, integration, template: TEMPLATE_API_KEY, value: "v" },
    });

    const removed = yield* client.connections.remove({
      params: { owner: "org", integration, name },
    });
    expect(removed.removed, "remove acknowledges the deletion").toBe(true);

    const list = yield* client.connections.list({ query: { integration } });
    expect(
      list.map((connection) => connection.name),
      "the removed connection is gone from the list",
    ).not.toContain(name);

    const error = yield* client.connections
      .get({ params: { owner: "org", integration, name } })
      .pipe(Effect.flip);
    expect(
      (error as { _tag?: string })._tag,
      "get after remove fails with the typed not-found error",
    ).toBe("ConnectionNotFoundError");
  }),
);

scenario(
  "Connections · reading or removing an unknown connection fails with not-found",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: apiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiClient(api, identity);
    const integration = yield* registerIntegration(client);
    const missing = freshConnectionName();

    const getError = yield* client.connections
      .get({ params: { owner: "org", integration, name: missing } })
      .pipe(Effect.flip);
    expect(
      (getError as { _tag?: string })._tag,
      "get on an unknown connection fails with the typed not-found error",
    ).toBe("ConnectionNotFoundError");

    const removeError = yield* client.connections
      .remove({ params: { owner: "org", integration, name: missing } })
      .pipe(Effect.flip);
    expect(
      (removeError as { _tag?: string })._tag,
      "remove on an unknown connection fails with the typed not-found error",
    ).toBe("ConnectionNotFoundError");
  }),
);
