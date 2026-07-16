// Cross-target: when the authorization server definitively rejects a
// refresh-token grant, the sandbox must see an auth failure it can act on —
// never the scrubbed "Internal tool error [hex]" defect.
//
// Prod regression (2026-07-16): an AS answered refresh grants with a 400
// whose RFC 6749 error code was NOT `invalid_grant`. Executor classified
// that as a storage failure, and the opaque-defect boundary scrubbed it to
// "Internal tool error [id]" — so agents (and the humans driving them) had
// no signal that the connection simply needed to be re-authenticated.
//
// The journey: an OpenAPI integration completes a real authorization-code
// flow against a live test AS that mints instantly-expiring access tokens
// and rejects every refresh grant with `invalid_request`. The first tool
// call must therefore refresh, the AS says a definitive no, and the failure
// the sandbox sees carries code `oauth_refresh_failed`, the AS's own error
// code and description, and connection-recovery guidance.
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

/** Upstream on 127.0.0.1: `GET /issues` is 200 for any bearer. The refresh is
 *  rejected before any upstream call, so this only proves the failure came
 *  from the token endpoint, not from here. */
const serveUpstream = () =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
      const server = createServer((request, response) => {
        if (request.method === "GET" && (request.url ?? "").startsWith("/issues")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ issues: [] }));
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
    info: { title: "Issues API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/issues": {
        get: {
          operationId: "listIssues",
          summary: "List issues",
          security: [{ oauth: ["issues.read"] }],
          responses: { "200": { description: "issues" } },
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
              scopes: { "issues.read": "Read issues" },
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
    readonly details?: {
      readonly category?: string;
      readonly recovery?: Record<string, string>;
    };
  };
};

scenario(
  "Auth failures · a refresh rejected by the authorization server surfaces as an actionable auth failure, not an internal error",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const upstream = yield* serveUpstream();
      // Instantly-expiring access tokens force the first tool call to
      // refresh; the AS rejects every refresh grant with a non-invalid_grant
      // 400, mirroring the prod AS that triggered the regression.
      const oauth = yield* serveOAuthTestServer({
        scopes: ["issues.read"],
        tokenExpiresInSeconds: 0,
        supportRefresh: false,
        invalidRefreshTokenErrorCode: "invalid_request",
        invalidRefreshTokenDescription: "Refresh token expired",
      });
      const slug = unique("refreshrej");
      const clientSlug = OAuthClientSlug.make(unique("refreshrejc"));

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
                  scopes: ["issues.read"],
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
          const address = tools
            .filter((tool) => String(tool.integration) === slug)
            .map((tool) => String(tool.address))
            .find((addr) => addr.endsWith("listIssues"));
          expect(address, "the listIssues tool is in the catalog").toBeDefined();

          const executed = yield* client.executions.execute({
            payload: { code: invokeByAddressCode(address!, {}), autoApprove: true },
          });
          expect(executed.status, "the sandbox execution completed").toBe("completed");
          const failure = JSON.parse(executed.text) as ToolEnvelope;

          // THE guarantee: the AS's definitive rejection reaches the agent
          // as an auth failure with the AS's own verdict in the message.
          expect(failure.ok, "the tool call failed").toBe(false);
          expect(
            failure.error?.code,
            "the failure is classified as a rejected refresh, not an internal defect",
          ).toBe("oauth_refresh_failed");
          expect(
            failure.error?.message ?? "",
            "the message carries the AS's RFC 6749 error code",
          ).toContain("invalid_request");
          expect(
            failure.error?.message ?? "",
            "the message carries the AS's error description",
          ).toContain("Refresh token expired");
          expect(
            failure.error?.message ?? "",
            "the opaque defect message never reaches the sandbox",
          ).not.toContain("Internal tool error");
          expect(failure.error?.details?.category, "the failure is auth-flavored").toBe(
            "authentication",
          );
          expect(
            failure.error?.details?.recovery?.oauthInstructions ?? "",
            "the recovery tells the agent how to re-connect via OAuth",
          ).toContain("startOAuthTool");
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
