// Cross-target: a scope-insufficient upstream 403 is a distinct, actionable
// failure — not a re-authenticate loop. When a connection's OAuth grant does
// not cover the scope an operation requires, the upstream rejects the call
// with a scope signal (Google's ACCESS_TOKEN_SCOPE_INSUFFICIENT, RFC 6750's
// insufficient_scope). Re-running the same grant returns the identical 403,
// so the tool failure must say so: code `oauth_scope_insufficient`, guidance
// to reconnect with broader access, and NO `oauth.start` recovery hint (an
// agent following one would loop through identical consent forever).
//
// The journey: an OpenAPI integration with two operations under one OAuth
// method; the connection completes a real authorization-code flow granting
// only `mail.read`. Calling the `files.read` operation dispatches upstream
// (catalog projection by scope is #1384, tracked separately), which answers
// with a Google-shaped scope-insufficient 403 — and the failure the sandbox
// sees carries the new code, while the ordinary revoked-token 403 stays
// `connection_rejected`.
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

/** Upstream on 127.0.0.1: `GET /inbox` is 200 for any bearer; `GET /files`
 *  answers a Google-shaped scope-insufficient 403; `GET /admin` answers an
 *  ordinary 403 with no scope signal. */
const serveScopedUpstream = () =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
      const server = createServer((request, response) => {
        const path = request.url ?? "";
        if (request.method === "GET" && path.startsWith("/inbox")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ messages: [] }));
          return;
        }
        if (request.method === "GET" && path.startsWith("/files")) {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                code: 403,
                message: "Request had insufficient authentication scopes.",
                status: "PERMISSION_DENIED",
                details: [
                  {
                    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                    reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
                    domain: "googleapis.com",
                    metadata: { service: "drive.googleapis.com" },
                  },
                ],
              },
            }),
          );
          return;
        }
        if (request.method === "GET" && path.startsWith("/admin")) {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "not allowed" } }),
          );
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
    info: { title: "Scoped API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/inbox": {
        get: {
          operationId: "readInbox",
          summary: "List inbox messages",
          security: [{ oauth: ["mail.read"] }],
          responses: { "200": { description: "messages" } },
        },
      },
      "/files": {
        get: {
          operationId: "listFiles",
          summary: "List drive files",
          security: [{ oauth: ["files.read"] }],
          responses: { "200": { description: "files" } },
        },
      },
      "/admin": {
        get: {
          operationId: "adminAction",
          summary: "An admin-only action",
          security: [{ oauth: ["mail.read"] }],
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
              scopes: {
                "mail.read": "Read mail",
                "files.read": "Read files",
              },
            },
          },
        },
      },
    },
  });

const invokeByAddressCode = (address: string, args: unknown) => `
const segments = ${JSON.stringify(address)}.split(".").slice(1);
let node = tools;
for (const segment of segments) node = node[segment];
const result = await node(${JSON.stringify(args)});
return JSON.stringify(result);
`;

type ToolEnvelope = {
  readonly ok: boolean;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: { readonly recovery?: Record<string, string> };
  };
};

scenario(
  "Auth failures · a scope-insufficient 403 tells the agent to reconnect with broader access, not to re-authenticate",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const upstream = yield* serveScopedUpstream();
      const oauth = yield* serveOAuthTestServer({ scopes: ["mail.read", "files.read"] });
      const slug = unique("scopeins");
      const clientSlug = OAuthClientSlug.make(unique("scopeinsc"));

      yield* Effect.ensuring(
        Effect.gen(function* () {
          // The integration's OAuth method requests only mail.read — the
          // whole grant the connection will hold.
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
                  scopes: ["mail.read"],
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
              originIntegration: IntegrationSlug.make(slug),
            },
          });

          const started = yield* client.oauth.start({
            payload: {
              client: clientSlug,
              clientOwner: "org",
              owner: "org",
              name: ConnectionName.make("main"),
              integration: IntegrationSlug.make(slug),
              template: AuthTemplateSlug.make("oauth"),
            },
          });
          expect(started.status, "oauth.start redirects to the authorization server").toBe(
            "redirect",
          );
          if (started.status !== "redirect") return yield* Effect.die("no redirect");

          // Drive the test IdP's consent by hand (authorize → login → code).
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
          yield* client.oauth.complete({ payload: { state: started.state, code } });

          const tools = yield* client.tools.list({ query: {} });
          const addresses = tools
            .filter((tool) => String(tool.integration) === slug)
            .map((tool) => String(tool.address));
          const addressOf = (suffix: string) => {
            const found = addresses.find((addr) => addr.endsWith(suffix));
            expect(found, `the ${suffix} tool is in the catalog`).toBeDefined();
            return found!;
          };

          const invoke = (address: string) =>
            Effect.gen(function* () {
              const executed = yield* client.executions.execute({
                payload: { code: invokeByAddressCode(address, {}), autoApprove: true },
              });
              expect(executed.status, "the sandbox execution completed").toBe("completed");
              return JSON.parse(executed.text) as ToolEnvelope;
            });

          // THE guarantee: the scope-insufficient 403 carries its own code
          // and reconnect guidance — and no oauth.start hint, because
          // re-running the identical grant cannot satisfy the scope.
          const scopeFailure = yield* invoke(addressOf("listFiles"));
          expect(scopeFailure.ok, "the out-of-scope call failed").toBe(false);
          expect(
            scopeFailure.error?.code,
            "the failure names the scope shortfall, not a rejected credential",
          ).toBe("oauth_scope_insufficient");
          expect(
            scopeFailure.error?.message ?? "",
            "the message says re-authenticating will not help",
          ).toContain("Re-authenticating with the same grant");
          // Google's 403 body names no scope; the operation's own declared
          // scope (carried through extraction into the stored binding) and
          // the connection's granted scope (from its oauth_scope) fill in
          // exactly what is missing versus what is held.
          expect(
            scopeFailure.error?.message ?? "",
            "the message names the scope the operation requires, from the binding",
          ).toContain("files.read");
          expect(
            scopeFailure.error?.message ?? "",
            "the message names the scope the grant holds, from the connection",
          ).toContain("mail.read");
          expect(
            scopeFailure.error?.details?.recovery?.startOAuthTool,
            "no oauth.start recovery hint",
          ).toBeUndefined();
          expect(
            scopeFailure.error?.details?.recovery?.scopeInstructions ?? "",
            "the recovery tells the agent to reconnect with broader access",
          ).toContain("broader access");

          // An ordinary 403 with no scope signal keeps the existing
          // classification — the new code is additive, not a re-label.
          const plainForbidden = yield* invoke(addressOf("adminAction"));
          expect(plainForbidden.ok, "the plain-403 call failed").toBe(false);
          expect(
            plainForbidden.error?.code,
            "a 403 without a scope signal stays connection_rejected",
          ).toBe("connection_rejected");

          // And the in-scope operation works, proving the connection is fine.
          const inScope = yield* invoke(addressOf("readInbox"));
          expect(inScope.ok, "the in-scope call succeeds with the same token").toBe(true);
        }),
        Effect.gen(function* () {
          yield* client.connections
            .remove({
              params: {
                owner: "org",
                integration: IntegrationSlug.make(slug),
                name: ConnectionName.make("main"),
              },
            })
            .pipe(Effect.ignore);
          yield* client.oauth
            .removeClient({ params: { slug: clientSlug }, payload: { owner: "org" } })
            .pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
