// Selfhost-only: MCP Enterprise-Managed Authorization (the ID-JAG grant
// profile of draft-ietf-oauth-identity-assertion-authz-grant) driven all the
// way through the product against TWO emulators.
//
//   Okta  — the enterprise identity provider. Runs the real OIDC single
//           sign-on that hands the host an ID token, mints ID-JAGs from it
//           over RFC 8693 token exchange, and enforces an administrator
//           policy table while doing so.
//   MCP   — the Resource Authorization Server AND the MCP server. Advertises
//           `urn:ietf:params:oauth:grant-profile:id-jag` in its RFC 8414
//           metadata, redeems ID-JAGs over RFC 7523 jwt-bearer, and serves the
//           tools behind the resulting access token.
//
// The claim under test is the whole point of the profile: a user who is
// already signed in to the enterprise IdP connects an MCP server with NO
// browser consent step, and the IdP — not the user, and not executor — decides
// whether that is allowed. So there are two phases against the same wiring:
//
//   1. empty policy table → `oauth.start` returns `connected` outright (never
//      `redirect`), and a tool call rides the minted token.
//   2. one DENY policy    → `oauth.start` FAILS as blocked-by-admin. Executor
//      must NOT quietly fall back to the interactive per-server OAuth flow,
//      because that would route the user straight around the control the
//      enterprise just exercised.
//
// Both emulators' request ledgers are the proof. Assertions on executor's own
// responses only show what executor believes; the ledgers show the upstream
// calls it actually made — and, for the denial, the ones it did NOT make.
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

import { expect } from "@effect/vitest";
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
const ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";

// The Okta emulator's default seed: one user on the `default` authorization
// server. The OAuth client is minted per run so nothing depends on the sample
// client's id.
const OKTA_USER = "testuser@okta.local";
const OKTA_AUTH_SERVER = "default";
// Where the IdP sends the SSO code. Nothing listens on it — the scenario reads
// the code straight off the 302, exactly as a host embedding this flow would
// after its own callback fired.
const SSO_REDIRECT_URI = "http://localhost:3000/callback";

// What the MCP emulator advertises in both its RFC 9728 and RFC 8414 metadata.
// The integration declares no scopes of its own, so executor discovers these
// at connect and asks the IdP for exactly them.
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

/** A locally spawned emulator on an OS-assigned port, closed with the scope.
 *  Local rather than hosted on purpose: this scenario asserts on behavior that
 *  shipped in `@executor-js/emulate` 0.14.0, and the npm package is the version
 *  this checkout pins — a hosted instance is whatever was last deployed. */
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

/** Single sign-on to the IdP, ending with the ID token the host holds on the
 *  user's behalf (EMA profile §3). This is the ONE step outside the product:
 *  the profile leaves "where the identity assertion comes from" to the host,
 *  and executor is handed the result on the connect request. */
