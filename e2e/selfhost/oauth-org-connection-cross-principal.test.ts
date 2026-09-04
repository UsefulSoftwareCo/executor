// Selfhost-only: an ORG-owned OAuth connection must work for every member of
// the org, not just whoever's browser session completed the consent.
//
// Issue #1453: the encrypted-secrets provider (the writable provider on
// self-host and the Cloudflare host) filed token rows under the ACTING
// caller's partition — so completing an org connection's consent in a user
// session landed the tokens at owner='user', subject=<that user>, while the
// connection row itself said org. The consenting user's own calls still read
// the tokens (user rows shadow org rows), so the connection looked healthy —
// but every other principal resolved no value and failed with
// `oauth_connection_missing`. The same mis-filing was fixed for the WorkOS
// Vault provider in #950.
//
// The journey: the bootstrap admin registers an OAuth-protected integration,
// completes the org-owned authorization-code flow (a real test AS on
// 127.0.0.1), and proves the tool call carries the minted token upstream. A
// second, invited member of the same org then invokes the same tool — the
// guarantee under test is that the same org connection resolves the same
// token for them too.
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
import { createInvitedIdentity } from "../targets/selfhost";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}${randomBytes(4).toString("hex")}`;

/** Upstream on 127.0.0.1: `GET /me` echoes the authorization header it
 *  received, so the scenario can assert a real token reached it — not merely
 *  that a request was made. */
const serveUpstream = () =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
      const server = createServer((request, response) => {
        if (request.method === "GET" && (request.url ?? "").startsWith("/me")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ authorization: request.headers.authorization ?? null }));
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

const specFor = (
  baseUrl: string,
  oauth: { readonly authorizationEndpoint: string; readonly tokenEndpoint: string },
): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Me API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/me": {
        get: {
          operationId: "getMe",
          summary: "The caller",
          security: [{ oauth: ["read"] }],
          responses: { "200": { description: "the caller" } },
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
              scopes: { read: "Read" },
            },
          },
        },
      },
    },
  });

/** Complete the test AS's consent headlessly and return the authorization
 *  code from the callback redirect. */
const consentCode = (authorizationUrl: string) =>
  Effect.promise(async () => {
    const authorize = await fetch(authorizationUrl, { redirect: "manual" });
    const loginUrl = authorize.headers.get("location");
    if (!loginUrl) throw new Error(`authorize did not redirect: ${authorize.status}`);
    const login = await fetch(loginUrl, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from("alice:password").toString("base64")}` },
      redirect: "manual",
    });
    const callbackUrl = login.headers.get("location");
    if (!callbackUrl) throw new Error(`login did not redirect: ${login.status}`);
    const code = new URL(callbackUrl).searchParams.get("code");
    if (!code) throw new Error("callback carried no authorization code");
    return code;
  });

type ToolEnvelope = {
  readonly ok: boolean;
  readonly data?: { readonly authorization?: string | null };
  readonly error?: { readonly code?: string; readonly message?: string };
};

/** Navigate the sandbox's `tools` object to the address and invoke it. */
const invokeByAddressCode = (address: string) => `
const segments = ${JSON.stringify(address)}.split(".").slice(1);
let node = tools;
for (const segment of segments) node = node[segment];
const result = await node({});
return result;
`;

