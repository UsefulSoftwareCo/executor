/** Services whose OAuth deviates from the common shape still connect through the real APIs. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import {
  entraApiScope,
  entraClient,
  entraTenant,
  oauthInteropIssuer,
  otherTenant,
} from "../support/oauth-interop-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { appsManifest } from "../support/apps-release.ts";
import { scenarios } from "../test-plan.ts";

const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const Failure = Schema.Struct({
  _tag: Schema.String,
  reason: Schema.String,
  message: Schema.String,
  recovery: Schema.optional(Schema.Struct({ action: Schema.String, instructions: Schema.String })),
  callbackUrl: Schema.optional(Schema.String),
  serviceError: Schema.optional(
    Schema.Struct({ error: Schema.String, description: Schema.optional(Schema.String) }),
  ),
});
const Echo = Schema.Struct({
  refreshed: Schema.Boolean,
  authorization: Schema.NullOr(Schema.String),
});

/** Deploy an app with one OAuth account, connect it, and drive sign-in through the service. */
const oauthApp = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    http = yield* HttpClient.HttpClient;
  const prefix = `/api/organizations/${actors.organization.id}`;
  /** With `resourceUrl`, the app's `read` query presents the account's token there. */
  const start = (
    config: object,
    client?: { clientId: string; clientSecret: string },
    resourceUrl?: string,
  ) =>
    Effect.gen(function* () {
      const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name: `OAuth interop ${randomUUID().slice(0, 8)}`,
        files: [
          {
            path: "index.ts",
            content: `import { defineApp, defineProvider, oauth2, query, object, router } from "apps";
const service=defineProvider({name:"Interop service",auth:{oauth:oauth2(${JSON.stringify(config)})}});
export default defineApp({accounts:{service}},async(${
              resourceUrl === undefined
                ? ")=>({tools:router({})}));"
                : `{accounts})=>({tools:router({read:query({input:object({})},async({fetch})=>{
  const result=await fetch(${JSON.stringify(resourceUrl)},{headers:{authorization:"Bearer "+accounts.service.fields.access_token}});
  return result.json();
})})}));`
            }`,
          },
          appsManifest,
        ],
      });
      expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
      const app = yield* body(Resource, deployed);
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
      );
      const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
      const connection = yield* body(
        Resource,
        yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
          requirement: "service",
          profile: profile.id,
        }),
      );
      const started = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/connections/${connection.id}/oauth/start`,
        {
          method: "oauth",
          label: "Interop account",
          ...(client === undefined ? {} : { client }),
        },
      );
      return { app: app.id, profile: profile.id, connection: connection.id, started };
    });
  /** Follow the service's consent redirect and return Executor's callback URL. */
  const consent = (authorizationUrl: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* HttpClient.withScope(http).get(authorizationUrl);
        expect(response.status).toBe(302);
        const location = response.headers.location;
        if (location === undefined) return yield* Effect.die("Service did not return a callback");
        return new URL(location);
      }),
    ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
  const complete = (connection: string, callbackUrl: URL) =>
    Effect.gen(function* () {
      const completed = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/connections/${connection}/oauth/complete`,
        { callbackUrl: callbackUrl.href },
      );
      if (completed.status === 200) {
        const account = yield* body(Resource, completed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
            .pipe(Effect.orDie),
        );
      }
      return completed;
    });
  /** Start, consent and complete; return the authorization URL Executor built. */
  const connect = (
    config: object,
    client?: { clientId: string; clientSecret: string },
    resourceUrl?: string,
  ) =>
    Effect.gen(function* () {
      const { app, profile, connection, started } = yield* start(config, client, resourceUrl);
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const authorizationUrl = new URL((yield* body(SignIn, started)).authorizationUrl);
      const callbackUrl = yield* consent(authorizationUrl.href);
      const completed = yield* complete(connection, callbackUrl);
      return { app, profile, authorizationUrl, callbackUrl, completed };
    });
  /** Call the app's `read` query, which uses the account's current access token. */
  const read = (app: string, profile: string) =>
    api.request(actors.owner, "POST", `${prefix}/apps/${app}/tools/call`, {
      profile,
      tool: "read",
      kind: "query",
      input: {},
    });
  return { start, consent, complete, connect, read };
});

