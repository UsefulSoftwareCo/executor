// Cloud: reproduce the production "StorageError: WorkOS Vault secret write
// failed" Sentry events (NODE-CLOUDFLARE-WORKERS-52/53/4T) at the real
// upstream — faults armed on the WorkOS emulator's Vault KV PUT, the same
// emulator the product's real WorkOS SDK talks to. No product code touched.
//
// The production chain, staged here end-to-end:
//   1. An OAuth connection's access token expires (per-client TTL of 1s via
//      the emulator's DCR `access_token_ttl_seconds` extension, well inside
//      the 60s refresh skew).
//   2. A health check resolves the connection → the refresh path runs. Vault
//      writes go through read → `PUT /vault/v1/kv/:id`; the PUT fails (in
//      prod: 409 version conflict, an OAuth-shaped 400, or an HTML error
//      page; here: the armed 400 with `error`/`error_description`, the exact
//      shape the WorkOS SDK maps to OauthException — Sentry issue -53).
//   3. The write failure surfaces as `StorageError: WorkOS Vault secret write
//      failed` → the health endpoint answers a typed InternalError (the 500
//      Sentry records). Crucially it must fail BEFORE the refresh-token grant
//      (the AS rotates the single-use token; consuming it with an unwritable
//      store loses the rotated copy forever).
//
// The second scenario pins the DAMAGE the surface error used to hide: when
// the vault write failed AFTER the refresh token was consumed and rotated,
// the rotated token was lost and the stored one already revoked — the next
// refresh got invalid_grant and the connection demanded a re-auth over a
// storage blip. The fix gates the grant on a proof-of-writability rewrite of
// the stored refresh token, so a vault outage fails BEFORE the single-use
// token is spent and the connection recovers with the vault.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { composePluginApi } from "@executor-js/api/server";
import { connectEmulator } from "@executor-js/emulate";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";
import type { Target as TargetShape } from "../src/target";
import { WORKOS_EMULATOR_PORT } from "../targets/cloud";

const api = composePluginApi([openApiHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

const TEMPLATE = AuthTemplateSlug.make("oauth2");
const CONNECTION = ConnectionName.make("main");
const WORKOS_EMULATOR_URL = `http://127.0.0.1:${WORKOS_EMULATOR_PORT}`;

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

/** Minimal OpenAPI spec with a single GET /ping — never contacted (the
 *  integration declares no health-check spec, so checkHealth takes the
 *  credential-resolution path, which is where the vault write lives). */
const pingSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Ping API", version: "1.0.0" },
  paths: {
    "/ping": {
      get: { operationId: "ping", summary: "Ping", responses: { "200": { description: "pong" } } },
    },
  },
});

// The vault-write outage: `PUT /vault/v1/kv/:id` (the WorkOS SDK's
// updateObject) starts answering with the OAuth-shaped 400 the production
// events carry ("OauthException: Error: Invalid request parameters" — the
// SDK maps any non-{401,404,409,422,429} status whose body has
// `error`/`error_description` to OauthException). Reads (GET) and creates
// (POST) stay healthy: only the update leg fails, as in production.
// `times` bounds the blast radius; the finalizer clears whatever remains.
const VAULT_UPDATE_FAULT = {
  match: { method: "PUT", pathPattern: "/vault/v1/kv/*" },
  response: {
    status: 400,
    body: {
      code: "invalid_request",
      message: "Invalid request parameters",
      error: "Invalid request parameters",
      error_description: "Invalid request parameters",
    },
  },
  times: 8,
} as const;

/** DCR-register an OAuth client directly on the WorkOS emulator with a 1s
 *  access-token TTL (per-client, so the emulator's default — which the
 *  product's own AuthKit sessions depend on — is untouched). 1s is inside
 *  executor's 60s refresh skew: the first resolve after connect refreshes. */
