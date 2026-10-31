import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { accountIdentityIssuer } from "../support/account-identity-issuer.ts";
import { IdentityAccount } from "../support/account-identity-product.ts";
import { appsManifest } from "../support/apps-release.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Hosted identity policy", (it) => {
  it.effect(scenarios.accountIdentityPolicy.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          http = yield* HttpClient.HttpClient,
          issuer = yield* accountIdentityIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const accounts = new Set<string>(),
          apps: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const app of apps)
              yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app}`);
            for (const account of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const deploy = (name: string, scopes: string[]) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name,
              files: [
                appsManifest,
                {
                  path: "index.ts",
                  content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:${JSON.stringify(name)},auth:{oauth:oauth2(${JSON.stringify({ authorizationUrl: issuer.origin + "/authorize", tokenUrl: issuer.origin + "/token", scopes, tokenEndpointAuthMethod: "none", identity: { issuer: issuer.origin, name: "Policy identity" } })})}});
export default defineApp({user:{accounts:{service}}},async()=>({tools:router({})}));`,
                },
              ],
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = (yield* body(Resource, response)).id;
            apps.push(app);
            return app;
          });
        const connect = (app: string, shared = false) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.owner,
              "POST",
              connectionsPath(`${prefix}/apps/${app}`, "user", "service"),
              shared ? { destination: { kind: "shared", audience: { kind: "everyone" } } } : {},
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return (yield* body(Resource, response)).id;
          });
        const firstApp = yield* deploy("Policy source", ["read", "write"]);
        const firstConnection = yield* connect(firstApp);
        const start = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${firstConnection}/oauth/start`,
          { method: "oauth", client: { clientId: "policy-client" } },
        );
        expect(start.status, JSON.stringify(start.body)).toBe(200);
        const authorization = yield* body(
          Schema.Struct({ authorizationUrl: Schema.String }),
          start,
        );
        const callbackUrl = yield* Effect.scoped(
          Effect.gen(function* () {
            const response = yield* HttpClient.withScope(http).get(authorization.authorizationUrl);
            expect(response.status).toBe(302);
            if (response.headers.location === undefined)
              return yield* Effect.die("Issuer omitted callback");
            return response.headers.location;
          }),
        ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        const completed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${firstConnection}/oauth/complete`,
          { callbackUrl },
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const source = yield* body(IdentityAccount, completed);
        accounts.add(source.id);
        expect(source.identity).toBeDefined();
        const reader = yield* deploy("Policy reader", ["read"]),
          pending = yield* connect(reader);
        const planPath = `${prefix}/connections/${pending}/oauth/plan`;
        const plan = yield* api.request(actors.owner, "POST", planPath, {
          method: "oauth",
          sourceAccount: source.id,
        });
        expect(plan.status, JSON.stringify(plan.body)).toBe(200);
        expect((yield* body(Schema.Struct({ status: Schema.String }), plan)).status).toBe("reuse");
        for (const operation of ["plan", "reuse"]) {
          const refused = yield* api.request(
            actors.member,
            "POST",
            `${prefix}/connections/${pending}/oauth/${operation}`,
            operation === "plan"
              ? { method: "oauth", sourceAccount: source.id }
              : { method: "oauth", account: source.id },
          );
          expect([403, 404]).toContain(refused.status);
        }
        const privateRead = yield* api.request(
          actors.member,
          "GET",
          `${prefix}/accounts/${source.id}`,
        );
        expect([403, 404]).toContain(privateRead.status);
        const shared = yield* connect(reader, true);
        const different = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${shared}/oauth/plan`,
          { method: "oauth", sourceAccount: source.id },
        );
        expect(different.status, JSON.stringify(different.body)).toBe(200);
        expect(
          yield* body(Schema.Struct({ status: Schema.String, reason: Schema.String }), different),
        ).toEqual({ status: "incompatible", reason: "placement" });
        const reuse = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${pending}/oauth/reuse`,
          { method: "oauth", account: source.id },
        );
        expect(reuse.status, JSON.stringify(reuse.body)).toBe(200);
        const binding = yield* body(
          Schema.Struct({ status: Schema.Literal("completed"), account: IdentityAccount }),
          reuse,
        );
        accounts.add(binding.account.id);
        expect(binding.account.identity?.id).toBe(source.identity?.id);
        expect((yield* issuer.metrics).authorizations).toBe(1);
        expect([403, 404]).toContain(
          (yield* api.request(actors.member, "GET", `${prefix}/accounts/${binding.account.id}`))
            .status,
        );
      }),
    ),
  );
});
