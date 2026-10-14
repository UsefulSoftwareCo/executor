/** Facebook appends `#_=_` to its OAuth redirect; the local callback must still complete. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { oauthInteropIssuer } from "../support/oauth-interop-issuer.ts";
import { Target } from "../support/platform.ts";
import { appsManifest } from "../support/apps-release.ts";
import { scenarios } from "../test-plan.ts";

const Published = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });
const Link = Schema.Struct({ connection: Schema.String, url: Schema.String });
const Completed = Schema.Struct({
  state: Schema.Struct({
    status: Schema.Literal("completed"),
    account: Schema.Struct({ id: Schema.String, label: Schema.String }),
  }),
});

layer(TestLive, { excludeTestServices: true })("Local OAuth callback fragment", (it) => {
  it.effect(scenarios.localOAuthCallbackFragment.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          target = yield* Target;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
        const facebook = yield* oauthInteropIssuer("facebook");
        const deployed = yield* api.request(agent, "POST", "/v1/apps/deploy", {
          owner: "local",
          name: "Fragment callback",
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Fragment service",auth:{oauth:oauth2({discover:${JSON.stringify(`${facebook.origin}/mcp`)}})}});
export default defineApp({user: { accounts:{service} }},async()=>({tools:router({})}));`,
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
        const link = yield* body(
          Link,
          yield* api.request(agent, "POST", "/account-connect/api/requests", {
            owner: "local",
            target: { app: app.id, requirement: "service" },
          }),
        );
        yield* browser.omitNetworkTrace;
        const returned = yield* browser.use("Sign in through a service that adds #_=_", (page) =>
          page.goto(link.url).then(() => {
            // Capture the committed callback URL before the page replaces it.
            let callback: string | undefined;
            return Promise.all([
              page.waitForEvent("framenavigated", (frame) => {
                if (frame !== page.mainFrame()) return false;
                const url = frame.url();
                if (new URL(url).pathname !== "/api/oauth/callback") return false;
                callback = url;
                return true;
              }),
              page.getByRole("button", { name: "Connect Fragment service", exact: true }).click(),
            ]).then(() => callback ?? "");
          }),
        );
        // The browser really arrived with the service's fragment.
        expect(new URL(returned).hash).toBe("#_=_");
        const outcome = yield* browser.use("The callback settles", (page) =>
          page
            .getByRole("heading", { name: "Account connected", exact: true })
            .or(page.getByRole("alert"))
            .first()
            .waitFor({ state: "visible" })
            .then(() =>
              Promise.all([
                page.getByRole("alert").allInnerTexts(),
                page.getByRole("heading", { name: "Account connected", exact: true }).count(),
              ]),
            ),
        );
        expect(outcome).toEqual([[], 1]);
        const completed = yield* body(
          Completed,
          yield* api.request(agent, "GET", `/v1/account-connections/${link.connection}`),
        );
        account = completed.state.account.id;
        expect(completed.state.account.label).toBe("Default");
        expect((yield* facebook.metrics).tokenRequests).toEqual([
          { resource: `${facebook.origin}/mcp`, issued: true },
        ]);
        yield* browser.checkpoint("Local-OAuth-fragment-callback-connected");
      }),
    ),
  );
});
