// Cross-target: connecting a SECOND account to the same integration must ADD a
// distinct connection, never silently overwrite the first. This is the exact
// data-loss bug that shipped — a human label like "Work Gmail" reaches
// `oauth.start` as the client-derived "workGmail", the mint stored the
// `connectionIdentifier` form, and the free-name guard compared the
// un-re-normalized name case-sensitively, missed the existing row, and the
// second connect re-minted (overwrote) the first account instead of resolving
// to a suffixed name.
//
// The journey: one OpenAPI integration with a single OAuth method; run the
// real authorization-code flow TWICE with `newConnection: true`, using a raw
// human label the client would type (not an already-normalized name). The
// first connect mints `workGmail`; the second must resolve to `workGmail2`,
// and the typed connections API must show BOTH rows persisting.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

/** A trivial upstream on 127.0.0.1: `GET /me` is 200 for any bearer. It exists
 *  only to give the OpenAPI integration a `servers` base URL — the guarantee
 *  under test is about connection identity, not the dispatched call. */
const serveUpstream = () =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
      const server = createServer((request, response) => {
        if (request.method === "GET" && (request.url ?? "").startsWith("/me")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
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

const spec = (
  baseUrl: string,
  oauth: { readonly authorizationEndpoint: string; readonly tokenEndpoint: string },
): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Mail API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/me": {
        get: {
          operationId: "readMe",
          summary: "Read the authenticated profile",
          security: [{ oauth: ["email"] }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
    components: {
      securitySchemes: {
        oauth: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: oauth.authorizationEndpoint,
              tokenUrl: oauth.tokenEndpoint,
              scopes: { email: "Read email" },
            },
          },
        },
      },
    },
  });

scenario(
  "Connections · a second OAuth connect adds a distinct account instead of overwriting the first",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const upstream = yield* serveUpstream();
      const oauth = yield* serveOAuthTestServer({ scopes: ["email"] });
      const slug = IntegrationSlug.make(unique("oauth2nd"));
      const clientSlug = OAuthClientSlug.make(unique("oauth2ndc"));

      // Run the whole authorization-code flow end to end for a requested name.
      // The mint normalizes the name; the free-name guard must compare against
      // that same normalized form, so a repeat call resolves to a suffix.
      const connect = (requestedName: string) =>
        Effect.gen(function* () {
          const started = yield* client.oauth.start({
            payload: {
              client: clientSlug,
              clientOwner: "org",
              owner: "org",
              name: ConnectionName.make(requestedName),
              integration: slug,
              template: AuthTemplateSlug.make("oauth"),
              newConnection: true,
            },
          });
          expect(started.status, "oauth.start redirects to the authorization server").toBe(
            "redirect",
          );
          if (started.status !== "redirect") return yield* Effect.die("no redirect");

          // Drive the test IdP's consent by hand (authorize -> login -> code).
          // Plain fetch with manual redirects is the e2e-proven path: the
          // Effect HttpClient's manual-redirect layer is overridden by the
          // scenario runtime and silently follows the hop to the login page.
          const code = yield* Effect.promise(async () => {
            const authorize = await fetch(started.authorizationUrl, { redirect: "manual" });
            const loginUrl = authorize.headers.get("location");
            if (!loginUrl) throw new Error(`authorize did not redirect: ${authorize.status}`);
            const login = await fetch(loginUrl, {
              method: "POST",
              headers: {
                authorization: `Basic ${Buffer.from("alice:password").toString("base64")}`,
              },
              redirect: "manual",
            });
            const callbackUrl = login.headers.get("location");
            if (!callbackUrl) throw new Error(`login did not redirect: ${login.status}`);
            const minted = new URL(callbackUrl).searchParams.get("code");
            if (!minted) throw new Error("callback carried no authorization code");
            return minted;
          });
          // `complete` returns the minted connection projection directly.
          const connection = yield* client.oauth.complete({
            payload: { state: started.state, code },
          });
          return String(connection.name);
        });

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            payload: {
              spec: { kind: "blob", value: spec(upstream.url, oauth) },
              slug,
              baseUrl: upstream.url,
              authenticationTemplate: [
                {
                  slug: "oauth",
                  kind: "oauth2",
                  authorizationUrl: oauth.authorizationEndpoint,
                  tokenUrl: oauth.tokenEndpoint,
                  scopes: ["email"],
                },
              ],
            },
          });
          yield* client.oauth.createClient({
            payload: {
              owner: "org",
              slug: clientSlug,
              grant: "authorization_code",
              authorizationUrl: oauth.authorizationEndpoint,
              tokenUrl: oauth.tokenEndpoint,
              clientId: "test-client",
              clientSecret: "test-secret",
              originIntegration: slug,
            },
          });

          // A raw human label the client would type — NOT an already-normalized
          // name. Before the fix, the second connect overwrote the first row.
          const first = yield* connect("Work Gmail");
          const second = yield* connect("Work Gmail");
          expect(first, "the first account is stored under the normalized name").toBe("workGmail");
          expect(second, "the second account resolves to a distinct suffixed name").toBe(
            "workGmail2",
          );

          // The typed API is the black-box proof: both rows persist. Selfhost
          // shares one workspace, so assert "contains mine", not exact length.
          const connections = yield* client.connections.list({ query: { integration: slug } });
          const names = connections.map((connection) => String(connection.name));
          expect(names, "both OAuth accounts persist as distinct connections").toEqual(
            expect.arrayContaining(["workGmail", "workGmail2"]),
          );
        }),
        // Best-effort cleanup even on failure: drop both connections, then the
        // integration — a mid-test failure must not leak state into selfhost.
        Effect.gen(function* () {
          for (const name of ["workGmail", "workGmail2"]) {
            yield* client.connections
              .remove({
                params: {
                  owner: "org",
                  integration: slug,
                  name: ConnectionName.make(name),
                },
              })
              .pipe(Effect.ignore);
          }
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
