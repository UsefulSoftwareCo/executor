// The desktop system-browser OAuth flow: the renderer cannot receive a
// postMessage from the user's external browser, so it asks the local server
// for the result at `/api/oauth/await/:sessionId`. Guarantee under test: the
// server LONG-POLLS that route — a request issued while the flow is still in
// flight is held open and answered the instant the provider callback
// completes, instead of answered `null` (which made the renderer wait up to a
// full 1s poll tick with the result already sitting in memory).
//
// The journey, against a real `executor web` boot:
//
//   1. `oauth.start` a connect → the await sessionId (= `started.state`).
//   2. Issue TWO await requests BEFORE the provider callback. Both must be
//      held open — a pre-long-poll server answers `null` immediately, which
//      this scenario rejects explicitly.
//   3. Complete the provider consent and land the REAL `/api/oauth/callback`
//      redirect (the path that publishes the result and wakes waiters).
//   4. Both held requests resolve promptly (well under the old 1s poll tick).
//      Exactly ONE carries the ok result; the other answers `null` — still
//      pending — pinning single-consumer delivery of the one-shot result.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { makeEchoMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Cli, RunDir } from "../src/services";
import { withLocalServer, type ServerHandle } from "./local-server";

const api = composePluginApi([mcpHttpPlugin()] as const);

const name = ConnectionName.make("default");
const template = AuthTemplateSlug.make("oauth2");

// The old server answered a pending await with `null` immediately; the new
// one holds it (up to 25s per hold). Observing "still unresolved" after this
// window separates the two deterministically: a holding server cannot answer
// within it, and an answer within it IS the regression.
const HELD_OBSERVATION_MS = 600;

// The renderer used to learn about completion up to a full poll tick (1s)
// after the callback. The held request must beat that with margin for CI
// jitter.
const PROMPT_RESOLUTION_BUDGET_MS = 900;

const apiClient = (server: ServerHandle) =>
  HttpApiClient.make(api, {
    baseUrl: new URL("/api", server.origin).toString(),
    transformClient: HttpClient.mapRequest((request) =>
      HttpClientRequest.setHeader(request, "authorization", `Bearer ${server.token}`),
    ),
  }).pipe(Effect.provide(FetchHttpClient.layer));

interface AwaitAnswer {
  /** When the server answered (response headers received). */
  readonly settledAt: number;
  readonly status: number;
  readonly body: unknown;
}

/** One `/api/oauth/await/:sessionId` request, exactly as the desktop renderer
 *  issues it (bearer-gated GET). The promise settles only when the server
 *  answers — which is the behavior under test. */
const issueAwait = (server: ServerHandle, sessionId: string): Promise<AwaitAnswer> =>
  fetch(`${server.origin}/api/oauth/await/${encodeURIComponent(sessionId)}`, {
    headers: { authorization: `Bearer ${server.token}` },
  }).then(async (response) => {
    const settledAt = Date.now();
    return { settledAt, status: response.status, body: (await response.json()) as unknown };
  });

/** Drive the test AS's consent (authorize → login) and return the app
 *  callback URL the provider redirects to — carrying code + state. Unlike the
 *  durability scenario this does NOT redeem the code by hand: landing the real
 *  callback is the exact path that publishes the result and wakes waiters. */
const resolveProviderConsent = (authorizationUrl: string) =>
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
    return callbackUrl;
  });

