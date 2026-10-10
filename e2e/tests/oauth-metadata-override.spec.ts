/** Metadata overrides retain issuer checks; MCP challenge scopes avoid unnecessary OpenID. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { appsManifest } from "../support/apps-release.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const Redirect = Schema.Struct({ authorizationUrl: Schema.String });
const Setup = Schema.Struct({ scopes: Schema.Array(Schema.String) });
const Failure = Schema.Struct({ reason: Schema.String });

layer(HostedLive, { excludeTestServices: true })("OAuth metadata override", (it) => {
  it.effect(scenarios.oauthMetadataOverride.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          http = yield* HttpClient.HttpClient;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const metadataUrl = `${issuer.origin}/oauth/.well-known/openid-configuration`;
        const deploy = (name: string, config: object) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name,
              files: [
                {
                  path: "index.ts",
                  content: `import { defineApp, defineProvider, oauth2, query, object, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: oauth2(${JSON.stringify(config)}) } });
export default defineApp({ accounts: { service } }, async ({ accounts }) => ({ tools: router({
  read: query({ input: object({}) }, async ({ fetch }) => (await fetch(${JSON.stringify(`${issuer.origin}/resource`)}, { headers: { authorization: "Bearer " + accounts.service.fields.access_token } })).json()),
}) }));`,
                },
                appsManifest,
              ],
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(App, response);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });
        const setup = (app: typeof App.Type) =>
          api.request(
            actors.owner,
            "GET",
            `${prefix}/providers/${app.requirements.accounts.service.provider}/oauth/oauth/setup`,
          );
        const connect = (app: typeof App.Type) =>
          Effect.gen(function* () {
            const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
            const connection = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
                requirement: "service",
                profile: profile.id,
              }),
            );
            const start = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/start`,
              { method: "oauth", label: "Metadata account" },
            );
            expect(start.status, JSON.stringify(start.body)).toBe(200);
            const url = new URL((yield* body(Redirect, start)).authorizationUrl);
            const callback = yield* Effect.scoped(
              Effect.gen(function* () {
                const consent = yield* HttpClient.withScope(http).get(url.href);
                expect(consent.status).toBe(302);
                const location = consent.headers.location;
                if (location === undefined) return yield* Effect.die("Issuer omitted callback");
                return location;
              }),
            ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
            const completed = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/complete`,
              { callbackUrl: callback },
            );
            return { completed, url, profile };
          });

        // The resource advertises OpenID, but its root metadata omits signing algorithms. The
        // ES256 ID token is ignored, so the RS256 default for unlisted algorithms never applies.
        yield* issuer.configure({
          scopes: ["openid", "profile", "email", "read"],
          includeIdToken: true,
          refreshTokens: true,
          expiresIn: 1,
        });
        const automatic = yield* deploy("Root metadata", { discover: `${issuer.origin}/mcp` });
        const root = yield* connect(automatic);
        expect(root.url.searchParams.get("scope")).toBe("openid profile email read");
        expect(root.url.searchParams.has("nonce")).toBe(false);
        expect(root.completed.status, JSON.stringify(root.completed.body)).toBe(200);
        const rootAccount = yield* body(Resource, root.completed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${rootAccount.id}`)
            .pipe(Effect.orDie),
        );

        // An exact OIDC metadata location is used without changing the expected issuer.
        const overridden = yield* deploy("Explicit metadata", {
          discover: `${issuer.origin}/mcp`,
          authorizationServerMetadataUrl: metadataUrl,
        });
        const before = (yield* issuer.metrics).discoveryRequests.length;
        const connected = yield* connect(overridden);
        expect(connected.url.searchParams.get("scope")).toBe("openid profile email read");
        expect(connected.url.searchParams.has("nonce")).toBe(false);
        expect(connected.completed.status, JSON.stringify(connected.completed.body)).toBe(200);
        expect((yield* issuer.metrics).discoveryRequests.slice(before)).toContain(
          "/oauth/.well-known/openid-configuration",
        );
        expect((yield* issuer.metrics).discoveryRequests.slice(before)).not.toContain(
          "/.well-known/oauth-authorization-server",
        );
        const account = yield* body(Resource, connected.completed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
            .pipe(Effect.orDie),
        );
        expect(
          (yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/apps/${overridden.id}/profiles/${connected.profile.id}`,
          )).body,
        ).toMatchObject({ accounts: { service: account.id } });
        const executed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${overridden.id}/tools/call`,
          { profile: connected.profile.id, tool: "read", kind: "query", input: {} },
        );
        expect(executed.status, JSON.stringify(executed.body)).toBe(200);
        expect(yield* body(Schema.Struct({ refreshed: Schema.Boolean }), executed)).toEqual({
          refreshed: true,
        });
        expect((yield* issuer.metrics).refreshes).toBeGreaterThan(0);

        // Bad issuer, blocked address and missing explicit metadata never fall back to root metadata.
        yield* issuer.configure({ metadataOverrideIssuer: `${issuer.origin}/different` });
        const mismatch = yield* setup(overridden);
        expect(mismatch.status).toBe(422);
        expect((yield* body(Failure, mismatch)).reason).toBe("discovery_invalid");
        yield* issuer.configure({ metadataOverrideIssuer: null, metadataOverrideStatus: 404 });
        expect((yield* body(Failure, yield* setup(overridden))).reason).toBe("discovery_missing");
        // An ID token with a nonce Executor never sent is ignored like any other.
        yield* issuer.configure({ metadataOverrideStatus: 200, invalidNonce: true });
        const foreignNonce = yield* connect(overridden);
        expect(foreignNonce.completed.status, JSON.stringify(foreignNonce.completed.body)).toBe(
          200,
        );
        const foreignNonceAccount = yield* body(Resource, foreignNonce.completed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${foreignNonceAccount.id}`)
            .pipe(Effect.orDie),
        );
        const blocked = yield* deploy("Blocked metadata", {
          discover: `${issuer.origin}/mcp`,
          authorizationServerMetadataUrl: "http://blocked.internal:8081/metadata",
        });
        expect((yield* body(Failure, yield* setup(blocked))).reason).toBe("discovery_blocked");

        // A narrower resource challenge selects access-only scopes; authored scopes win over it.
        yield* issuer.configure({
          includeIdToken: false,
          invalidNonce: false,
          challengeScopes: ["read"],
          expiresIn: 3600,
        });
        expect((yield* body(Setup, yield* setup(automatic))).scopes).toEqual(["read"]);
        const scopeOnly = yield* deploy("Scope-only challenge", {
          discover: `${issuer.origin}/v1/mcp`,
        });
        expect((yield* body(Setup, yield* setup(scopeOnly))).scopes).toEqual(["read"]);
        const accessOnly = yield* connect(automatic);
        expect(accessOnly.url.searchParams.get("scope")).toBe("read");
        expect(accessOnly.url.searchParams.has("nonce")).toBe(false);
        expect(accessOnly.completed.status).toBe(200);
        const accessAccount = yield* body(Resource, accessOnly.completed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${accessAccount.id}`)
            .pipe(Effect.orDie),
        );
        const explicit = yield* deploy("Authored scopes", {
          discover: `${issuer.origin}/mcp`,
          scopes: ["read", "offline_access"],
        });
        expect((yield* body(Setup, yield* setup(explicit))).scopes).toEqual([
          "read",
          "offline_access",
        ]);
        const authored = yield* connect(explicit);
        expect(authored.url.searchParams.get("scope")).toBe("read offline_access");
        expect(authored.url.searchParams.has("nonce")).toBe(false);
        expect(authored.completed.status, JSON.stringify(authored.completed.body)).toBe(200);
        const authoredAccount = yield* body(Resource, authored.completed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${authoredAccount.id}`)
            .pipe(Effect.orDie),
        );
        yield* issuer.configure({ postChallenge: true });
        expect((yield* body(Setup, yield* setup(automatic))).scopes).toEqual(["read"]);

        // The advertised list never widens a challenge, even one inside it: the issuer grants
        // `read` or `admin:read`, but refuses the two together.
        yield* issuer.configure({
          postChallenge: false,
          scopes: ["read", "admin:read"],
          exclusiveScopes: ["read", "admin:read"],
        });
        expect((yield* body(Setup, yield* setup(automatic))).scopes).toEqual(["read"]);
        const challenged = yield* connect(automatic);
        expect(challenged.url.searchParams.get("scope")).toBe("read");
        expect(challenged.completed.status, JSON.stringify(challenged.completed.body)).toBe(200);
        const challengedAccount = yield* body(Resource, challenged.completed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${challengedAccount.id}`)
            .pipe(Effect.orDie),
        );
        // Wider access is the author's choice: declared scopes replace the challenge, and the
        // issuer's refusal of an incompatible set reaches the user as it is, never narrowed.
        const declared = yield* deploy("Declared wider scopes", {
          discover: `${issuer.origin}/mcp`,
          scopes: ["read", "admin:read"],
        });
        expect((yield* body(Setup, yield* setup(declared))).scopes).toEqual(["read", "admin:read"]);
        const refused = yield* connect(declared);
        expect(refused.url.searchParams.get("scope")).toBe("read admin:read");
        expect(refused.completed.status).toBe(400);
        expect((yield* body(Failure, refused.completed)).reason).toBe("invalid_scope");
        yield* issuer.configure({ exclusiveScopes: null });
        const widened = yield* connect(declared);
        expect(widened.url.searchParams.get("scope")).toBe("read admin:read");
        expect(widened.completed.status, JSON.stringify(widened.completed.body)).toBe(200);
        const widenedAccount = yield* body(Resource, widened.completed);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${widenedAccount.id}`)
            .pipe(Effect.orDie),
        );
        yield* issuer.configure({
          challengeScopes: null,
          scopes: ["openid", "profile", "email", "read"],
        });
        expect((yield* body(Setup, yield* setup(automatic))).scopes).toEqual([
          "openid",
          "profile",
          "email",
          "read",
        ]);
      }),
    ),
  );
});
