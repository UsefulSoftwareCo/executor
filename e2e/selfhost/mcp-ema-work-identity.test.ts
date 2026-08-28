// Selfhost-only: the WORK IDENTITY half of MCP Enterprise-Managed Authorization,
// driven end to end against the same two emulators as
// `mcp-enterprise-managed-auth.test.ts`.
//
// That scenario proves the ID-JAG chain works when someone hands executor an
// identity assertion. This one proves the product can GET one — which is the
// part a browser cannot do, because the identity provider's client secret is
// server-side. The claim under test, in order:
//
//   1. the user links their enterprise identity ONCE, through a real OIDC
//      authorization-code flow that executor builds and redeems itself, and
//   2. what executor takes custody of is the IdP's REFRESH token
//      (draft-ietf-oauth-identity-assertion-authz-grant §4.5) — the durable
//      subject, not the ~1h ID token, and
//   3. the enterprise-managed connect then carries NO subjectToken at all, and
//      still connects with no consent step, and a tool call rides the result.
//
// Both emulators' request ledgers are the proof: executor's own responses only
// show what executor believes, while the ledgers show the upstream calls it
// actually made — the sign-in, the exchange, the redemption, and the tool call.
//
// NOT covered here, deliberately: renewal after the ID token would have expired.
// The Okta emulator's token lifetimes are compiled-in constants (access/ID token
// 3600s, ID-JAG 300s) with no seed knob to compress them, so a real
// past-expiry renewal is not expressible against it inside a test's budget. That
// claim is proven hermetically instead, in the SDK's `oauth-work-identity.test.ts`
// ("renews after the ID token that started the link would have died"), by
// revoking everything the sign-in issued that expires and showing renewal
// continues — which is precisely the state the hour brings.
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

import { assert, expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { createEmulator, type Emulator, type LedgerEntry } from "@executor-js/emulate";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);

const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const REFRESH_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:refresh_token";

// The Okta emulator's default seed: one user on the `default` authorization
// server. The OAuth client is minted per run so nothing depends on the sample
// client's id.
const OKTA_USER = "testuser@okta.local";

// What the MCP emulator advertises in both its RFC 9728 and RFC 8414 metadata.
const SERVER_SCOPES = ["repo", "read:user"] as const;

const freshSlug = (prefix: string): string => `${prefix}_${randomBytes(4).toString("hex")}`;

const availablePort = Effect.callback<number>((resume) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const port = typeof address === "object" && address ? address.port : 0;
    probe.close(() => {
      resume(Effect.succeed(port));
    });
  });
});

/** A locally spawned emulator on an OS-assigned port, closed with the scope —
 *  local rather than hosted so the behavior asserted is the version this
 *  checkout pins, not whatever was last deployed. */
const emulator = (service: "okta" | "mcp") =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const port = yield* availablePort;
      return yield* Effect.promise(() => createEmulator({ service, port }));
    }),
    (instance: Emulator) => Effect.promise(() => instance.close()).pipe(Effect.ignore),
  );

const requireString = (value: string | undefined | null, what: string): string => {
  if (!value) throw new Error(`emulator returned no ${what}`);
  return value;
};

/** Sign in at the identity provider against the authorization URL EXECUTOR
 *  built, and hand back the code its callback would have received.
 *
 *  This is the one step a headless scenario has to stand in for, and it stands
 *  in for the browser only: every parameter posted below is read straight off
 *  executor's own authorize URL, so the client id, redirect URI, scopes and PKCE
 *  challenge under test are the ones the product chose, not ones invented here. */