scenario(
  "Local · a held OAuth await answers the moment the provider callback lands",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const cli = yield* Cli;
      const runDir = yield* RunDir;

      const oauth = yield* serveOAuthTestServer({ scopes: ["mcp.read"] });
      // A real MCP upstream that accepts the AS's bearers, so the connect is a
      // genuine end-to-end flow, not a stub handshake.
      const mcp = yield* serveMcpServer(() => makeEchoMcpServer({ name: "longpoll-mcp" }), {
        auth: {
          validateAuthorization: (authorization) => oauth.acceptsAuthorizationHeader(authorization),
        },
      });

      const suffix = randomBytes(4).toString("hex");
      const slug = IntegrationSlug.make(`oauth-longpoll-${suffix}`);
      const clientSlug = OAuthClientSlug.make(`oauth-longpoll-client-${suffix}`);

      yield* withLocalServer(cli, runDir, (server) =>
        Effect.gen(function* () {
          const client = yield* apiClient(server);

          yield* client.mcp.addServer({
            payload: {
              transport: "remote",
              name: "Longpoll MCP",
              endpoint: mcp.url,
              slug: String(slug),
              authenticationTemplate: [{ kind: "oauth2" }],
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
              resource: oauth.mcpResourceUrl,
              originIntegration: slug,
            },
          });

          const started = yield* client.oauth.start({
            payload: {
              client: clientSlug,
              clientOwner: "org",
              owner: "org",
              name,
              integration: slug,
              template,
            },
          });
          expect(started.status, "oauth.start redirects to the authorization server").toBe(
            "redirect",
          );
          if (started.status !== "redirect") return yield* Effect.die("no redirect");
          // The await sessionId is the start state — exactly what the desktop
          // renderer passes to openOAuthSystemBrowser.
          const sessionId = started.state;

          // -- 2. Await BEFORE the callback: the requests must be held. ------
          const firstAwait = issueAwait(server, sessionId);
          const secondAwait = issueAwait(server, sessionId);
          const observed = yield* Effect.promise(() =>
            Promise.race([
              firstAwait.then(() => "answered" as const),
              secondAwait.then(() => "answered" as const),
              new Promise<"held">((resolve) =>
                setTimeout(() => resolve("held"), HELD_OBSERVATION_MS),
              ),
            ]),
          );
          expect(
            observed,
            "an await issued mid-flow is held open, not answered null immediately (the pre-long-poll behavior)",
          ).toBe("held");

          // -- 3. Complete consent and land the real callback redirect. ------
          const redirected = yield* resolveProviderConsent(started.authorizationUrl);
          // The harness boots `executor web --port 0` (OS-assigned), and the
          // server builds the redirect URI from the CONFIGURED port — so the
          // redirect reads `127.0.0.1:0`. Land the same callback path + query
          // (code + state, the cryptographic gate) on the server's real bound
          // origin; it is the same server and the same handler.
          const callbackUrl = new URL(redirected);
          expect(
            callbackUrl.pathname,
            "the provider redirects back to this server's OAuth callback",
          ).toBe("/api/oauth/callback");
          const callbackStartedAt = Date.now();
          const callback = yield* Effect.promise(() =>
            fetch(`${server.origin}${callbackUrl.pathname}${callbackUrl.search}`),
          );
          const callbackHtml = yield* Effect.promise(() => callback.text());
          const callbackCompletedAt = Date.now();
          expect(callback.status, "the OAuth callback succeeds").toBe(200);
          expect(callbackHtml, "the callback page reports the connect succeeded").toContain(
            "Connected",
          );

          // -- 4. Both held requests answer promptly; one carries the result.
          const answers = yield* Effect.promise(() => Promise.all([firstAwait, secondAwait]));
          for (const answer of answers) {
            expect(answer.status, "a held await answers 200 like an immediate poll").toBe(200);
          }
          const delivered = answers.filter((answer) => answer.body !== null);
          expect(delivered, "exactly one await receives the one-shot result").toHaveLength(1);
          expect(delivered[0]?.body).toMatchObject({ ok: true, sessionId });
          expect(
            answers.filter((answer) => answer.body === null),
            "the other await answers null — still pending — so a retrying client keeps working",
          ).toHaveLength(1);

          const lastSettledAt = Math.max(...answers.map((answer) => answer.settledAt));
          const sinceCallback = lastSettledAt - callbackCompletedAt;
          // Console output is swallowed by the runner, so park the measured
          // timings in the run dir as reviewable evidence.
          writeFileSync(
            join(runDir, "await-timing.json"),
            JSON.stringify(
              {
                heldObservationMs: HELD_OBSERVATION_MS,
                callbackHandlingMs: callbackCompletedAt - callbackStartedAt,
                awaitsSettledAfterCallbackMs: sinceCallback,
                budgetMs: PROMPT_RESOLUTION_BUDGET_MS,
              },
              null,
              2,
            ),
          );
          expect(
            sinceCallback,
            "held awaits resolve promptly after the callback — well under the old 1s poll tick",
          ).toBeLessThan(PROMPT_RESOLUTION_BUDGET_MS);
        }),
      );
    }),
  ),
);
