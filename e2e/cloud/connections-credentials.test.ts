// Cloud-only: the connection (credential) lifecycle over the real wire. In v2 a
// connection IS the credential — owner-scoped, bound 1:1 to an integration,
// identified by (owner, integration, name), with its value stored through the
// real vault. The product promises under test: the secret goes in but NEVER
// comes back out of any endpoint; metadata round-trips; re-creating the same
// connection is rejected as a conflict instead of silently replacing it;
// removal really removes; and unknown connections fail with a typed
// not-found error.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

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

/** Minimal OpenAPI spec with a single GET /ping — only the conflict scenario
 *  ever contacts it, to prove which stored secret the connection resolves. */
const pingSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Ping API", version: "1.0.0" },
  paths: {
    "/ping": {
      get: { operationId: "ping", summary: "Ping", responses: { "200": { description: "pong" } } },
    },
  },
});

type CaptureUpstream = {
  readonly url: string;
  /** Every Authorization header `GET /ping` has received, in order. */
  readonly authorizationHeaders: () => readonly string[];
  readonly close: () => void;
};

/** Upstream on 127.0.0.1 that records the Authorization header of every
 *  `GET /ping`. This is how a scenario proves WHICH stored secret a connection
 *  resolves, since no endpoint ever echoes the value itself. */
const serveCaptureUpstream = () =>
  Effect.acquireRelease(
    Effect.callback<CaptureUpstream>((resume) => {
      const headers: string[] = [];
      const server = createServer((request, response) => {
        if (request.method === "GET" && (request.url ?? "").startsWith("/ping")) {
          headers.push(request.headers.authorization ?? "");
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ pong: true }));
          return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}`,
            authorizationHeaders: () => [...headers],
            close: () => {
              server.close();
              server.closeAllConnections();
            },
          }),
        );
      });
    }),
    (upstream) => Effect.sync(upstream.close),
  );

/** Registers a fresh apiKey-authenticated integration for connections to bind
 *  to. Identifier-safe slug: it becomes a property path in sandbox code. */
const registerIntegration = (client: Client, baseUrl = "http://127.0.0.1:59999") =>
  Effect.gen(function* () {
    const slug = IntegrationSlug.make(`connscn${randomBytes(4).toString("hex")}`);
    yield* client.openapi.addSpec({
      payload: {
        spec: { kind: "blob", value: pingSpec },
        slug,
        baseUrl, // the default is never contacted during registration
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
  "Connections · re-creating the same connection is rejected and leaves the original intact",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: apiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* apiClient(api, identity);
      const upstream = yield* serveCaptureUpstream();
      const integration = yield* registerIntegration(client, upstream.url);
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

      const error = yield* client.connections
        .create({
          payload: {
            owner: "org",
            name,
            integration,
            template: TEMPLATE_API_KEY,
            identityLabel: "clobber attempt",
            value: "second-value",
          },
        })
        .pipe(Effect.flip);
      expect(
        (error as { _tag?: string })._tag,
        "re-creating the same (owner, integration, name) fails with the typed conflict",
      ).toBe("ConnectionAlreadyExistsError");

      const second = yield* client.connections.list({ query: { integration } });
      expect(
        second.filter((connection) => connection.name === name).map((c) => c.identityLabel),
        "the rejected create left the original row untouched",
      ).toEqual(["first key"]);

      // The stored SECRET is intact too, not just the metadata: invoking
      // through the original connection must still authenticate upstream with
      // the first value. The pasted value's provider item id is derived from
      // the connection name, so a rejected create that wrote before losing
      // would have replaced the credential while every metadata read above
      // still looked untouched.
      const tools = yield* client.tools.list({ query: { integration } });
      const address = tools
        .map((tool) => String(tool.address))
        .find((toolAddress) => toolAddress.includes(".ping."));
      expect(address, "the ping tool is in the catalog").toBeDefined();
      if (address === undefined) return;

      const execution = yield* client.executions.execute({
        payload: {
          code: [`const result = await ${address}({});`, "return result;"].join("\n"),
        },
      });
      expect(execution.status, "the invoke completes").toBe("completed");
      expect(
        upstream.authorizationHeaders(),
        "the original connection still authenticates with the first value",
      ).toEqual(["Bearer first-value"]);
    }),
  ),
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