const signInAt = (authorizationUrl: string) =>
  Effect.promise(async (): Promise<string> => {
    const authorize = new URL(authorizationUrl);
    const callbackUrl = new URL(authorize);
    callbackUrl.pathname = `${authorize.pathname}/callback`;
    callbackUrl.search = "";

    const body = new URLSearchParams({ user_ref: OKTA_USER });
    for (const key of [
      "redirect_uri",
      "scope",
      "state",
      "nonce",
      "client_id",
      "code_challenge",
      "code_challenge_method",
    ]) {
      const value = authorize.searchParams.get(key);
      if (value !== null) body.set(key, value);
    }
    body.set("response_mode", "query");

    const response = await fetch(callbackUrl.toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body,
    });
    if (response.status !== 302) {
      throw new Error(
        `IdP authorize answered ${response.status}, expected a 302: ${await response.text()}`,
      );
    }
    const location = requireString(response.headers.get("location"), "authorize redirect");
    return requireString(new URL(location).searchParams.get("code"), "authorization code");
  });

const ledger = (instance: Emulator) => Effect.promise(() => instance.ledger.list());

const entryFor = (entries: readonly LedgerEntry[], operationId: string): LedgerEntry | undefined =>
  entries.find((entry) => entry.operationId === operationId);

const callGetMeCode = (slug: string, connection: string) => `
const result = await tools.${slug}.org.${connection}.get_me({});
return { ok: result.ok, payload: result.ok ? result.data : result.error };
`;

type SandboxToolOutcome = {
  readonly ok: boolean;
  readonly payload?: { readonly login?: string };
};

