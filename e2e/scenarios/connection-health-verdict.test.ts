// Cross-target: a connection whose credential cannot be resolved is a health
// VERDICT, not a failed request — and the verdict is persisted, so the next
// surface to ask reads it instead of hammering the authorization server.
//
// Production symptom: a handful of connections whose authorization server had
// stopped re-minting credentials produced hundreds of server errors, every one
// of them on `/api/connections/.../health`, plus unbounded refresh traffic to
// the third party. A probe whose credential resolution failed escaped before
// the verdict was written, so nothing was ever persisted, the freshness gate
// had nothing to serve, and every mount of every surface sent another refresh
// grant to a server that was already refusing.
//
// The journey: an OpenAPI integration completes a real authorization-code flow
// against a live test AS that mints instantly-expiring access tokens and
// refuses every refresh grant. A health check is configured on the
// integration, so the connection takes the probing path. The probe cannot get
// a credential — and must answer with a verdict, persist it, and let a
// freshness window keep the next check off the wire. Both refusals are
// covered: a retryable one (`degraded`) and a dead grant (`expired`).
//
// A second scenario in this file walks the same broken connection through the
// real UI, because the other half of the symptom was the number of SURFACES:
// see its header.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import type { Response } from "playwright";
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
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([openApiHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

const unique = (prefix: string) => `${prefix}${randomBytes(4).toString("hex")}`;

/** Upstream on 127.0.0.1 whose `GET /me` is the obvious health probe. The
 *  credential never resolves in this scenario, so a request reaching here at
 *  all would mean the probe ran with no token — the 401 keeps that honest. */
const serveUpstream = () =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly close: () => void }>((resume) => {
      const server = createServer((request, response) => {
        if (request.method === "GET" && (request.url ?? "").startsWith("/me")) {
          const authorized = (request.headers["authorization"] ?? "").startsWith("Bearer at_");
          response.writeHead(authorized ? 200 : 401, {
            "content-type": "application/json",
          });
          response.end(JSON.stringify(authorized ? { email: "probe@example.test" } : {}));
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
  oauth: {
    readonly authorizationEndpoint: string;
    readonly tokenEndpoint: string;
  },
): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Identity API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/me": {
        get: {
          operationId: "getMe",
          summary: "The current account",
          security: [{ oauth: ["identity.read"] }],
          responses: { "200": { description: "account" } },
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
              scopes: { "identity.read": "Read the account" },
            },
          },
        },
      },
    },
  });

/** One integration with a declared health check, one OAuth client, one
 *  connection completed through a real authorization-code flow — against an
 *  authorization server that refuses every refresh grant in the given way.
 *  Instantly-expiring access tokens mean every credential resolution must
 *  refresh, so the refusal is what the probe meets. */