const registerShortLivedOAuthClient = (redirectUri: string) =>
  Effect.promise(async () => {
    const response = await fetch(`${WORKOS_EMULATOR_URL}/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "vault-write-outage-e2e",
        redirect_uris: [redirectUri],
        access_token_ttl_seconds: 1,
      }),
    });
    if (response.status !== 201) {
      throw new Error(`WorkOS emulator DCR failed: ${response.status}`);
    }
    const body = (await response.json()) as { readonly client_id: string };
    return body.client_id;
  });

/** Complete the emulator's authorize hop headlessly: `login_hint` makes the
 *  authorize endpoint 302 straight back with a code (no consent page). */
const completeConsent = (authorizationUrl: string, email: string) =>
  Effect.promise(async () => {
    const url = new URL(authorizationUrl);
    url.searchParams.set("login_hint", email);
    const callback = await fetch(url, { redirect: "manual" });
    const location = callback.headers.get("location");
    if (callback.status !== 302 || !location) {
      throw new Error(`WorkOS emulator authorize did not redirect: ${callback.status}`);
    }
    const code = new URL(location).searchParams.get("code");
    if (!code) throw new Error("WorkOS emulator callback did not include a code");
    return code;
  });

/** Register a fresh integration + OAuth app against the emulator's generic
 *  authorize/token endpoints and connect it. `offline_access` mints a
 *  refresh token, so the expired-token path refreshes instead of re-authing. */
const connectExpiringOAuthConnection = (input: {
  readonly client: Client;
  readonly target: TargetShape;
  readonly integration: IntegrationSlug;
  readonly oauthClient: OAuthClientSlug;
}) =>
  Effect.gen(function* () {
    const redirectUri = new URL("/api/oauth/callback", input.target.baseUrl).toString();

    yield* input.client.openapi.addSpec({
      payload: {
        spec: { kind: "blob", value: pingSpec },
        slug: input.integration,
        baseUrl: "http://127.0.0.1:59999", // never contacted
        authenticationTemplate: [
          {
            slug: "oauth2",
            kind: "oauth2",
            authorizationUrl: `${WORKOS_EMULATOR_URL}/oauth2/authorize`,
            tokenUrl: `${WORKOS_EMULATOR_URL}/oauth2/token`,
            scopes: ["offline_access"],
          },
        ],
      },
    });

    const clientId = yield* registerShortLivedOAuthClient(redirectUri);
    yield* input.client.oauth.createClient({
      payload: {
        owner: "org",
        slug: input.oauthClient,
        grant: "authorization_code",
        authorizationUrl: `${WORKOS_EMULATOR_URL}/oauth2/authorize`,
        tokenUrl: `${WORKOS_EMULATOR_URL}/oauth2/token`,
        clientId,
        // The emulator's DCR clients are public (auth method "none"); the
        // secret is carried but never validated.
        clientSecret: "unused",
        originIntegration: input.integration,
      },
    });

    const started = yield* input.client.oauth.start({
      payload: {
        client: input.oauthClient,
        clientOwner: "org",
        owner: "org",
        name: CONNECTION,
        integration: input.integration,
        template: TEMPLATE,
        redirectUri,
      },
    });
    expect(started.status, "OAuth starts with an emulator redirect").toBe("redirect");
    if (started.status !== "redirect") return yield* Effect.die("OAuth unexpectedly connected");

    const code = yield* completeConsent(started.authorizationUrl, "vault-outage@example.com");
    const completed = yield* input.client.oauth.complete({
      payload: { state: started.state, code },
    });
    expect(completed.integration, "OAuth completion creates the connection").toBe(
      input.integration,
    );
  });

const removeEverything = (input: {
  readonly client: Client;
  readonly integration: IntegrationSlug;
  readonly oauthClient: OAuthClientSlug;
}) =>
  Effect.gen(function* () {
    yield* input.client.connections
      .remove({ params: { owner: "org", integration: input.integration, name: CONNECTION } })
      .pipe(Effect.ignore);
    yield* input.client.oauth
      .removeClient({ params: { slug: input.oauthClient }, payload: { owner: "org" } })
      .pipe(Effect.ignore);
    yield* input.client.openapi
      .removeSpec({ params: { slug: input.integration } })
      .pipe(Effect.ignore);
  });

const checkHealth = (client: Client, integration: IntegrationSlug) =>
  client.connections.checkHealth({
    params: { owner: "org", integration, name: CONNECTION },
    query: { ifStaleMs: 0 },
  });

scenario(
  "Vault · a vault write failure during token refresh surfaces as the internal storage error",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(api, identity);
    const integration = IntegrationSlug.make(unique("vault_outage"));
    const oauthClient = OAuthClientSlug.make(unique("vault_outage_app"));
    const workos = yield* Effect.promise(() => connectEmulator({ baseUrl: WORKOS_EMULATOR_URL }));

    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* connectExpiringOAuthConnection({ client, target, integration, oauthClient });

        // The 1s token is already inside the refresh skew. Break the vault's
        // update leg, then run the health check that resolves the credential.
        yield* Effect.promise(() => workos.faults.arm(VAULT_UPDATE_FAULT));

        const error = yield* checkHealth(client, integration).pipe(Effect.flip);
        expect(
          (error as { _tag?: string })._tag,
          "the failed vault write surfaces as the typed internal error (the prod 500)",
        ).toBe("InternalError");

        // The proof this is the production mechanism and not an incidental
        // failure: the product hit the injected fault on the vault update leg.
        const ledger = yield* Effect.promise(() => workos.ledger.list(200));
        const faultedPut = ledger.find((entry) => entry.faulted === true && entry.method === "PUT");
        expect(faultedPut?.path, "the failure came from the injected vault-update fault").toMatch(
          /\/vault\/v1\/kv\//,
        );
        // The crash-safety contract: the write-gate fails BEFORE the refresh
        // grant, so the single-use refresh token is never consumed while the
        // store cannot persist its rotated successor.
        const refreshGrant = ledger.find(
          (entry) =>
            entry.path.endsWith("/oauth2/token") &&
            JSON.stringify(entry.request.body ?? "").includes("refresh_token"),
        );
        expect(
          refreshGrant,
          "no refresh grant is issued while the vault cannot persist the rotated token",
        ).toBeUndefined();
      }),
      Effect.gen(function* () {
        yield* Effect.promise(() => workos.faults.clear());
        yield* removeEverything({ client, integration, oauthClient });
      }),
    );
  }),
);

scenario(
  "Vault · a transient vault write outage does not invalidate the connection once the vault recovers",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(api, identity);
    const integration = IntegrationSlug.make(unique("vault_recover"));
    const oauthClient = OAuthClientSlug.make(unique("vault_recover_app"));
    const workos = yield* Effect.promise(() => connectEmulator({ baseUrl: WORKOS_EMULATOR_URL }));

    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* connectExpiringOAuthConnection({ client, target, integration, oauthClient });

        // One health check during the outage: the refresh grant consumes and
        // ROTATES the single-use refresh token, then the vault write of the
        // rotated pair fails.
        yield* Effect.promise(() => workos.faults.arm(VAULT_UPDATE_FAULT));
        yield* checkHealth(client, integration).pipe(Effect.flip);
        yield* Effect.promise(() => workos.faults.clear());

        // The vault has recovered. A transient storage blip must not cost the
        // user their grant: the connection has a live authorization at the AS
        // and must come back healthy without a re-auth. Today it cannot — the
        // rotated refresh token was never persisted, so the stored (revoked)
        // one is replayed, the AS answers invalid_grant, and the connection
        // reads "expired" until a human reconnects. This is the real damage
        // behind the prod Sentry events.
        const health = yield* checkHealth(client, integration);
        expect(
          health.status,
          `a transient vault outage must not permanently invalidate the connection: ${JSON.stringify(health)}`,
        ).toBe("healthy");
      }),
      Effect.gen(function* () {
        yield* Effect.promise(() => workos.faults.clear());
        yield* removeEverything({ client, integration, oauthClient });
      }),
    );
  }),
);
