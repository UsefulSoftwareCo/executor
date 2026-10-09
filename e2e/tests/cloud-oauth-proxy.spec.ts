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
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Onboarding } from "../support/onboarding.ts";
import { Target } from "../support/platform.ts";
import { rawRequest, roleHost, targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

class ProxyScenarioFailed extends Schema.TaggedError<ProxyScenarioFailed>()("ProxyScenarioFailed", {
  message: Schema.String,
}) {}

const Session = Schema.Struct({ user: Schema.Struct({ email: Schema.String }) });

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
});