const connectRefusing = (
  client: Client,
  upstream: { readonly url: string },
  options: {
    readonly name: ConnectionName;
    readonly errorCode: string;
    readonly description: string;
  },
) =>
  Effect.gen(function* () {
    const oauth = yield* serveOAuthTestServer({
      scopes: ["identity.read"],
      tokenExpiresInSeconds: 0,
      supportRefresh: false,
      invalidRefreshTokenErrorCode: options.errorCode,
      invalidRefreshTokenDescription: options.description,
    });
    const slug = IntegrationSlug.make(unique("healthverdict"));
    const clientSlug = OAuthClientSlug.make(unique("healthverdictc"));

    yield* Effect.addFinalizer(() =>
      Effect.all(
        [
          client.connections
            .remove({
              params: { owner: "org", integration: slug, name: options.name },
            })
            .pipe(Effect.ignore),
          client.oauth
            .removeClient({
              params: { slug: clientSlug },
              payload: { owner: "org" },
            })
            .pipe(Effect.ignore),
          client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore),
        ],
        { discard: true },
      ),
    );

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
            scopes: ["identity.read"],
          },
        ],
      },
    });

    // Configure the probe, the way the user does in the editor: the
    // ranked candidates offer the identity GET, and picking it is what
    // sends this connection down the probing path.
    const candidates = yield* client.integrations.healthCheckCandidates({
      params: { slug },
    });
    const getMe = candidates.find((candidate) => candidate.method === "get");
    if (!getMe) return yield* Effect.die("the identity spec exposed no GET candidate");
    yield* client.integrations.healthCheckSet({
      params: { slug },
      payload: { spec: { operation: getMe.operation, identityField: "email" } },
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

    const started = yield* client.oauth.start({
      payload: {
        client: clientSlug,
        clientOwner: "org",
        owner: "org",
        name: options.name,
        integration: slug,
        template: AuthTemplateSlug.make("oauth"),
      },
    });
    expect(started.status, "oauth.start redirects to the authorization server").toBe("redirect");
    if (started.status !== "redirect") return yield* Effect.die("no redirect");

    // Drive the test IdP's consent by hand (authorize → login → code).
    const code = yield* Effect.promise(async () => {
      const authorize = await fetch(started.authorizationUrl, {
        redirect: "manual",
      });
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
    yield* oauth.clearRequests;

    return {
      slug,
      /** Refresh grants the authorization server has actually received.
       *  This is the number the whole fix is about: probing must not
       *  scale with the number of surfaces asking. */
      refreshGrants: oauth.requests.pipe(
        Effect.map(
          (all) =>
            all.filter(
              (request) =>
                request.path === "/token" &&
                request.method === "POST" &&
                request.body.includes("grant_type=refresh_token"),
            ).length,
        ),
      ),
    };
  });

scenario(
  "Health checks · a connection whose refresh is refused reports a persisted verdict instead of failing the request",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const upstream = yield* serveUpstream();

      // ── A refusal that is not "re-auth required" ────────────────────────
      // The AS answers the refresh with a code OTHER than invalid_grant, so
      // retrying could in principle work. This is the shape that used to
      // escape the probe as a server error.
      const degradedName = ConnectionName.make("healthverdictrefused");
      const refused = yield* connectRefusing(client, upstream, {
        name: degradedName,
        errorCode: "invalid_request",
        description: "Refresh temporarily unavailable",
      });

      // THE guarantee: a probe that cannot resolve its credential answers with
      // a verdict. The request itself succeeds — a third party refusing a
      // refresh is not a defect in this product, and reporting it as one is
      // what buried the real signal.
      const probed = yield* client.connections.checkHealth({
        params: { owner: "org", integration: refused.slug, name: degradedName },
        query: {},
      });
      expect(
        probed.status,
        "a connection whose refresh is refused reads degraded, not a failed request",
      ).toBe("degraded");
      expect(
        probed.detail ?? "",
        "the verdict carries the authorization server's reason",
      ).toContain("Refresh temporarily unavailable");
      expect(yield* refused.refreshGrants, "the probe did try the refresh exactly once").toBe(1);

      // The verdict PERSISTS, so the accounts list shows the state at a glance
      // and the freshness gate has something to serve.
      const stored = yield* client.connections.get({
        params: { owner: "org", integration: refused.slug, name: degradedName },
      });
      expect(stored?.lastHealth?.status, "the verdict is persisted on the connection").toBe(
        "degraded",
      );
      expect(stored?.lastHealth?.checkedAt, "and it is the verdict this probe produced").toBe(
        probed.checkedAt,
      );

      // And because it persisted, a caller that DOES pass a freshness window is
      // served from it: the server's gate has something to answer with, so the
      // authorization server sees nothing more. (The automatic client path
      // deliberately passes no window for a non-healthy verdict — recovery has
      // to be able to show — but the gate itself must work for the callers that
      // opt into it.)
      for (let mount = 0; mount < 3; mount++) {
        const remount = yield* client.connections.checkHealth({
          params: {
            owner: "org",
            integration: refused.slug,
            name: degradedName,
          },
          query: { ifStaleMs: 30_000 },
        });
        expect(remount.status, "a repeat check inside the window keeps the verdict").toBe(
          "degraded",
        );
        expect(remount.checkedAt, "and it IS the persisted verdict, not a new probe").toBe(
          probed.checkedAt,
        );
      }
      expect(
        yield* refused.refreshGrants,
        "repeated checks inside the window never reach the authorization server again",
      ).toBe(1);

      // ── A dead grant ───────────────────────────────────────────────────
      // invalid_grant means the user must re-authenticate: a different verdict
      // through the same probing path, and it persists the same way.
      const expiredName = ConnectionName.make("healthverdictdead");
      const revoked = yield* connectRefusing(client, upstream, {
        name: expiredName,
        errorCode: "invalid_grant",
        description: "Grant revoked",
      });

      const dead = yield* client.connections.checkHealth({
        params: { owner: "org", integration: revoked.slug, name: expiredName },
        query: {},
      });
      expect(dead.status, "a revoked grant reads expired, so the UI can offer reconnect").toBe(
        "expired",
      );
      expect(dead.detail ?? "", "the verdict carries the authorization server's reason").toContain(
        "Grant revoked",
      );
      const storedDead = yield* client.connections.get({
        params: { owner: "org", integration: revoked.slug, name: expiredName },
      });
      expect(storedDead?.lastHealth?.status, "the expired verdict is persisted too").toBe(
        "expired",
      );
    }),
  ),
);

// ===========================================================================
// The other half of the production symptom, through the real UI. A connection
// whose refresh is refused is rendered by several surfaces (the integration
// page's Connections list and the integrations list summary), and each one
// revalidates on mount. Before the fix every one of those probes escaped as a
// SERVER ERROR instead of a verdict, so one broken connection produced a
// stream of captured errors and no surface could show the user what was wrong.
//
// What this pins down is that shape, not the volume: every automatic health
// request succeeds and every surface paints the same Degraded verdict, while
// the per-connection guard keeps each surface to exactly ONE probe — the
// no-probe-storm invariant. Re-probing a broken connection once per surface is
// the deliberate price of letting recovery show on the next load; an
// unbounded loop is the regression worth catching.
//
// Nothing here touches the hook: the browser navigates between the two
// surfaces a user actually visits, and the authorization server's own request
// ledger is the judge. Skips on targets with no browser surface.
// ===========================================================================

