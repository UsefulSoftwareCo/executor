// Cross-target: connection health checks, the feature that answers "has this
// credential expired?" (the Google 7-day dev-token case) and "whose account is
// this?" in one declared probe. Entirely through the typed client:
//
//   1. register an OpenAPI integration whose `GET /me` is auth-gated,
//   2. CONFIGURE a health check by picking that operation (the same flow the
//      user drives in the editor: list candidates, ranked GET-first, then set),
//   3. VALIDATE a pasted key without saving it (the key-first connect flow) and
//      watch the probe derive the connection identity from the live response,
//   4. CHECK a SAVED connection and watch its status flip healthy -> expired
//      when the stored key stops working.
//
// The upstream API is a real node:http server started inside the scenario on
// 127.0.0.1 that gates `GET /me` on a bearer token: a generic "bring your own
// OpenAPI" integration, so the generic openapi health-check path is exercised
// rather than any one provider's quirks.
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

const TEMPLATE = AuthTemplateSlug.make("apiKey");
const IDENTITY = "alice@example.com";

const newSlug = (prefix: string) =>
  IntegrationSlug.make(`${prefix}-${randomBytes(4).toString("hex")}`);

/** OpenAPI 3 spec with an auth-gated identity GET (`/me`, the obvious health
 *  check) plus a destructive POST so the candidate ranking has something to sort
 *  the GET ahead of. */
const identitySpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Identity API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/me": {
        get: {
          operationId: "getMe",
          summary: "The current account",
          responses: {
            "200": {
              description: "The authenticated account",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { email: { type: "string" }, login: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
      "/messages": {
        post: {
          operationId: "sendMessage",
          summary: "Send a message",
          responses: { "201": { description: "created" } },
        },
      },
    },
  });

/** OpenAPI 3 spec whose `GET /me` response mirrors Vercel's `getAuthUser`: the
 *  account is a `oneOf` of two object variants, the obvious identity scalars
 *  (`email`, `id`) sit behind a large nested object, and one field (`limited`)
 *  exists only on the second variant. A naive walker that follows only the first
 *  union branch (and descends the nested object until a field cap) drops both
 *  `user.email` and `user.limited`; the projector must merge branches and emit
 *  shallow fields first. No live server needed (candidate projection is static). */
const discriminatedUnionSpec = (baseUrl: string): string => {
  // 60 nested scalars, listed before `email`, so a depth-first walk blows the
  // field cap inside `profile` before it ever reaches the top-level identity.
  const profileProps: Record<string, unknown> = {};
  for (let i = 0; i < 60; i++) profileProps[`field${i}`] = { type: "string" };
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Union Identity API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/me": {
        get: {
          operationId: "getAuthUser",
          summary: "The current account",
          responses: {
            "200": {
              description: "The authenticated account",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      user: {
                        oneOf: [
                          { $ref: "#/components/schemas/AccountFull" },
                          { $ref: "#/components/schemas/AccountLimited" },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        AccountFull: {
          type: "object",
          properties: {
            profile: { type: "object", properties: profileProps },
            email: { type: "string" },
            id: { type: "string" },
          },
        },
        AccountLimited: {
          type: "object",
          properties: {
            email: { type: "string" },
            limited: { type: "boolean" },
          },
        },
      },
    },
  });
};

/** A real node:http identity API on 127.0.0.1. `GET /me` returns the account
 *  JSON only when the bearer token matches `validToken`; any other token is a
 *  401 (the "the dev token got revoked" case the health check classifies as
 *  expired). Closed by the scope's finalizer. */
const serveIdentityApi = (validToken: string) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
      const server = createServer((request, response) => {
        const authorized = request.headers["authorization"] === `Bearer ${validToken}`;
        if (request.method === "GET" && (request.url ?? "").startsWith("/me")) {
          if (!authorized) {
            response.writeHead(401, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "invalid_token" }));
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ email: IDENTITY, login: "alice" }));
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

/** Register the identity integration against `baseUrl` with a bearer-token auth
 *  method (single `token` input → connection `value`). Returns the slug. */
const registerIdentityIntegration = (client: Client, slug: IntegrationSlug, baseUrl: string) =>
  client.openapi.addSpec({
    payload: {
      spec: { kind: "blob", value: identitySpec(baseUrl) },
      slug,
      baseUrl,
      authenticationTemplate: [
        {
          slug: "apiKey",
          type: "apiKey",
          headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
        },
      ],
    },
  });

/** The stored operation name for the GET identity probe (openapi prefixes it by
 *  tag, e.g. `me.getMe`), discovered the same way the editor does: from the
 *  ranked candidate list. */
const getMeOperation = (client: Client, slug: IntegrationSlug) =>
  Effect.gen(function* () {
    const candidates = yield* client.integrations.healthCheckCandidates({ params: { slug } });
    const getMe = candidates.find((candidate) => candidate.method === "get");
    if (!getMe) return yield* Effect.die("identity spec exposed no GET candidate");
    return getMe.operation;
  });

scenario(
  "Health checks · configuring a check, then validating a key derives the connection identity",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const goodToken = `gk_${randomBytes(8).toString("hex")}`;
      const server = yield* serveIdentityApi(goodToken);
      const slug = newSlug("hc-validate");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* registerIdentityIntegration(client, slug, server.url);

          // The editor offers the integration's operations, ranked so the
          // non-destructive GET identity endpoint floats to the top.
          const candidates = yield* client.integrations.healthCheckCandidates({
            params: { slug },
          });
          const get = candidates.find((candidate) => candidate.method === "get");
          const post = candidates.find((candidate) => candidate.method === "post");
          if (!get || !post) {
            return yield* Effect.die("identity spec should expose a GET and a POST candidate");
          }
          // Operations are stored tag-prefixed (e.g. `me.getMe`); match the suffix.
          expect(get.operation.split(".").at(-1), "the identity GET is offered").toBe("getMe");
          expect(post.operation.split(".").at(-1), "the destructive POST is offered").toBe(
            "sendMessage",
          );
          expect(
            candidates[0]?.operation,
            "the non-destructive GET ranks ahead of the destructive POST",
          ).toBe(get.operation);
          expect(get.destructive, "the GET identity probe is non-destructive").toBe(false);
          expect(post.destructive, "the POST is flagged destructive").toBe(true);
          const operation = get.operation;

          // Pick it: the operation plus the dot-path to the identity field.
          yield* client.integrations.healthCheckSet({
            params: { slug },
            payload: { spec: { operation, identityField: "email" } },
          });
          const stored = yield* client.integrations.healthCheckGet({ params: { slug } });
          expect(stored, "the chosen health check round-trips").toEqual({
            operation,
            identityField: "email",
          });

          // Key-first connect: a pasted key is probed WITHOUT saving, and the
          // probe surfaces the identity the UI fills the connection name from.
          const healthy = yield* client.connections.validate({
            payload: { owner: "org", integration: slug, template: TEMPLATE, value: goodToken },
          });
          expect(healthy.status, "a live key validates as healthy").toBe("healthy");
          expect(healthy.httpStatus, "the probe saw the 200").toBe(200);
          expect(healthy.identity, "the identity is derived from the response body").toBe(IDENTITY);

          // A revoked / wrong key validates as expired, with no identity.
          const expired = yield* client.connections.validate({
            payload: { owner: "org", integration: slug, template: TEMPLATE, value: "wrong-key" },
          });
          expect(expired.status, "a rejected key validates as expired").toBe("expired");
          expect(expired.httpStatus, "the probe saw the 401").toBe(401);
          expect(expired.identity, "no identity is surfaced for a rejected key").toBeUndefined();
        }),
        client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore),
      );
    }),
  ),
);

