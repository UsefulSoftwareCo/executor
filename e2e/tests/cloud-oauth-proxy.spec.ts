/**
 * Better Auth's OAuth proxy with Cloud's role hosts (`notes/hosted-auth.md`). Production is the
 * proxy's production URL, the edge (`executor.sh`), but its own sign-ins start on its browser
 * origin: `app.`, or the deployment origin under the rollback switch. They must return through the
 * edge's callback without the proxy. A test stage signs in through production instead: the
 * provider returns to production's edge, production exchanges the code and sends the profile to
 * the stage, which keeps the session on its own origin.
 *
 * Every managed local Cloud runs with the proxy on as its production, as production does. A
 * rolled-back run (`e2e:cloud --rollback`) checks its own sign-ins under the switch, and
 * `e2e:cloud --oauth-proxy-preview` runs a test stage beside a second local Cloud, its production.
 *
 * A test stage's connected-account sign-ins name production's callback too, the one services that
 * approve their callbacks accept. Production sends the browser back to the stage the state names,
 * when it trusts that origin, and the stage completes the sign-in itself.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { Onboarding } from "../support/onboarding.ts";
import { Target } from "../support/platform.ts";
import { rawRequest, roleHost, targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";
import { connectionsPath } from "../support/app-accounts.ts";

class ProxyScenarioFailed extends Schema.TaggedError<ProxyScenarioFailed>()("ProxyScenarioFailed", {
  message: Schema.String,
}) {}

const Session = Schema.Struct({ user: Schema.Struct({ email: Schema.String }) });
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const Connection = Schema.Struct({
  state: Schema.Struct({
    status: Schema.String,
    account: Schema.optional(Schema.Struct({ id: Schema.String })),
  }),
});

/**
 * The state of a connected-account sign-in that production returns to `origin`: v2's prefix, the
 * origin in base64url, and a random part (`apps/hosted/cloud/src/contracts/stage-account-state.ts`).
 */
const stageStatePrefix = (origin: string) => `x2.${Buffer.from(origin).toString("base64url")}.`;

/**
 * A Google sign-in through the browser, with every top-level navigation it made, redirects
 * included: the provider's authorization request and each callback the browser passed through.
 */
const recordedGoogleSignIn = Effect.gen(function* () {
  const browser = yield* Browser,
    onboarding = yield* Onboarding;
  const visited: URL[] = [];
  const onRequest = (request: { isNavigationRequest: () => boolean; url: () => string }) => {
    if (request.isNavigationRequest()) visited.push(new URL(request.url()));
  };
  yield* browser.use("Record the sign-in's navigations", (page) =>
    Promise.resolve(page.on("request", onRequest)),
  );
  const identity = yield* onboarding.socialSignIn("google");
  yield* browser.use("Stop recording navigations", (page) =>
    Promise.resolve(page.off("request", onRequest)),
  );
  const authorization = visited.find(
    (url) => url.searchParams.has("client_id") && url.searchParams.has("redirect_uri"),
  );
  if (authorization === undefined)
    return yield* new ProxyScenarioFailed({
      message: "The sign-in never opened the provider's authorization request",
    });
  return {
    identity,
    redirectUri: authorization.searchParams.get("redirect_uri"),
    prompt: authorization.searchParams.get("prompt"),
    // Each Better Auth callback the browser passed through, without its query.
    callbacks: visited
      .filter((url) => url.pathname.startsWith("/api/auth/callback/"))
      .map((url) => `${url.origin}${url.pathname}`),
  };
});

/** Production's own Google sign-in, from its browser origin, with the proxy on. */
const ownSignIn = Effect.gen(function* () {
  const target = yield* Target;
  const { browser, edge } = targetHosts(target);
  const signIn = yield* recordedGoogleSignIn;
  // The provider returns to the edge's registered callback, which sends the browser to the same
  // path on the browser origin. The proxy's completion endpoint is never reached.
  expect(signIn.redirectUri).toBe(`${edge}/api/auth/callback/google`);
  // Google lets the person choose among their signed-in accounts instead of reusing one.
  expect(signIn.prompt).toBe("select_account");
  expect(signIn.callbacks).toEqual([
    `${edge}/api/auth/callback/google`,
    `${browser}/api/auth/callback/google`,
  ]);
  // Production still refuses the completion endpoint, so the proxy secret cannot mint a session.
  const completion = yield* rawRequest(
    `${browser}/api/auth/callback/google/oauth-proxy?callbackURL=%2F&profile=forged`,
  );
  expect(completion.status).toBe(404);
});