scenario(
  "Health checks (UI) · every surface showing a broken connection paints a verdict, and probes exactly once",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const upstream = yield* serveUpstream();

      const name = ConnectionName.make("healthverdictui");
      const refused = yield* connectRefusing(client, upstream, {
        name,
        errorCode: "invalid_request",
        description: "Refresh temporarily unavailable",
      });

      yield* browser.session(identity, async ({ page, step }) => {
        const connections = page.locator("section").filter({
          has: page.getByRole("heading", { level: 3, name: "Connections" }),
        });
        // Every health request the app sends, with the status it came back
        // with: the client's own wire contract, observed from outside. A
        // credential the third party refuses must still produce a SUCCESSFUL
        // health response carrying a verdict — that is the whole fix.
        const healthRequests: string[] = [];
        const healthFailures: string[] = [];
        page.on("request", (request) => {
          if (request.method() === "POST" && request.url().includes("/health")) {
            healthRequests.push(request.url());
          }
        });
        page.on("response", (response) => {
          if (
            response.request().method() === "POST" &&
            response.url().includes("/health") &&
            response.status() >= 400
          ) {
            healthFailures.push(`${String(response.status())} ${response.url()}`);
          }
        });
        const isHealthResponse = (response: Response) =>
          response.request().method() === "POST" && response.url().includes("/health");
        const refreshGrants = () => Effect.runPromise(refused.refreshGrants);

        // Surface 1. No verdict is persisted yet, so this load's automatic
        // check is the probe that discovers the broken credential — the badge
        // appearing is proof it completed and was written down.
        await step("Open the integration: the broken connection reads Degraded", async () => {
          const settled = page.waitForResponse(isHealthResponse, {
            timeout: 30_000,
          });
          await visit(page, `/integrations/${refused.slug}`);
          await settled;
          await connections.getByText("Degraded", { exact: true }).waitFor({ timeout: 30_000 });
        });

        // The baseline is taken AFTER that probe, so the freshness window is
        // running from a verdict written moments ago and the assertion below
        // does not depend on how long the browser took to start.
        const baseline = await refreshGrants();
        expect(baseline, "the first surface did probe the authorization server").toBeGreaterThan(0);
        const afterFirstSurface = healthRequests.length;

        // Surface 2: the integrations list summarises the same connection's
        // health, and mounts its own revalidation.
        await step("Open the integrations list, which shows the same connection", async () => {
          const settled = page.waitForResponse(isHealthResponse, {
            timeout: 30_000,
          });
          await visit(page, "/");
          await settled;
        });

        // What the LIST surface cost at the authorization server.
        const afterList = await refreshGrants();

        // Surface 3: back to the integration page — a fresh mount again.
        await step("Return to the integration page: another mount, another ask", async () => {
          const settled = page.waitForResponse(isHealthResponse, {
            timeout: 30_000,
          });
          await visit(page, `/integrations/${refused.slug}`);
          await settled;
          await connections.getByText("Degraded", { exact: true }).waitFor({ timeout: 30_000 });
        });

        const afterReturn = await refreshGrants();

        const laterRequests = healthRequests.slice(afterFirstSurface);
        expect(
          laterRequests.length,
          "the later surfaces did ask about the connection's health — silence would mean a broken connection could never be seen to recover",
        ).toBeGreaterThan(0);

        expect(
          afterList - baseline,
          "the list surface revalidated the broken connection",
        ).toBeGreaterThan(0);

        // THE production symptom, stated as the third party experiences it.
        // Not "the later surfaces went silent" — they must not, or recovery
        // could never show — but "the traffic is attributable and it stops".
        //
        // Attributable: a refresh grant only ever happens inside a health
        // request, so grants can never outnumber the requests that caused
        // them. More grants than requests is the server retrying in a loop.
        // Counted this way the assertion cannot race a probe that is still in
        // flight: the request is recorded when it is SENT, before its grant.
        expect(
          afterReturn,
          "every refresh grant is attributable to a health request the client sent",
        ).toBeLessThanOrEqual(healthRequests.length);

        // And it stops: once the page has settled, the per-connection guard
        // means no further probes are issued. A quiet window that stays quiet
        // is the storm's absence stated directly, rather than a probe count
        // sampled at one arbitrary instant.
        const settled = healthRequests.length;
        await page.waitForTimeout(3_000);
        expect(
          healthRequests.length,
          "a settled page stops probing; a still-climbing count is the guard failing and the effect re-probing in a loop",
        ).toBe(settled);

        // And the shape that actually reached production: a refused refresh is
        // answered, not raised. Every one of these requests used to come back
        // as a server error, which is what buried the signal.
        expect(
          healthFailures,
          "no automatic health request failed; a refused refresh is a verdict, not an error",
        ).toEqual([]);
      });
    }),
  ),
);
