import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthInteropIssuer } from "../support/oauth-interop-issuer.ts";
import { appsManifest } from "../support/apps-release.ts";
import { scenarios } from "../test-plan.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { noPageErrors } from "../support/page-errors.ts";

const hydrationFailure = /hydrat|Minified React error #(418|419|423|425)/i;
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const Connection = Schema.Struct({
  state: Schema.Struct({
    status: Schema.String,
    account: Schema.optional(Schema.Struct({ id: Schema.String })),
  }),
});

const pendingSignIn = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    http = yield* HttpClient.HttpClient;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const issuer = yield* oauthInteropIssuer("apple");
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: "Emailed sign-in link",
    files: [
      {
        path: "index.ts",
        content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Link service",auth:{oauth:oauth2({discover:${JSON.stringify(`${issuer.origin}/mcp`)}})}});
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
  const { authorizationUrl } = yield* body(SignIn, started);
  const callbackUrl = yield* Effect.scoped(
    Effect.gen(function* () {
      const response = yield* HttpClient.withScope(http).get(authorizationUrl);
      expect(response.status).toBe(302);
      const location = response.headers.location;
      if (location === undefined) return yield* Effect.die("Service did not return a callback");
      return new URL(location);
    }),
  ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
  expect(callbackUrl.searchParams.get("code")).not.toBeNull();
  const read = api
    .request(actors.owner, "GET", `${prefix}/connections/${connection.id}`)
    .pipe(Effect.flatMap((response) => body(Connection, response)));
  const removeAccount = (account: string) =>
    Effect.addFinalizer(() =>
      api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`).pipe(Effect.orDie),
    );
  return { prefix, app: app.id, connection: connection.id, callbackUrl, read, removeAccount };
});

const openLink = (label: string, callbackUrl: URL, organizationSlug: string, app: string) =>
  Effect.flatMap(Browser, (browser) =>
    browser.use(label, (page) =>
      page.goto(`${callbackUrl.pathname}${callbackUrl.search}`).then(() =>
        Promise.race([
          page
            .waitForURL((url) => url.pathname === `/org/${organizationSlug}/apps/${app}`)
            .then(() => page.getByRole("heading", { name: "Name this account" }).waitFor())
            .then(() => ({ connected: true, alert: null })),
          page
            .getByRole("heading", { name: "Account not connected", exact: true })
            .waitFor()
            .then(() => page.getByRole("alert").innerText())
            .then((alert) => ({ connected: false, alert })),
        ]),
      ),
    ),
  );

layer(HostedLive, { excludeTestServices: true })("OAuth callback in a new tab", (it) => {
  it.effect(scenarios.oauthCallbackNewTab.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser;
        const signIn = yield* pendingSignIn;
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.owner);
        const html = yield* browser.use("Request the sign-in link's document", (page) =>
          page
            .context()
            .request.get(`${signIn.callbackUrl.pathname}${signIn.callbackUrl.search}`, {
              headers: { accept: "text/html" },
            })
            .then((document) => document.text()),
        );
        expect(html).toContain("Connecting account…");
        expect(html).toContain("Finishing sign-in…");
        const failures: string[] = [];
        yield* browser.use("Watch hydration", (page) => {
          page.on("console", (message) => {
            if (message.type() === "error" && hydrationFailure.test(message.text()))
              failures.push(message.text());
          });
          page.on("pageerror", (error) => {
            if (hydrationFailure.test(String(error))) failures.push(String(error));
          });
          return Promise.resolve();
        });
        const outcome = yield* openLink(
          "Open the emailed sign-in link in a new tab",
          signIn.callbackUrl,
          actors.organization.slug,
          signIn.app,
        );
        expect(outcome).toEqual({ connected: true, alert: null });
        yield* noPageErrors(failures);
        const completed = yield* signIn.read;
        expect(completed.state.status).toBe("completed");
        if (completed.state.account !== undefined)
          yield* signIn.removeAccount(completed.state.account.id);
        yield* browser.checkpoint("OAuth-new-tab-returned-to-app");
      }),
    ),
  );

  it.effect(scenarios.oauthCallbackOtherUser.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const signIn = yield* pendingSignIn;
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.member);
        const refused = yield* openLink(
          "Another member opens the sign-in link",
          signIn.callbackUrl,
          actors.organization.slug,
          signIn.app,
        );
        expect(refused).toEqual({
          connected: false,
          alert:
            "Another Executor user started this sign-in. Sign in as that user and open the link again.",
        });
        yield* browser.checkpoint("OAuth-link-refused-for-another-member");
        const resolved = yield* api.request(actors.member, "POST", "/api/oauth/callback/resolve", {
          callbackUrl: signIn.callbackUrl.href,
        });
        expect(resolved.status).toBe(403);
        const completed = yield* api.request(
          actors.member,
          "POST",
          `${signIn.prefix}/connections/${signIn.connection}/oauth/complete`,
          { callbackUrl: signIn.callbackUrl.href },
        );
        expect(completed.status).toBe(403);
        expect((yield* signIn.read).state.status).toBe("pending");
        yield* browser.login(actors.owner);
        const outcome = yield* openLink(
          "The member who started it opens the same link",
          signIn.callbackUrl,
          actors.organization.slug,
          signIn.app,
        );
        expect(outcome).toEqual({ connected: true, alert: null });
        const connected = yield* signIn.read;
        expect(connected.state.status).toBe("completed");
        if (connected.state.account !== undefined)
          yield* signIn.removeAccount(connected.state.account.id);
      }),
    ),
  );
});
