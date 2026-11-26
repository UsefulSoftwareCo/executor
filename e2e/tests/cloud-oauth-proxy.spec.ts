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

const stageStatePrefix = (origin: string) => `x2.${Buffer.from(origin).toString("base64url")}.`;

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
    callbacks: visited
      .filter((url) => url.pathname.startsWith("/api/auth/callback/"))
      .map((url) => `${url.origin}${url.pathname}`),
  };
});

const ownSignIn = Effect.gen(function* () {
  const target = yield* Target;
  const { browser, edge } = targetHosts(target);
  const signIn = yield* recordedGoogleSignIn;
  expect(signIn.redirectUri).toBe(`${edge}/api/auth/callback/google`);
  expect(signIn.prompt).toBe("select_account");
  expect(signIn.callbacks).toEqual([
    `${edge}/api/auth/callback/google`,
    `${browser}/api/auth/callback/google`,
  ]);
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
        expect(signIn.redirectUri).toBe(`${productionEdge}/api/auth/callback/google`);
        expect(signIn.callbacks).toEqual([
          `${productionEdge}/api/auth/callback/google`,
          `${roleHost(production, "app")}/api/auth/callback/google`,
          `${stage}/api/auth/callback/google/oauth-proxy`,
        ]);
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
        expect((yield* issuer.metrics).registeredRedirects).toEqual([[productionCallback]]);
        const authorization = new URL((yield* body(SignIn, started)).authorizationUrl);
        expect(authorization.searchParams.get("redirect_uri")).toBe(productionCallback);
        expect(authorization.searchParams.get("state")).toMatch(
          new RegExp(`^${stageStatePrefix(stage).replace(/[.]/g, "\\.")}[A-Za-z0-9_-]+$`),
        );

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

        const untrusted = yield* rawRequest(
          `${productionCallback}?code=synthetic-code&state=${stageStatePrefix("https://evil.example")}synthetic`,
        );
        expect(untrusted.status).toBe(400);
        expect(untrusted.location).toBeNull();
      }),
    ),
  );
});