scenario(
  "Health checks · a saved connection reports healthy, then expired when its key stops working",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const goodToken = `gk_${randomBytes(8).toString("hex")}`;
      const server = yield* serveIdentityApi(goodToken);
      const slug = newSlug("hc-saved");
      const name = ConnectionName.make("main");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* registerIdentityIntegration(client, slug, server.url);
          const operation = yield* getMeOperation(client, slug);
          yield* client.integrations.healthCheckSet({
            params: { slug },
            payload: { spec: { operation, identityField: "email" } },
          });

          // A connection holding the live key checks out healthy, identity and all.
          yield* client.connections.create({
            payload: {
              owner: "org",
              name,
              integration: slug,
              template: TEMPLATE,
              value: goodToken,
            },
          });
          const healthy = yield* client.connections.checkHealth({
            params: { owner: "org", integration: slug, name },
          });
          expect(healthy.status, "the saved connection's live key is healthy").toBe("healthy");
          expect(healthy.httpStatus, "the saved probe saw the 200").toBe(200);
          expect(healthy.identity, "the saved probe derives the account identity").toBe(IDENTITY);

          // Re-creating the same (owner, integration, name) replaces the stored
          // key in place: now the connection holds a key the server rejects.
          yield* client.connections.create({
            payload: {
              owner: "org",
              name,
              integration: slug,
              template: TEMPLATE,
              value: "rotated-away",
            },
          });
          const expired = yield* client.connections.checkHealth({
            params: { owner: "org", integration: slug, name },
          });
          expect(expired.status, "the same connection now reads as expired").toBe("expired");
          expect(expired.httpStatus, "the saved probe saw the 401").toBe(401);
          expect(expired.identity, "an expired connection surfaces no identity").toBeUndefined();

          // The verdict PERSISTS: the plain connections list carries the last
          // health-check result, so the UI shows expired at a glance with no
          // per-row probing - the reason this feature exists.
          const listed = yield* client.connections.list({ query: {} });
          const row = listed.find(
            (c) => String(c.integration) === String(slug) && String(c.name) === String(name),
          );
          expect(row?.lastHealth?.status, "the expired verdict is visible in the list").toBe(
            "expired",
          );
          expect(row?.lastHealth?.httpStatus, "with the observed status").toBe(401);
        }),
        Effect.gen(function* () {
          yield* client.connections
            .remove({ params: { owner: "org", integration: slug, name } })
            .pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);

scenario(
  "Health checks · the identity picker surfaces shallow fields across a discriminated union",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const slug = newSlug("hc-union");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            payload: {
              spec: { kind: "blob", value: discriminatedUnionSpec("https://union.example.com") },
              slug,
              baseUrl: "https://union.example.com",
              authenticationTemplate: [
                {
                  slug: "apiKey",
                  type: "apiKey",
                  headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
                },
              ],
            },
          });

          // The identity picker is fed by the GET candidate's projected response
          // fields. They must include the shallow identity scalar even though it
          // sits behind a 60-field nested object...
          const candidates = yield* client.integrations.healthCheckCandidates({ params: { slug } });
          const get = candidates.find((candidate) => candidate.method === "get");
          if (!get) return yield* Effect.die("union spec exposed no GET candidate");
          const paths = (get.responseFields ?? []).map((field) => field.path);
          expect(paths, "the shallow identity scalar is offered, not starved by nesting").toContain(
            "user.email",
          );
          // ...and the field that exists ONLY on the second union variant, proving
          // every branch contributes (not just the first).
          expect(paths, "a field unique to the second union branch is offered").toContain(
            "user.limited",
          );
        }),
        client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore),
      );
    }),
  ),
);

scenario(
  "Health checks · a connection with no configured check reports unknown, not a failure",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const goodToken = `gk_${randomBytes(8).toString("hex")}`;
      const server = yield* serveIdentityApi(goodToken);
      const slug = newSlug("hc-unknown");
      const name = ConnectionName.make("main");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          // No healthCheckSet: the integration declares no probe.
          yield* registerIdentityIntegration(client, slug, server.url);
          expect(
            yield* client.integrations.healthCheckGet({ params: { slug } }),
            "an integration with no configured check reports none",
          ).toBeNull();

          yield* client.connections.create({
            payload: {
              owner: "org",
              name,
              integration: slug,
              template: TEMPLATE,
              value: goodToken,
            },
          });
          const result = yield* client.connections.checkHealth({
            params: { owner: "org", integration: slug, name },
          });
          expect(result.status, "with no check configured the status is unknown").toBe("unknown");
          expect(result.detail ?? "", "the result explains why it is unknown").toContain(
            "No health check configured",
          );
        }),
        Effect.gen(function* () {
          yield* client.connections
            .remove({ params: { owner: "org", integration: slug, name } })
            .pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