const singleSignOn = (input: {
  readonly issuerBaseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
}) =>
  Effect.promise(async (): Promise<string> => {
    const authorize = await fetch(
      `${input.issuerBaseUrl}/oauth2/${OKTA_AUTH_SERVER}/v1/authorize/callback`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        redirect: "manual",
        body: new URLSearchParams({
          user_ref: OKTA_USER,
          redirect_uri: SSO_REDIRECT_URI,
          scope: "openid profile email",
          client_id: input.clientId,
          response_mode: "query",
          auth_server_id: OKTA_AUTH_SERVER,
        }),
      },
    );
    if (authorize.status !== 302) {
      throw new Error(`IdP authorize answered ${authorize.status}, expected a 302`);
    }
    const location = requireString(authorize.headers.get("location"), "authorize redirect");
    const code = requireString(new URL(location).searchParams.get("code"), "authorization code");

    const token = await fetch(`${input.issuerBaseUrl}/oauth2/${OKTA_AUTH_SERVER}/v1/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: SSO_REDIRECT_URI,
        client_id: input.clientId,
        client_secret: input.clientSecret,
      }),
    });
    if (!token.ok) throw new Error(`IdP token endpoint answered ${token.status}`);
    const body = (await token.json()) as { readonly id_token?: string };
    return requireString(body.id_token, "id_token");
  });

const ledger = (instance: Emulator) => Effect.promise(() => instance.ledger.list());

const entryFor = (entries: readonly LedgerEntry[], operationId: string): LedgerEntry | undefined =>
  entries.find((entry) => entry.operationId === operationId);

// Sandbox code for the agent path: one addressed MCP tool call, with the
// ToolResult envelope returned as a value (tool failures are values here).
const callGetMeCode = (slug: string, connection: string) => `
const result = await tools.${slug}.org.${connection}.get_me({});
return { ok: result.ok, payload: result.ok ? result.data : result.error };
`;

type SandboxToolOutcome = {
  readonly ok: boolean;
  readonly payload?: { readonly login?: string };
};

scenario(
  "MCP enterprise-managed authorization · an Okta ID-JAG connects and calls an MCP server with no consent step, and admin policy blocks it",
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

      // One client identity across BOTH registrations — the same client the
      // user signed in to, presenting itself to the Resource Authorization
      // Server (draft §5 client continuity: the ID-JAG's `client_id` claim
      // names it, and the redemption authenticates as it).
      const credential = yield* Effect.promise(() =>
        okta.credentials.mint({
          type: "oauth-authorization-code",
          name: "Executor E2E enterprise client",
          redirect_uris: [SSO_REDIRECT_URI],
        }),
      );
      const clientId = requireString(credential.client_id, "IdP client_id");
      const clientSecret = requireString(credential.client_secret, "IdP client_secret");
      const idpTokenUrl = requireString(credential.token_url, "IdP token endpoint");
      const idpAuthorizationUrl = requireString(credential.authorization_url, "IdP authorize URL");

      const subjectToken = yield* singleSignOn({
        issuerBaseUrl: okta.url,
        clientId,
        clientSecret,
      });

      const integration = IntegrationSlug.make(freshSlug("mcp_ema"));
      const idpClient = OAuthClientSlug.make(freshSlug("ema_idp"));
      const serverClient = OAuthClientSlug.make(freshSlug("ema_server"));
      const template = AuthTemplateSlug.make("oauth2");

      // The MCP server, declaring which registered app plays its enterprise
      // IdP. That declaration is the ONLY opt-in: the connect path still has
      // to see the grant profile in the server's own metadata.
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
          // The client's registration AT THE IdP. Never run as a flow — it
          // exists so the token exchange can authenticate as this client.
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
          // `id_jag` is what puts the connect path on the enterprise-managed
          // branch; `resource` is the RFC 9728 identifier discovery starts from.
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

          // The catalog carries the pointer through to the client, which is
          // how a real console knows WHICH app to name on the connect request.
          // Everything below drives off the projected descriptor, not the
          // local variable, so a broken projection fails this scenario.
          const catalog = yield* client.integrations.get({ params: { slug: integration } });
          const declared = catalog.authMethods.find((method) => method.kind === "oauth");
          expect(
            declared?.oauth?.enterpriseIdentityProvider,
            "the catalog names the enterprise identity provider for this server",
          ).toEqual({ client: String(idpClient), clientOwner: "org" });
          expect(
            declared?.oauth?.supportsDynamicRegistration,
            "declaring an IdP leaves the interactive flow advertised",
          ).toBe(true);
          const enterprise = declared?.oauth?.enterpriseIdentityProvider;
          if (!enterprise) return;

          // ---------------------------------------------------------------
          // Phase 1 — empty policy table: the IdP authorizes the exchange.
          // ---------------------------------------------------------------
          const connected = yield* client.oauth.start({
            payload: {
              owner: "org",
              client: serverClient,
              clientOwner: "org",
              name: ConnectionName.make("main"),
              integration,
              template,
              enterprise: {
                idpClient: enterprise.client,
                idpClientOwner: enterprise.clientOwner,
                subjectToken,
                subjectTokenType: ID_TOKEN_TYPE,
              },
            },
          });

          // The headline: connected outright. A `redirect` here would mean the
          // user was sent through per-server consent after all.
          expect(connected.status, "the enterprise grant connects with no authorize redirect").toBe(
            "connected",
          );
          if (connected.status !== "connected") return;
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

          // --- Ledger: what executor actually asked the IdP for. -----------
          const oktaEntries = yield* ledger(okta);
          const exchange = entryFor(oktaEntries, "okta.oauth.tokenExchange");
          expect(exchange, "executor ran an RFC 8693 exchange at the IdP").toBeTruthy();
          expect(exchange?.response.status).toBe(200);
          // `requested_token_type` / `subject_token_type` are absent here
          // because the ledger redacts every `*token*` field before recording
          // it — the assertion that they carry the id-jag and id_token URNs
          // belongs to the hermetic protocol tests, which read the wire.
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
            "no interactive authorization request was ever made",
          ).toEqual([]);

          // --- Ledger: the tool call rode the token the chain minted. ------
          const toolCall = mcpEntries.find(
            (entry) => entry.path === "/mcp" && entry.method === "POST",
          );
          expect(
            toolCall?.identity.user,
            "the MCP server saw the enterprise user with the granted scopes",
          ).toMatchObject({ scopes: [...SERVER_SCOPES] });

          // ---------------------------------------------------------------
          // Phase 2 — administrator policy denies this client. Clear both
          // ledgers first so every entry below belongs to the blocked attempt.
          // ---------------------------------------------------------------
          yield* Effect.promise(() => okta.ledger.clear());
          yield* Effect.promise(() => mcp.ledger.clear());
          yield* Effect.promise(() =>
            okta.seed({
              token_exchange_policies: [
                { name: "Block the executor client", client_id: clientId, effect: "DENY" },
              ],
            }),
          );

          const blocked = yield* client.oauth
            .start({
              payload: {
                owner: "org",
                client: serverClient,
                clientOwner: "org",
                name: ConnectionName.make("blocked"),
                integration,
                template,
                enterprise: {
                  idpClient: enterprise.client,
                  idpClientOwner: enterprise.clientOwner,
                  subjectToken,
                  subjectTokenType: ID_TOKEN_TYPE,
                },
              },
            })
            .pipe(Effect.flip);

          // Blocked-by-admin reaches the user in those words, carrying the
          // IdP's own RFC 8693 §2.2.2 code so support can trace the decision.
          expect(blocked._tag).toBe("OAuthStartError");
          expect(
            blocked.message,
            "the denial is surfaced as an organization decision, not a credential problem",
          ).toContain("identity provider did not authorize");
          expect(blocked.message).toContain("invalid_target");

          const deniedEntries = yield* ledger(okta);
          const denied = entryFor(deniedEntries, "okta.oauth.tokenExchange");
          expect(denied?.response.status, "the IdP refused the exchange").toBe(400);
          expect(denied?.response.body).toMatchObject({ error: "invalid_target" });

          // THE anti-fallback claim. If executor had quietly offered the
          // ordinary per-server flow, the MCP server would have seen an
          // authorize request — or another redemption attempt.
          const afterDenial = yield* ledger(mcp);
          expect(
            afterDenial.filter(
              (entry) =>
                entry.path === "/authorize" ||
                entry.path === "/register" ||
                entry.operationId === "mcp.oauth.jwtBearer",
            ),
            "a policy denial does not fall back to interactive OAuth",
          ).toEqual([]);

          const connections = yield* client.connections.list({ query: { integration } });
          expect(
            connections.map((connection) => String(connection.name)).sort(),
            "the blocked attempt minted no connection",
          ).toEqual(["main"]);
        }),
        Effect.gen(function* () {
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
