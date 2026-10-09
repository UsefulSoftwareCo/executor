/**
 * Some services sign in through an emailed link, which opens a new tab. The local callback there
 * has neither the connection grant nor the return target the starting tab saved.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { oauthInteropIssuer } from "../support/oauth-interop-issuer.ts";
import { Target } from "../support/platform.ts";
import { createProfile } from "../support/profiles.ts";
import { appsManifest } from "../support/apps-release.ts";
import { scenarios } from "../test-plan.ts";

const Published = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });
const Link = Schema.Struct({ connection: Schema.String, url: Schema.String });
const Connection = Schema.Struct({
  state: Schema.Struct({
    status: Schema.String,
    account: Schema.optional(Schema.Struct({ id: Schema.String })),
  }),
});

layer(TestLive, { excludeTestServices: true })("Local OAuth callback in a new tab", (it) => {
  it.effect(scenarios.localOAuthCallbackNewTab.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          target = yield* Target,
          http = yield* HttpClient.HttpClient;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
        const issuer = yield* oauthInteropIssuer("apple");
        const deployed = yield* api.request(agent, "POST", "/v1/apps/deploy", {
          owner: "local",
          name: "Emailed sign-in link",
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Link service",auth:{oauth:oauth2({discover:${JSON.stringify(`${issuer.origin}/mcp`)}})}});
export default defineApp({accounts:{service}},async()=>({tools:router({})}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Published, deployed);
        let account: string | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(agent, "DELETE", `/v1/apps/${app.id}`);
            if (account !== undefined)
              yield* api.request(agent, "DELETE", `/v1/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const profile = yield* createProfile(agent, `/v1/apps/${app.id}`, {
          owner: "local",
          subject: "local",
        });
        const link = yield* body(
          Link,
          yield* api.request(agent, "POST", "/account-connect/api/requests", {
            owner: "local",
            target: { app: app.id, profile: profile.id, requirement: "service" },
          }),
        );
        const pairing = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* session.send("POST", "/auth/pair", undefined, headers),
        );
        yield* browser.use("Pair the local browser", (page) =>
          page
            .goto(pairing.url)
            .then(() => page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" })),
        );
        yield* browser.omitNetworkTrace;
        // The service would email its sign-in link; this tab never receives the redirect.
        const authorizationUrl = yield* browser.use("Start sign-in from the link page", (page) =>
          page.goto(link.url).then(
            () =>
              new Promise<string>((resolve, reject) => {
                page
                  .route(`${issuer.origin}/**`, (route) => {
                    resolve(route.request().url());
                    return route.abort();
                  })
                  .then(() =>
                    page.getByRole("button", { name: "Connect Link service", exact: true }).click(),
                  )
                  .catch(reject);
              }),
          ),
        );
        const callbackUrl = yield* Effect.scoped(
          Effect.gen(function* () {
            const response = yield* HttpClient.withScope(http).get(authorizationUrl);
            expect(response.status).toBe(302);
            const location = response.headers.location;
            if (location === undefined)
              return yield* Effect.die("Service did not return a callback");
            return new URL(location);
          }),
        ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        expect(callbackUrl.searchParams.get("code")).not.toBeNull();
        const opened = yield* browser.use("Open the emailed link in a new tab", (page) =>
          page
            .context()
            .newPage()
            .then((tab) =>
              tab
                .goto(callbackUrl.href)
                // Server rendering shows no sign-in until the page reads its address, so wait
                // for the outcome: the page returns to Accounts once the account is saved.
                .then(() =>
                  tab
                    .waitForURL((url) => url.pathname === "/accounts", { timeout: 15_000 })
                    .then(() => "connected")
                    .catch(() => tab.locator("body").innerText()),
                )
                .finally(() => tab.close()),
            ),
        );
        expect(opened).toBe("connected");
        const completed = yield* body(
          Connection,
          yield* api.request(agent, "GET", `/v1/account-connections/${link.connection}`),
        );
        account = completed.state.account?.id;
        expect(completed.state.status).toBe("completed");
      }),
    ),
  );
});
