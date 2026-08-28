// Cross-target: an authorization server's refusal does not have to be a
// conform RFC 6749 §5.2 envelope to be FINAL — and a server that merely
// stumbled must not be mistaken for one that refused.
//
// Production regression: real token endpoints refuse a dead refresh grant in
// shapes the spec never describes — a `text/plain` 400 ("your session has
// expired"), a `text/plain` 404, a 200 whose body carries the error, or a 200
// with no usable token. The RFC parser will not even read those bodies, so no
// OAuth error code was recovered, every one of them was classified as a
// retryable blip, and the dead grant went back to the authorization server on
// every single use — hundreds of identical rejections on one grant, each an
// internal error to the agent, while the connection still rendered as fine.
//
// The journey, once per refusal shape: an OpenAPI integration completes a real
// authorization-code flow against a live test AS that mints instantly-expiring
// access tokens and refuses every refresh grant with the shape under test. The
// first tool call refreshes and the AS says no. For a definitive refusal the
// connection must then ask to be reconnected and the AS must never hear that
// grant again; for a 5xx the opposite must hold — the next use tries again.
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
import { Api, Mcp, Target } from "../src/services";

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

/** Exactly what the token endpoint answers a refresh grant with, byte for
 *  byte — the whole point is that it is not a shape the RFC describes. */
type RefreshRejection = {
  readonly status: number;
  readonly contentType?: string;
  readonly body: string;
};

/** Exactly what the agent gets back from `execute`: either the tool's own JSON
 *  result envelope (`ok: true` at the MCP layer) or an MCP-level error, which
 *  is what a failure executor did not classify degrades into. Which of the two
 *  a refusal produces is itself part of what these scenarios pin down. */
type McpCall = { readonly ok: boolean; readonly text: string };

/** What the test can observe from outside once the AS has refused: the agent's
 *  view of a tool call, the AS's own ledger of how many times the dead grant
 *  actually left the building, and what the connection says about itself. */
type Observations = {
  readonly callTool: () => Effect.Effect<McpCall, unknown, never>;
  readonly refreshGrantsSent: Effect.Effect<number, unknown, never>;
  readonly connectionHealth: Effect.Effect<
    { readonly status?: string; readonly detail?: string },
    unknown,
    never
  >;
};

/** Stand up an integration whose connection is authorized for real and whose
 *  every refresh is refused with `rejection`, then hand the assertions the
 *  outside-in observations above. */