layer(TestLive, { excludeTestServices: true })("Cloud OAuth proxy", (it) => {
  it.effect(scenarios.cloudOAuthProxyOwnSignIn.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        expect(targetHosts(target).browser).toBe(roleHost(target.metadata.origin, "app"));
        yield* ownSignIn;
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );

  it.effect(scenarios.cloudOAuthProxyRollback.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        // Under the switch the browser origin is the deployment origin.
        expect(targetHosts(target).browser).toBe(target.metadata.origin);
        yield* ownSignIn;
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );

  it.effect(scenarios.cloudOAuthProxyPreview.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          browser = yield* Browser;
        const production = target.metadata.oauthProxyProduction;
        if (production === undefined)
          return yield* new ProxyScenarioFailed({
            message: "Run this scenario with e2e:cloud --oauth-proxy-preview",
          });
        const stage = targetHosts(target).browser;
        const productionEdge = roleHost(production, "edge");
        const signIn = yield* recordedGoogleSignIn;
        // The stage starts the sign-in with production's registered callback. Production's edge
        // sends the browser to production's browser origin, which exchanges the code there and
        // returns the encrypted profile to the stage's completion endpoint.
        expect(signIn.redirectUri).toBe(`${productionEdge}/api/auth/callback/google`);
        expect(signIn.callbacks).toEqual([
          `${productionEdge}/api/auth/callback/google`,
          `${roleHost(production, "app")}/api/auth/callback/google`,
          `${stage}/api/auth/callback/google/oauth-proxy`,
        ]);
        // The session is the stage's own.
        const session = yield* browser.use("Read the stage's session", (page) =>
          page
            .context()
            .request.get(`${stage}/api/auth/get-session`)
            .then((response) => response.json()),
        );
        expect((yield* Schema.decodeUnknownEffect(Session)(session)).user.email).toBe(
          signIn.identity.email,
        );
      }).pipe(Effect.provide(Onboarding.layer)),
    ),
  );

  it.effect(scenarios.cloudOAuthProxyPreviewAccount.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const production = target.metadata.oauthProxyProduction;
        if (production === undefined)
          return yield* new ProxyScenarioFailed({
            message: "Run this scenario with e2e:cloud --oauth-proxy-preview",
          });
        const stage = targetHosts(target).browser;
        const productionCallback = `${roleHost(production, "edge")}/api/oauth/callback`;
        // The service registers only clients whose every callback it approved: production's.
        const issuer = yield* oauthSetupIssuer;
        yield* issuer.configure({ registrationRedirects: [productionCallback] });
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Approved callbacks only",
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Approved callback service",auth:{oauth:oauth2({discover:${JSON.stringify(`${issuer.origin}/mcp`)}})}});
export default defineApp({user: { accounts:{service} }},async()=>({tools:router({})}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(Resource, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const connection = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
            {},
          ),
        );
        const started = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/oauth/start`,
          { method: "oauth" },
        );
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        // The stage registered production's callback alone, which the service accepted.
        expect((yield* issuer.metrics).registeredRedirects).toEqual([[productionCallback]]);
        const authorization = new URL((yield* body(SignIn, started)).authorizationUrl);
        expect(authorization.searchParams.get("redirect_uri")).toBe(productionCallback);
        expect(authorization.searchParams.get("state")).toMatch(
          new RegExp(`^${stageStatePrefix(stage).replace(/[.]/g, "\\.")}[A-Za-z0-9_-]+$`),
        );

        // The browser follows the service's return through production to the stage's callback
        // page, which completes the sign-in on the stage.
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.owner);
        const visited: URL[] = [];
        const onRequest = (request: { isNavigationRequest: () => boolean; url: () => string }) => {
          if (request.isNavigationRequest()) visited.push(new URL(request.url()));
        };
        yield* browser.use("Sign in at the service and return to the stage", (page) => {
          page.on("request", onRequest);
          return page
            .goto(authorization.href)
            .then(() =>
              page.waitForURL(
                (url) =>
                  url.origin === stage &&
                  url.pathname === `/org/${actors.organization.slug}/apps/${app.id}`,
              ),
            )
            .then(() => page.getByRole("heading", { name: "Name this account" }).waitFor())
            .finally(() => page.off("request", onRequest));
        });
        const callbacks = visited
          .filter((url) => url.pathname.endsWith("/oauth/callback"))
          .map((url) => ({
            at: `${url.origin}${url.pathname}`,
            code: url.searchParams.has("code"),
            state: url.searchParams.get("state"),
          }));
        const state = authorization.searchParams.get("state");
        expect(callbacks).toEqual([
          { at: productionCallback, code: true, state },
          { at: `${stage}/oauth/callback`, code: true, state },
        ]);
        expect((yield* issuer.metrics).tokenExchanges).toBe(1);
        const completed = yield* api
          .request(actors.owner, "GET", `${prefix}/connections/${connection.id}`)
          .pipe(Effect.flatMap((response) => body(Connection, response)));
        expect(completed.state.status).toBe("completed");
        const account = completed.state.account;
        expect(account).toBeDefined();
        if (account !== undefined)
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
              .pipe(Effect.orDie),
          );

        // Production returns only to origins it trusts; any other's sign-in is refused there.
        const untrusted = yield* rawRequest(
          `${productionCallback}?code=synthetic-code&state=${stageStatePrefix("https://evil.example")}synthetic`,
        );
        expect(untrusted.status).toBe(400);
        expect(untrusted.location).toBeNull();
      }),
    ),
  );
});
