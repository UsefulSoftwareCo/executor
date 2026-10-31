/** Completion cannot replace a provisioned plain-slot link through a mixed provider. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
import { provisionedSource } from "../support/provisioned-source.ts";
import { scenarios } from "../test-plan.ts";
const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
layer(HostedLive, { excludeTestServices: true })("Mixed provisioned methods", (it) => {
  it.effect(scenarios.provisionedMixed.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const files = (provisioned: boolean) => [
          {
            path: "index.ts",
            content: provisionedSource(provisioned, true, issuer.origin)
              .replace("string, oauth2", "string, oauth2, interactive")
              .replace("auth: {", 'auth: { device: interactive({ label: "Device" }),')
              .replace(
                "tools: router(",
                'connect: { service: { start: async () => ({ session: "fixture-session", message: "Fixture sign-in" }), status: async () => ({ state: "connected" as const, ref: "fixture-acquired-reference" }), remove: async () => {} } }, tools: router(',
              ),
          },
          appsManifest,
        ];
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Mixed host credential fixture",
          files: files(false),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed),
          path = `${prefix}/apps/${app.id}`;
        let account: string | undefined;
        yield* Effect.addFinalizer(() =>
          serverControl("start").pipe(
            Effect.andThen(
              Effect.gen(function* () {
                yield* api.request(actors.owner, "DELETE", path);
                if (account !== undefined)
                  yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
              }),
            ),
            Effect.orDie,
          ),
        );
        const pending = () =>
          api
            .request(actors.owner, "POST", `${path}/accounts/user/service/connections`, {})
            .pipe(Effect.flatMap((r) => body(Resource, r)));
        const connection = yield* pending();
        const added = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/submit`,
          { method: "key", fields: { token: "fixture-host-key" } },
        );
        expect(added.status, JSON.stringify(added.body)).toBe(200);
        account = (yield* body(Resource, added)).id;
        const updated = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
          files: files(true),
        });
        expect(updated.status, JSON.stringify(updated.body)).toBe(200);
        const current = yield* body(Schema.Struct({ app: App }), updated);
        yield* legacyStorage([
          {
            sql: "UPDATE executor_accounts SET provider = $1 WHERE id = $2",
            params: [current.app.requirements.accounts.service.provider, account],
          },
        ]);
        yield* serverControl("start");
        const manual = yield* pending();
        const refused = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${manual.id}/submit`,
          { method: "manual", fields: { token: "ordinary-key" } },
        );
        expect(refused.status, JSON.stringify(refused.body)).toBe(422);
        expect(refused.body).toMatchObject({ _tag: "AccountProvisioned" });
        const oauth = yield* pending();
        const started = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${oauth.id}/oauth/start`,
          { method: "browser" },
        );
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const signIn = yield* body(Schema.Struct({ authorizationUrl: Schema.String }), started);
        const callbackUrl = yield* Effect.scoped(
          Effect.gen(function* () {
            const response = yield* HttpClient.withScope(http).get(signIn.authorizationUrl);
            expect(response.status).toBe(302);
            if (response.headers.location === undefined)
              return yield* Effect.die("No fixture callback");
            return response.headers.location;
          }),
        ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        const completed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${oauth.id}/oauth/complete`,
          { callbackUrl },
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(422);
        expect(completed.body).toMatchObject({ _tag: "AccountProvisioned" });
        const interactive = yield* pending();
        const steps = `${prefix}/connections/${interactive.id}/interactive`;
        expect(
          (yield* api.request(actors.owner, "POST", `${steps}/start`, { method: "device" })).status,
        ).toBe(200);
        const finished = yield* api.request(actors.owner, "GET", `${steps}/status`);
        expect(finished.status, JSON.stringify(finished.body)).toBe(422);
        expect(finished.body).toMatchObject({ _tag: "AccountProvisioned" });
        const used = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "present",
          kind: "query",
          input: {},
        });
        expect(used.status, JSON.stringify(used.body)).toBe(200);
        expect(used.body).toMatchObject({ valid: true });
        const stored = yield* legacyStorage([
          {
            sql: "SELECT id FROM executor_accounts WHERE provider = $1",
            params: [current.app.requirements.accounts.service.provider],
          },
        ]);
        expect(stored).toEqual([[{ id: account }]]);
        yield* serverControl("start");
      }),
    ),
  );
});