const withRefusedRefresh = (
  slugPrefix: string,
  rejection: RefreshRejection,
  assertions: (observations: Observations) => Effect.Effect<void, unknown, never>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const upstream = yield* serveUpstream();
      // Instantly-expiring access tokens force the first tool call to refresh.
      const oauth = yield* serveOAuthTestServer({
        scopes: ["issues.read"],
        tokenExpiresInSeconds: 0,
        supportRefresh: false,
        refreshRejection: rejection,
      });
      const slug = unique(slugPrefix);
      const clientSlug = OAuthClientSlug.make(unique(`${slugPrefix}c`));
      const connectionName = ConnectionName.make("main");

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
              name: connectionName,
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

          // Call through the real MCP surface, the channel an agent uses.
          const session = mcp.session(identity);
          const callTool = () =>
            Effect.gen(function* () {
              let called = yield* session.call("execute", {
                code: invokeByAddressCode(address!, {}),
              });
              // Approval-gated tools pause the execution once per gated call.
              let guard = 0;
              while (called.text.includes("executionId:") && guard < 10) {
                called = yield* session.approvePaused(called.text);
                guard += 1;
              }
              return { ok: called.ok, text: called.text };
            });

          yield* assertions({
            callTool,
            refreshGrantsSent: Effect.map(
              oauth.requests,
              (all) =>
                all.filter(
                  (request) =>
                    request.path === "/token" && request.body.includes("grant_type=refresh_token"),
                ).length,
            ),
            connectionHealth: Effect.map(
              client.connections.get({
                params: {
                  owner: "org",
                  integration: IntegrationSlug.make(slug),
                  name: connectionName,
                },
              }),
              (connection) => ({
                status: connection.lastHealth?.status,
                detail: connection.lastHealth?.detail ?? undefined,
              }),
            ),
          });
        }),
        Effect.gen(function* () {
          yield* client.connections
            .remove({
              params: {
                owner: "org",
                integration: IntegrationSlug.make(slug),
                name: connectionName,
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
  );

/** Every definitive refusal, whatever it looks like on the wire, has to end the
 *  same way: one grant sent, an actionable auth failure, and silence towards
 *  the AS from then on. */
const deadGrantScenario = (input: {
  readonly shape: string;
  readonly slugPrefix: string;
  readonly rejection: RefreshRejection;
  /** A fragment of the endpoint's own answer that must survive to the agent. */
  readonly reason: string;
}) =>
  scenario(
    `Auth failures · a refresh refused with ${input.shape} is a dead grant: the connection asks to be reconnected and the grant is never re-sent`,
    {},
    withRefusedRefresh(
      input.slugPrefix,
      input.rejection,
      ({ callTool, refreshGrantsSent, connectionHealth }) =>
        Effect.gen(function* () {
          /** A classified failure comes back as the tool's own result envelope;
           *  an unclassified one degrades into an MCP-level error instead. */
          const envelopeOf = (call: McpCall, label: string): ToolEnvelope => {
            expect(
              call.ok,
              `${label}: the failure came back as a tool result the agent can read, not an MCP error (got: ${call.text.slice(0, 400)})`,
            ).toBe(true);
            return JSON.parse(call.text) as ToolEnvelope;
          };

          const first = envelopeOf(yield* callTool(), "first call");
          expect(first.ok, "the tool call failed").toBe(false);
          expect(
            first.error?.code,
            "the refusal is read as a dead grant, not an internal defect",
          ).toBe("oauth_reauth_required");
          expect(first.error?.details?.category, "the failure is auth-flavored").toBe(
            "authentication",
          );
          expect(
            first.error?.message ?? "",
            "the token endpoint's own words survive to the agent",
          ).toContain(input.reason);
          expect(
            first.error?.message ?? "",
            "the opaque defect message never reaches the sandbox",
          ).not.toContain("Internal tool error");
          expect(
            first.error?.details?.recovery?.oauthInstructions ?? "",
            "the recovery tells the agent how to re-connect via OAuth",
          ).toContain("startOAuthTool");
          expect(yield* refreshGrantsSent, "the grant was tried exactly once").toBe(1);

          // THE guarantee: further use of the connection keeps reporting the same
          // actionable failure and the AS never hears the dead grant again. This
          // is the assertion that pins the retry storm.
          const second = envelopeOf(yield* callTool(), "second call");
          const third = envelopeOf(yield* callTool(), "third call");
          for (const [index, envelope] of [second, third].entries()) {
            expect(envelope.ok, `follow-up call ${index + 1} still failed`).toBe(false);
            expect(
              envelope.error?.code,
              `follow-up call ${index + 1} still asks for a reconnect`,
            ).toBe("oauth_reauth_required");
          }
          expect(
            yield* refreshGrantsSent,
            "the dead grant is never re-sent, however often the connection is used",
          ).toBe(1);

          // And the connection says so on its own, with no probe: the verdict was
          // recorded the moment the AS delivered it.
          const health = yield* connectionHealth;
          expect(health.status, "the connection reads as expired at a glance").toBe("expired");
          expect(
            health.detail ?? "",
            "with the upstream's reason, so the user knows why",
          ).toContain(input.reason);
        }),
    ),
  );

// The shape the prod outage arrived in: a plain-language 400 the RFC parser
// refuses to read at all.
deadGrantScenario({
  shape: "a text/plain 400",
  slugPrefix: "refreshtxt",
  rejection: {
    status: 400,
    contentType: "text/plain; charset=utf-8",
    body: "Your session has expired. Please reconnect the integration.",
  },
  reason: "Your session has expired",
});

// A token endpoint answering 404 does not start existing on the next attempt.
deadGrantScenario({
  shape: "a text/plain 404",
  slugPrefix: "refresh404",
  rejection: {
    status: 404,
    contentType: "text/plain; charset=utf-8",
    body: "Not found",
  },
  reason: "Not found",
});

// GitHub is the canonical emitter of this shape: HTTP 200 with the refusal in
// the body. A verdict delivered inside a response the endpoint called a SUCCESS
// is about this grant, so it is final whatever the code spells.
deadGrantScenario({
  shape: "HTTP 200 and an error body",
  slugPrefix: "refresh200e",
  rejection: {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      error: "bad_refresh_token",
      error_description: "The refresh token passed is incorrect or expired.",
    }),
  },
  reason: "bad_refresh_token",
});

// The same class without any verdict at all: a 200 the endpoint called a
// success that carries no usable access token.
deadGrantScenario({
  shape: "HTTP 200 and no usable access token",
  slugPrefix: "refresh200n",
  rejection: {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ access_token: 12_345, token_type: "Bearer" }),
  },
  reason: "access_token",
});

// The other half of the contract, and the reason the classifier keys on status
// rather than "did anything go wrong": an AS having a bad minute has not
// refused anything, so the connection must keep trying rather than demand a
// pointless reconnect from the user.
scenario(
  "Auth failures · a refresh that fails on a 5xx stays retryable: the connection keeps trying instead of demanding a reconnect",
  {},
  withRefusedRefresh(
    "refresh503",
    { status: 503, contentType: "text/plain; charset=utf-8", body: "upstream unavailable" },
    ({ callTool, refreshGrantsSent, connectionHealth }) =>
      Effect.gen(function* () {
        /** The call did not deliver a result — whichever shape the failure
         *  wore. A transient failure is deliberately left unclassified, so
         *  today it degrades into an MCP-level error; that shape is a separate
         *  contract (and a separate change), and pinning it here would make
         *  this scenario fail for improving it. What this scenario owns is
         *  that a stumble is not read as a DEAD GRANT. */
        const expectFailed = (call: McpCall, label: string) => {
          if (!call.ok) return;
          const envelope = JSON.parse(call.text) as ToolEnvelope;
          expect(envelope.ok, label).toBe(false);
        };
        const expectNoReconnectDemanded = (call: McpCall, label: string) =>
          expect(
            call.text,
            `${label}: a server that stumbled is not a grant that died — no reconnect is demanded of the user`,
          ).not.toContain("oauth_reauth_required");

        const first = yield* callTool();
        expectFailed(first, "the tool call did not succeed");
        expectNoReconnectDemanded(first, "first call");
        expect(yield* refreshGrantsSent, "the refresh was attempted once").toBe(1);

        // THE guarantee for this half: the grant is still good, so every later
        // use tries again. A classifier that read 5xx as permanent would leave
        // this at 1 and strand a healthy connection on a transient outage.
        for (const [index, call] of [yield* callTool(), yield* callTool()].entries()) {
          expectFailed(call, `follow-up call ${index + 1} still failed`);
          expectNoReconnectDemanded(call, `follow-up call ${index + 1}`);
        }
        expect(
          yield* refreshGrantsSent,
          "each later use retries the refresh rather than giving up on the grant",
        ).toBe(3);

        const health = yield* connectionHealth;
        expect(
          health.status,
          "the connection is not marked expired on a transient failure",
        ).not.toBe("expired");
      }),
  ),
);