layer(HostedLive, { excludeTestServices: true })("OAuth service interoperability", (it) => {
  it.effect(scenarios.oauthMicrosoftEntra.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const app = yield* oauthApp;

        // One tenant: Entra takes the audience from the API scope and rejects the MCP server's
        // RFC 8707 resource with invalid_target, so Executor must not send it.
        const tenant = yield* oauthInteropIssuer("entra-tenant");
        const single = yield* app.connect({ discover: `${tenant.origin}/mcp` }, entraClient);
        expect(single.authorizationUrl.searchParams.has("resource")).toBe(false);
        expect(single.authorizationUrl.searchParams.get("scope")?.split(" ")).toContain(
          entraApiScope,
        );
        expect(single.callbackUrl.searchParams.get("error")).toBeNull();
        expect(single.completed.status, JSON.stringify(single.completed.body)).toBe(200);
        expect((yield* tenant.metrics).tokenRequests).toEqual([{ resource: null, issued: true }]);

        // Multi-tenant `common`: discovery names a `{tenantid}` issuer template that the metadata
        // document's own location instantiates. `openid` is requested without a nonce.
        const common = yield* oauthInteropIssuer("entra-common");
        const multi = yield* app.connect({ discover: `${common.origin}/mcp` }, entraClient);
        expect(multi.authorizationUrl.searchParams.has("resource")).toBe(false);
        expect(multi.authorizationUrl.searchParams.get("scope")?.split(" ")).toContain("openid");
        expect(multi.authorizationUrl.searchParams.has("nonce")).toBe(false);
        expect(multi.completed.status, JSON.stringify(multi.completed.body)).toBe(200);
        expect((yield* common.metrics).discoveryRequests).toEqual([
          "/common/v2.0/.well-known/openid-configuration",
        ]);

        // A provider may declare the template Microsoft documents instead of discovering it.
        const declared = {
          issuer: `${common.origin}/{tenantid}/v2.0`,
          authorizationUrl: `${common.origin}/authorize`,
          tokenUrl: `${common.origin}/token`,
          scopes: ["openid", entraApiScope],
        };
        const withTemplate = yield* app.connect(declared, entraClient);
        expect(withTemplate.completed.status, JSON.stringify(withTemplate.completed.body)).toBe(
          200,
        );

        // Executor ignores ID tokens, so one whose `iss` names another tenant than its `tid`, or
        // than a tenant-specific issuer, never fails the sign-in.
        yield* common.mismatchTenantIssuer(true);
        for (const config of [{ discover: `${common.origin}/mcp` }, declared]) {
          const mismatched = yield* app.connect(config, entraClient);
          expect(mismatched.completed.status, JSON.stringify(mismatched.completed.body)).toBe(200);
        }
        yield* tenant.mismatchTenantIssuer(true);
        const pinned = yield* app.connect(
          {
            issuer: tenant.issuer,
            authorizationUrl: `${tenant.origin}/authorize`,
            tokenUrl: `${tenant.origin}/token`,
            scopes: ["openid", entraApiScope],
          },
          entraClient,
        );
        expect(pinned.completed.status, JSON.stringify(pinned.completed.body)).toBe(200);
      }),
    ),
  );

  it.effect(scenarios.oauthEntraRefreshTenant.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const app = yield* oauthApp;
        const common = yield* oauthInteropIssuer("entra-common");
        // Inside the host's refresh window, so each account's first tool call renews its grant.
        yield* common.exchangeExpiresIn(10);
        const discover = { discover: `${common.origin}/mcp` };

        // A refreshed ID token from the tenant the user signed in to renews the grant.
        const same = yield* app.connect(discover, entraClient, `${common.origin}/resource`);
        expect(same.completed.status, JSON.stringify(same.completed.body)).toBe(200);
        const renewed = yield* app.read(same.app, same.profile);
        expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
        expect(yield* body(Echo, renewed)).toMatchObject({ refreshed: true });
        expect((yield* common.metrics).refreshes).toEqual([{ tenant: entraTenant, issued: true }]);

        // Renewals never compare ID tokens: one whose `tid` and `iss` both name another tenant
        // still renews the grant, and the renewed access token is used from then on.
        yield* common.refreshAsTenant(otherTenant);
        const switched = yield* app.connect(discover, entraClient, `${common.origin}/resource`);
        expect(switched.completed.status, JSON.stringify(switched.completed.body)).toBe(200);
        const switchedRead = yield* app.read(switched.app, switched.profile);
        expect((yield* common.metrics).refreshes).toEqual([
          { tenant: entraTenant, issued: true },
          { tenant: otherTenant, issued: true },
        ]);
        expect(switchedRead.status, JSON.stringify(switchedRead.body)).toBe(200);
        expect(yield* body(Echo, switchedRead)).toMatchObject({ refreshed: true });
        const again = yield* app.read(switched.app, switched.profile);
        expect(again.status, JSON.stringify(again.body)).toBe(200);
        expect(yield* body(Echo, again)).toMatchObject({ refreshed: true });
        expect((yield* common.metrics).refreshes).toHaveLength(2);
      }),
    ),
  );

  it.effect(scenarios.oauthDiscoveryLocations.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const app = yield* oauthApp;
        for (const [service, requested] of [
          // Apple redirects the RFC 8414 location; its OpenID configuration is at the origin.
          [
            "apple",
            ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"],
          ],
          // An issuer with a path: MCP's order is RFC 8414 and then OpenID configuration with
          // the path inserted, then OpenID configuration appended. Atlassian refuses the first
          // with 401 and publishes at the last.
          [
            "atlassian",
            [
              "/.well-known/oauth-authorization-server/oauth",
              "/.well-known/openid-configuration/oauth",
              "/oauth/.well-known/openid-configuration",
            ],
          ],
          [
            "openid-inserted",
            [
              "/.well-known/oauth-authorization-server/oauth",
              "/.well-known/openid-configuration/oauth",
            ],
          ],
        ] as const) {
          const issuer = yield* oauthInteropIssuer(service);
          const signIn = yield* app.connect({ discover: `${issuer.origin}/mcp` });
          expect(
            signIn.completed.status,
            `${service}: ${JSON.stringify(signIn.completed.body)}`,
          ).toBe(200);
          const metrics = yield* issuer.metrics;
          expect(metrics.discoveryRequests, service).toEqual(requested);
          // Servers without Microsoft's scope-selected audience still receive the resource.
          expect(signIn.authorizationUrl.searchParams.get("resource"), service).toBe(
            `${issuer.origin}/mcp`,
          );
          expect(metrics.tokenRequests, service).toEqual([
            { resource: `${issuer.origin}/mcp`, issued: true },
          ]);
          // A server that advertises refresh tokens is still asked for them.
          expect(metrics.registrations, service).toEqual([
            { grantTypes: ["authorization_code", "refresh_token"], accepted: true },
          ]);
        }
      }),
    ),
  );

  it.effect(scenarios.oauthRegistrationInterop.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const app = yield* oauthApp;

        // Singular advertises only authorization_code and refuses a request for refresh tokens.
        const singular = yield* oauthInteropIssuer("singular");
        const signIn = yield* app.connect({ discover: `${singular.origin}/mcp` });
        expect(signIn.completed.status, JSON.stringify(signIn.completed.body)).toBe(200);
        expect((yield* singular.metrics).registrations).toEqual([
          { grantTypes: ["authorization_code"], accepted: true },
        ]);

        // Cloudflare Access refuses a callback outside its allowed redirect URIs.
        const access = yield* oauthInteropIssuer("cloudflare-access");
        const { started } = yield* app.start({ discover: `${access.origin}/mcp` });
        expect(started.status, JSON.stringify(started.body)).toBe(422);
        const failure = yield* body(Failure, started);
        expect(failure).toMatchObject({
          _tag: "OAuthSetupFailed",
          reason: "client_metadata_rejected",
        });
        expect(failure.message).toContain("allowed redirect URIs");
        expect(new URL(failure.callbackUrl ?? "http://missing").pathname).toBe(
          "/api/oauth/callback",
        );
        // Its own words are shown as its response, apart from the curated explanation.
        expect(failure.serviceError).toEqual({
          error: "invalid_client_metadata",
          description: "PRIVATE_PROVIDER_ERROR",
        });
        expect(JSON.stringify([failure.message, failure.recovery])).not.toContain(
          "PRIVATE_PROVIDER_ERROR",
        );
        expect((yield* access.metrics).registrations).toEqual([
          { grantTypes: ["authorization_code", "refresh_token"], accepted: false },
        ]);
      }),
    ),
  );

  it.effect(scenarios.oauthAhrefs.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const app = yield* oauthApp;
        const ahrefs = yield* oauthInteropIssuer("ahrefs");
        const signIn = yield* app.connect(
          { discover: `${ahrefs.origin}/mcp` },
          undefined,
          `${ahrefs.origin}/resource`,
        );
        expect(signIn.completed.status, JSON.stringify(signIn.completed.body)).toBe(200);
        const metrics = yield* ahrefs.metrics;
        // Ahrefs refuses `application/x-www-form-urlencoded;charset=UTF-8`.
        expect(metrics.tokenContentTypes).toEqual(["application/x-www-form-urlencoded"]);
        // The trailing-slash resource is sent as published.
        expect(signIn.authorizationUrl.searchParams.get("resource")).toBe(`${ahrefs.origin}/`);
        expect(metrics.tokenRequests).toEqual([{ resource: `${ahrefs.origin}/`, issued: true }]);
        expect(metrics.registrations).toEqual([
          { grantTypes: ["authorization_code"], accepted: true },
        ]);
        const read = yield* app.read(signIn.app, signIn.profile);
        expect(read.status, JSON.stringify(read.body)).toBe(200);
        expect(yield* body(Echo, read)).toEqual({
          refreshed: false,
          authorization: "Bearer synthetic-access-token",
        });
      }),
    ),
  );
});