scenario(
  "OAuth · an org-owned connection consented in one member's session resolves for another member",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const admin = yield* target.newIdentity();
      const adminClient = yield* makeClient(api, admin);
      const upstream = yield* serveUpstream();
      const oauth = yield* serveOAuthTestServer({ scopes: ["read"] });

      const integration = IntegrationSlug.make(unique("orgoauth"));
      const clientSlug = OAuthClientSlug.make(unique("orgoauthc"));
      const connectionName = ConnectionName.make("main");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* adminClient.openapi.addSpec({
            payload: {
              spec: { kind: "blob", value: specFor(upstream.url, oauth) },
              slug: integration,
              baseUrl: upstream.url,
              authenticationTemplate: [
                {
                  slug: "oauth",
                  kind: "oauth2",
                  authorizationUrl: oauth.authorizationEndpoint,
                  tokenUrl: oauth.tokenEndpoint,
                  scopes: ["read"],
                },
              ],
            },
          });
          yield* adminClient.oauth.createClient({
            payload: {
              owner: "org",
              slug: clientSlug,
              grant: "authorization_code",
              authorizationUrl: oauth.authorizationEndpoint,
              tokenUrl: oauth.tokenEndpoint,
              clientId: "test-client",
              clientSecret: "test-secret",
            },
          });

          // The admin's browser session completes the ORG-owned consent.
          const started = yield* adminClient.oauth.start({
            payload: {
              client: clientSlug,
              clientOwner: "org",
              owner: "org",
              name: connectionName,
              integration,
              template: AuthTemplateSlug.make("oauth"),
            },
          });
          expect(started.status, "oauth.start redirects to the authorization server").toBe(
            "redirect",
          );
          if (started.status !== "redirect") return yield* Effect.die("no redirect");
          const code = yield* consentCode(started.authorizationUrl);
          const connection = yield* adminClient.oauth.complete({
            payload: { state: started.state, code },
          });
          expect(connection, "the minted connection is org-owned").toMatchObject({
            owner: "org",
            name: connectionName,
            integration,
          });

          const tools = yield* adminClient.tools.list({ query: {} });
          const address = tools
            .filter((tool) => String(tool.integration) === String(integration))
            .map((tool) => String(tool.address))
            .find((addr) => addr.endsWith("getMe"));
          expect(address, "the integration's tool is in the catalog").toBeDefined();

          const invoke = (client: typeof adminClient, who: string) =>
            Effect.gen(function* () {
              const execution = yield* client.executions.execute({
                payload: {
                  idempotencyKey: crypto.randomUUID(),
                  code: invokeByAddressCode(address!),
                },
              });
              expect(execution.status, `${who}: the execution completes`).toBe("completed");
              if (execution.status !== "completed") return yield* Effect.die("not completed");
              return (execution.structured as { result?: ToolEnvelope }).result;
            });

          // Sanity: the consenting member's call carries a real bearer to the
          // upstream — this passing is exactly why the bug is invisible to
          // whoever set the connection up.
          const adminResult = yield* invoke(adminClient, "consenting member");
          expect(
            adminResult?.ok,
            `the consenting member's tool call resolves the org connection (got: ${JSON.stringify(adminResult)})`,
          ).toBe(true);
          const adminToken = adminResult?.data?.authorization;
          expect(adminToken, "the upstream received the minted bearer").toMatch(/^Bearer .+/);

          // THE guarantee: a different member of the same org resolves the
          // same org-owned connection to the same token. Before the fix the
          // token rows sat in the consenting user's partition, so this member
          // resolved nothing and failed with `oauth_connection_missing`.
          const member = yield* Effect.promise(() =>
            createInvitedIdentity(target.baseUrl, admin, { emailPrefix: "org-oauth-member" }),
          );
          const memberClient = yield* makeClient(api, member);
          const memberResult = yield* invoke(memberClient, "other member");
          expect(
            memberResult?.ok,
            "another org member's tool call resolves the same org connection " +
              `(got: ${JSON.stringify(memberResult)})`,
          ).toBe(true);
          expect(
            memberResult?.data?.authorization,
            "both members resolve the same org-shared token",
          ).toBe(adminToken);
        }),
        Effect.gen(function* () {
          yield* adminClient.connections
            .remove({ params: { owner: "org", integration, name: connectionName } })
            .pipe(Effect.ignore);
          yield* adminClient.oauth
            .removeClient({ params: { slug: clientSlug }, payload: { owner: "org" } })
            .pipe(Effect.ignore);
          yield* adminClient.openapi
            .removeSpec({ params: { slug: integration } })
            .pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
