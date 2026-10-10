/**
 * Kept app declarations and tool listings are never served for an OAuth account that a live read
 * would refuse.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { appsManifest } from "../support/apps-release.ts";

const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const Workflows = Schema.Array(Schema.Struct({ name: Schema.String }));
const Bundle = Schema.Struct({
  skills: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
});
const Failure = Schema.Struct({ _tag: Schema.String });

/** Token lifetime in seconds. Renewal starts 30 s before expiry, so 40 s gives a 10 s window. */
const lifetime = 40;

layer(HostedLive, { excludeTestServices: true })("App declarations and OAuth grants", (it) => {
  it.effect(
    scenarios.appDeclarationsOAuth.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            http = yield* HttpClient.HttpClient;
          const issuer = yield* oauthSetupIssuer;
          yield* issuer.configure({ refreshTokens: true, expiresIn: lifetime });
          const prefix = `/api/organizations/${actors.organization.id}`;
          const discover = JSON.stringify(`${issuer.origin}/mcp`);
          const resource = JSON.stringify(`${issuer.origin}/resource`);
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Declarations OAuth ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import {defineApp,defineProvider,oauth2,query,workflow,object, router} from "apps";
const service=defineProvider({name:"Reporting",auth:{oauth:oauth2({discover:${discover}})}});
const noop=workflow({input:object({})},async()=>null);
export default defineApp({accounts:{service}},async({accounts})=>{
  const generation=accounts.service.fields.access_token.split("-").pop();
  return {
    tools: router({
      read:query({input:object({})},async({fetch})=>(await fetch(${resource},{headers:{authorization:"Bearer "+accounts.service.fields.access_token}})).json()),
    }),
    workflows:{["grant_"+generation]:noop},
    skills:[{name:"grant-guide",description:"Grant "+generation,files:[{path:"SKILL.md",content:"---\\nname: grant-guide\\ndescription: Grant "+generation+"\\n---\\n# Grant"}]}],
  };
});`,
              },
              appsManifest,
            ],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(Resource, deployed);
          const path = `${prefix}/apps/${app.id}`;
          let account: string | undefined;
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* api.request(actors.owner, "DELETE", path);
              if (account !== undefined)
                yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
            }).pipe(Effect.orDie),
          );
          const profile = yield* createProfile(actors.owner, path);
          const connection = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${path}/connections`, {
              requirement: "service",
              profile: profile.id,
            }),
          );
          const started = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/oauth/start`,
            { method: "oauth", label: "Reporting" },
          );
          expect(started.status, JSON.stringify(started.body)).toBe(200);
          const { authorizationUrl } = yield* body(SignIn, started);
          const callbackUrl = yield* Effect.scoped(
            Effect.gen(function* () {
              const consent = yield* HttpClient.withScope(http).get(authorizationUrl);
              expect(consent.status).toBe(302);
              const location = consent.headers.location;
              if (location === undefined)
                return yield* Effect.die("Issuer did not return a callback");
              return location;
            }),
          ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
          const completed = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/oauth/complete`,
            { callbackUrl },
          );
          expect(completed.status, JSON.stringify(completed.body)).toBe(200);
          account = (yield* body(Resource, completed)).id;
          const connectedAt = Date.now();

          const workflows = api.request(
            actors.owner,
            "GET",
            `${path}/workflows?profile=${profile.id}`,
          );
          const bundle = api.request(
            actors.owner,
            "GET",
            `${path}/skill-bundle?profile=${profile.id}`,
          );
          const listing = api.request(actors.owner, "GET", `${path}/tools?profile=${profile.id}`);
          const names = (response: { status: number; body: unknown }) =>
            body(Workflows, response).pipe(Effect.map((rows) => rows.map((row) => row.name)));
          const descriptions = (response: { status: number; body: unknown }) =>
            body(Bundle, response).pipe(
              Effect.map((value) => value.skills.map((skill) => skill.description)),
            );

          // Evaluated with the first issued token, then kept for identical reads.
          const first = yield* workflows;
          expect(first.status, JSON.stringify(first.body)).toBe(200);
          expect(yield* names(first)).toEqual(["grant_token"]);
          const kept = yield* workflows;
          expect(yield* names(kept)).toEqual(["grant_token"]);
          const skills = yield* bundle;
          expect(yield* descriptions(skills)).toEqual(["Grant token"]);
          expect(yield* descriptions(yield* bundle)).toEqual(["Grant token"]);
          const listed = yield* listing;
          expect(listed.status, JSON.stringify(listed.body)).toBe(200);
          expect(listed.body).toMatchObject({ items: [{ name: "read" }] });
          expect((yield* listing).body).toEqual(listed.body);
          // Every read above ran before renewal was due, so the stored credential never changed.
          expect(Date.now() - connectedAt).toBeLessThan((lifetime - 30) * 1000);

          // Once renewal is due, the provider refuses the grant with invalid_grant, and the grant
          // needs reconnecting.
          yield* Effect.sleep(Math.max(0, connectedAt + (lifetime - 29) * 1000 - Date.now()));
          yield* issuer.configure({
            tokenError: { status: 400, body: { error: "invalid_grant" } },
          });
          const refused = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
            profile: profile.id,
            tool: "read",
            kind: "query",
            input: {},
          });
          expect(refused.status, JSON.stringify(refused.body)).toBe(409);
          expect((yield* body(Failure, refused))._tag).toBe("OAuthReconnectRequired");

          // Every kept result is still within its stale bound, yet none is served.
          for (const read of [workflows, bundle, listing]) {
            const denied = yield* read;
            expect(denied.status, JSON.stringify(denied.body)).toBe(409);
            expect((yield* body(Failure, denied))._tag).toBe("OAuthReconnectRequired");
          }
          expect(Date.now() - connectedAt).toBeLessThan(60_000);
        }),
      ),
    { timeout: 120_000 },
  );
});