scenario(
  "MCP enterprise-managed authorization · linking a work identity once lets a connect carry no assertion at all",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);

      const okta = yield* emulator("okta");
      const mcp = yield* emulator("mcp");
      const mcpEndpoint = `${mcp.url}/mcp`;

      // The link redirects the user's browser back to EXECUTOR's own OAuth
      // callback — the same one every interactive connect uses. Registering it
      // with the identity provider is what an enterprise administrator does
      // once; the emulator matches redirect URIs exactly, so this scenario fails
      // loudly if executor ever asks for a different one.
      const executorCallback = new URL("/api/oauth/callback", target.baseUrl).toString();

      // One client identity across BOTH registrations — the same client the user
      // signs in to, presenting itself to the Resource Authorization Server
      // (draft §5 client continuity).
      const credential = yield* Effect.promise(() =>
        okta.credentials.mint({
          type: "oauth-authorization-code",
          name: "Executor E2E work identity client",
          redirect_uris: [executorCallback],
        }),
      );
      const clientId = requireString(credential.client_id, "IdP client_id");
      const clientSecret = requireString(credential.client_secret, "IdP client_secret");
      const idpTokenUrl = requireString(credential.token_url, "IdP token endpoint");
      const idpAuthorizationUrl = requireString(credential.authorization_url, "IdP authorize URL");

      const integration = IntegrationSlug.make(freshSlug("mcp_wid"));
      const idpClient = OAuthClientSlug.make(freshSlug("wid_idp"));
      const serverClient = OAuthClientSlug.make(freshSlug("wid_server"));
      const template = AuthTemplateSlug.make("oauth2");
      const workIdentityRef = {
        owner: "org",
        idpClient,
        idpClientOwner: "org",
      } as const;

      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "Enterprise-managed MCP (emulate)",
          endpoint: mcpEndpoint,
          slug: String(integration),
          authenticationTemplate: [
            {
              kind: "oauth2",
              enterpriseIdentityProvider: { client: idpClient, clientOwner: "org" },
            },
          ],
        },
      });

      yield* Effect.ensuring(
        Effect.gen(function* () {
          // The client's registration AT THE IdP. Unlike the assertion-carrying
          // scenario, this one is RUN as a flow: the link is its authorization-
          // code flow, redeemed server-side with this secret.
          yield* client.oauth.createClient({
            payload: {
              owner: "org",
              slug: idpClient,
              authorizationUrl: idpAuthorizationUrl,
              tokenUrl: idpTokenUrl,
              grant: "authorization_code",
              clientId,
              clientSecret,
            },
          });
          // The client's registration AT THE RESOURCE AUTHORIZATION SERVER.
          yield* client.oauth.createClient({
            payload: {
              owner: "org",
              slug: serverClient,
              authorizationUrl: `${mcp.url}/authorize`,
              tokenUrl: `${mcp.url}/token`,
              grant: "id_jag",
              clientId,
              clientSecret,
              resource: mcpEndpoint,
            },
          });

          // ---------------------------------------------------------------
          // Phase 1 — nothing is linked, so an assertion-less connect asks for
          // a LINK. This is the state every user starts in, and the field below
          // is what a console branches on to know what to offer.
          // ---------------------------------------------------------------
          expect(
            (yield* client.oauth.workIdentityStatus({ query: workIdentityRef })).status,
            "no work identity is held before the user links one",
          ).toBe("unlinked");

          const unlinked = yield* client.oauth
            .start({
              payload: {
                owner: "org",
                client: serverClient,
                clientOwner: "org",
                name: ConnectionName.make("premature"),
                integration,
                template,
                enterprise: { idpClient, idpClientOwner: "org" },
              },
            })
            .pipe(Effect.flip);
          assert(
            unlinked._tag === "OAuthStartError",
            "an unlinked user is a start failure, not a transport or decoding fault",
          );
          expect(
            unlinked.workIdentityLinkRequired,
            "the remedy travels as a FIELD — a console cannot decide from a sentence whether to open the link flow, retry, or offer per-server consent",
          ).toBe(true);

          // ---------------------------------------------------------------
          // Phase 2 — the link. A real OIDC authorization-code flow, built by
          // executor and redeemed by executor with the IdP app's secret.
          // ---------------------------------------------------------------
          const startedLink = yield* client.oauth.startWorkIdentityLink({
            payload: workIdentityRef,
          });
          const authorize = new URL(startedLink.authorizationUrl);
          expect(
            authorize.searchParams.get("redirect_uri"),
            "the link comes back to executor's own OAuth callback, so an enterprise registers one redirect URI and not two",
          ).toBe(executorCallback);
          expect(
            authorize.searchParams.get("scope")?.split(" ").sort(),
            "`openid` is where the account claims come from and `offline_access` is where the durable refresh token comes from",
          ).toEqual(["offline_access", "openid"]);
          expect(authorize.searchParams.get("client_id")).toBe(clientId);

          const code = yield* signInAt(startedLink.authorizationUrl);
          const linked = yield* client.oauth.completeWorkIdentityLink({
            payload: { state: startedLink.state, code },
          });

          assert(linked.status === "linked", "the completion reports the account that was linked");
          expect(
            linked.subjectTokenType,
            "§4.5: custody is the IdP's REFRESH token. An ID token here would strand every managed connection about an hour after it was made",
          ).toBe(REFRESH_TOKEN_TYPE);
          expect(
            linked.expiresAt,
            "and a refresh token carries no client-visible deadline, which is the property being bought",
          ).toBeNull();
          expect(linked.label, "the console can say WHO is linked").toContain("testuser");

          expect(
            (yield* client.oauth.workIdentityStatus({ query: workIdentityRef })).status,
            "and the status a console polls agrees with the completion",
          ).toBe("linked");

          // ---------------------------------------------------------------
          // Phase 3 — the headline: connect with NO assertion on the request.
          // ---------------------------------------------------------------
          const connected = yield* client.oauth.start({
            payload: {
              owner: "org",
              client: serverClient,
              clientOwner: "org",
              name: ConnectionName.make("main"),
              integration,
              template,
              // No `subjectToken`. Nothing in this payload could authorize
              // anything; the held identity is resolved server-side.
              enterprise: { idpClient, idpClientOwner: "org" },
            },
          });

          assert(
            connected.status === "connected",
            "a linked user connects an enterprise-managed server with neither an assertion in hand nor a consent screen",
          );
          expect(
            connected.connection.oauthScope?.split(" ").sort(),
            "the connection carries the scopes the IdP granted",
          ).toEqual([...SERVER_SCOPES].sort());

          const executed = yield* client.executions.execute({
            payload: { code: callGetMeCode(String(integration), "main"), autoApprove: true },
          });
          expect(executed.status, "the tool call completed").toBe("completed");
          const outcome = JSON.parse(executed.text) as SandboxToolOutcome;
          expect(outcome.ok, executed.text).toBe(true);

          // --- Ledger: the identity provider saw a real sign-in. -----------
          const oktaEntries = yield* ledger(okta);
          expect(
            oktaEntries.some((entry) => entry.path.endsWith("/v1/authorize/callback")),
            "the link ran an actual OIDC sign-in at the identity provider",
          ).toBe(true);
          const codeExchange = oktaEntries.find(
            (entry) =>
              entry.path.endsWith("/v1/token") &&
              (entry.request.body as { readonly grant_type?: string } | undefined)?.grant_type ===
                "authorization_code",
          );
          expect(
            codeExchange?.response.status,
            "and executor — not the browser — redeemed the code, which is the only place the IdP app's secret may be used",
          ).toBe(200);
          expect(
            (codeExchange?.request.body as { readonly client_id?: string } | undefined)?.client_id,
            "as the registered enterprise client",
          ).toBe(clientId);

          // --- Ledger: the connect exchanged that custody for an ID-JAG. ----
          const exchange = entryFor(oktaEntries, "okta.oauth.tokenExchange");
          expect(exchange, "executor ran an RFC 8693 exchange at the IdP").toBeTruthy();
          expect(exchange?.response.status).toBe(200);
          // `subject_token_type` is absent from the ledger: it redacts every
          // `*token*` field before recording. That the exchange presented the
          // REFRESH-token subject is asserted on the wire in the hermetic
          // protocol tests, and on the product surface by `subjectTokenType`
          // above — the ledger's job here is the routing fields.
          expect(
            exchange?.request.body,
            "the exchange names the MCP server's authorization server and resource",
          ).toMatchObject({
            grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
            audience: mcp.url,
            resource: mcpEndpoint,
            client_id: clientId,
            scope: SERVER_SCOPES.join(" "),
          });

          // --- Ledger: what executor did with the ID-JAG it got back. ------
          const mcpEntries = yield* ledger(mcp);
          const redemption = entryFor(mcpEntries, "mcp.oauth.jwtBearer");
          expect(
            redemption,
            "executor redeemed the ID-JAG at the resource authorization server",
          ).toBeTruthy();
          expect(redemption?.response.status).toBe(200);
          expect(redemption?.request.body).toMatchObject({
            grant_type: JWT_BEARER_GRANT_TYPE,
            client_id: clientId,
          });
          expect(
            mcpEntries.filter((entry) => entry.path === "/authorize"),
            "no interactive authorization request was ever made at the MCP server",
          ).toEqual([]);

          const toolCall = mcpEntries.find(
            (entry) => entry.path === "/mcp" && entry.method === "POST",
          );
          expect(
            toolCall?.identity.user,
            "the MCP server saw the enterprise user with the granted scopes",
          ).toMatchObject({ scopes: [...SERVER_SCOPES] });

          // ---------------------------------------------------------------
          // Phase 4 — unlinking is a fact about the IDENTITY. The connection is
          // untouched; a re-link is what revives it.
          // ---------------------------------------------------------------
          yield* client.oauth.unlinkWorkIdentity({ payload: workIdentityRef });
          expect((yield* client.oauth.workIdentityStatus({ query: workIdentityRef })).status).toBe(
            "unlinked",
          );
          const connections = yield* client.connections.list({ query: { integration } });
          expect(
            connections.map((connection) => String(connection.name)).sort(),
            "forgetting the identity removes no connection — the premature attempt minted none, and the real one survives",
          ).toEqual(["main"]);
        }),
        Effect.gen(function* () {
          yield* client.oauth.unlinkWorkIdentity({ payload: workIdentityRef }).pipe(Effect.ignore);
          yield* client.connections
            .remove({ params: { owner: "org", integration, name: ConnectionName.make("main") } })
            .pipe(Effect.ignore);
          yield* client.oauth
            .removeClient({ params: { slug: serverClient }, payload: { owner: "org" } })
            .pipe(Effect.ignore);
          yield* client.oauth
            .removeClient({ params: { slug: idpClient }, payload: { owner: "org" } })
            .pipe(Effect.ignore);
          yield* client.mcp.removeServer({ params: { slug: integration } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
