// Repro for the user report: "OAuth custom-MCP tokens are stored in a
// non-durable keychain on headless/sandbox daemons → connections silently die
// on every restart/recreate."
//
// The local app's plugin order (apps/local/executor.config.ts) registers
// keychainPlugin() BEFORE fileSecretsPlugin(), and defaultWritableProvider()
// picks the first writable provider — so wherever the keyring write-probe
// passes, every minted OAuth access/refresh token lands in the keychain
// (connection.provider = "keychain"). On sandbox hosts that keychain is an
// in-memory store: only EXECUTOR_DATA_DIR (data.db + auth.json) survives a
// sandbox stop/recreate, and data.db holds just the item REFERENCE
// (oauth:org:<slug>:default:refresh), not the secret. After recreate the
// connection is a zombie: health says expired — "Stored refresh token could
// not be resolved." — and the user must re-auth. Repeatedly.
//
// The scenario models the sandbox lifecycle with two real `executor web` boots
// on ONE kept data dir (what the sandbox persists), wiping this run's keychain
// service between them (what the sandbox loses):
//
//   boot 1: OAuth-connect a custom MCP server (real authorization-code flow
//           against a live test AS) → connection is healthy.
//   stop/recreate: keychain wiped, EXECUTOR_DATA_DIR kept.
//   boot 2: the SAME connection must still be healthy — durable-by-default is
//           the product guarantee. With the bug, this is where the zombie
//           appears (expired: "Stored refresh token could not be resolved.").
//
// Note: the repro only bites where the keychain probe passes (macOS dev
// machines, sandbox hosts with a kernel keyring). On headless CI without a
// reachable keyring the keychain provider never registers and the file
// provider is already the default — the scenario then passes vacuously, which
// mirrors production reality.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { makeEchoMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Cli, RunDir } from "../src/services";
import { withLocalServer, type ServerHandle } from "./local-server";

const api = composePluginApi([mcpHttpPlugin()] as const);

const name = ConnectionName.make("default");
const template = AuthTemplateSlug.make("oauth2");

/** Drive the test AS's consent by hand (authorize → login → code), without
 *  visiting the app's callback: `oauth.complete` takes the code directly. */
const completeAuthorization = (authorizationUrl: string) =>
  Effect.promise(async () => {
    const authorize = await fetch(authorizationUrl, { redirect: "manual" });
    const loginUrl = authorize.headers.get("location");
    if (!loginUrl) throw new Error(`authorize did not redirect: ${authorize.status}`);
    const login = await fetch(loginUrl, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from("alice:password").toString("base64")}` },
      redirect: "manual",
    });
    const callbackUrl = login.headers.get("location");
    if (!callbackUrl) throw new Error(`login did not redirect: ${login.status}`);
    const code = new URL(callbackUrl).searchParams.get("code");
    if (!code) throw new Error("callback carried no authorization code");
    return code;
  });

/** Simulate the non-durable secret store being lost on sandbox recreate: drop
 *  every entry under this run's keychain service. On macOS `security` deletes
 *  one matching item per call, so loop until none remain. When the fix routes
 *  tokens to the file provider this is a no-op — nothing lives there. */
const wipeKeychainService = (serviceName: string): void => {
  if (process.platform !== "darwin") return;
  for (let i = 0; i < 32; i++) {
    try {
      execFileSync("security", ["delete-generic-password", "-s", serviceName], {
        stdio: "ignore",
      });
    } catch {
      return; // no more entries under this service
    }
  }
};

const apiClient = (server: ServerHandle) =>
  HttpApiClient.make(api, {
    baseUrl: new URL("/api", server.origin).toString(),
    transformClient: HttpClient.mapRequest((request) =>
      HttpClientRequest.setHeader(request, "authorization", `Bearer ${server.token}`),
    ),
  }).pipe(Effect.provide(FetchHttpClient.layer));

scenario(
  "Local · an OAuth MCP connection survives a sandbox stop/recreate (data dir kept, keychain lost)",
  // Two full `executor web` boots; each allows up to 240s for a cold vite
  // start, so the test deadline must clear both plus the OAuth journey.
  { timeout: 600_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const cli = yield* Cli;
      const runDir = yield* RunDir;

      // The AS mints instantly-expiring access tokens so EVERY health check
      // exercises the refresh path — the exact path that dies when the stored
      // refresh token evaporates with the keychain.
      const oauth = yield* serveOAuthTestServer({
        scopes: ["mcp.read"],
        tokenExpiresInSeconds: 0,
      });
      // A real MCP upstream that accepts exactly the AS's issued bearers, so
      // "healthy" is a genuine dial-and-list verdict, not a stub's opinion.
      const mcp = yield* serveMcpServer(() => makeEchoMcpServer({ name: "durability-mcp" }), {
        auth: {
          validateAuthorization: (authorization) => oauth.acceptsAuthorizationHeader(authorization),
        },
      });

      const suffix = randomBytes(4).toString("hex");
      const slug = IntegrationSlug.make(`oauth-durability-${suffix}`);
      const clientSlug = OAuthClientSlug.make(`oauth-durability-client-${suffix}`);
      // A unique keychain service per run: the wipe below can only ever touch
      // this scenario's entries, and leftovers never collide across runs.
      const keychainService = `executor-e2e-durability-${suffix}`;
      // The data dir is the durable surface (what a sandbox backs up); it is
      // deliberately KEPT across the two boots and cleaned only at the end.
      const dataDir = mkdtempSync(join(tmpdir(), "executor-durability-e2e-"));
      const serverEnv = { EXECUTOR_KEYCHAIN_SERVICE_NAME: keychainService };

      yield* Effect.ensuring(
        Effect.gen(function* () {
          // ---- Boot 1: connect the OAuth MCP integration. -------------------
          yield* withLocalServer(
            cli,
            runDir,
            (server) =>
              Effect.gen(function* () {
                const client = yield* apiClient(server);

                yield* client.mcp.addServer({
                  payload: {
                    transport: "remote",
                    name: "Durability MCP",
                    endpoint: mcp.url,
                    slug: String(slug),
                    authenticationTemplate: [{ kind: "oauth2" }],
                  },
                });
                yield* client.oauth.createClient({
                  payload: {
                    owner: "org",
                    slug: clientSlug,
                    grant: "authorization_code",
                    authorizationUrl: oauth.authorizationEndpoint,
                    tokenUrl: oauth.tokenEndpoint,
                    clientId: "test-client",
                    clientSecret: "test-secret",
                    // MCP oauth2 templates discover scopes via the protected
                    // resource's metadata; the client must name that resource.
                    resource: oauth.mcpResourceUrl,
                    originIntegration: slug,
                  },
                });

                const started = yield* client.oauth.start({
                  payload: {
                    client: clientSlug,
                    clientOwner: "org",
                    owner: "org",
                    name,
                    integration: slug,
                    template,
                  },
                });
                expect(started.status, "oauth.start redirects to the authorization server").toBe(
                  "redirect",
                );
                if (started.status !== "redirect") return yield* Effect.die("no redirect");
                const code = yield* completeAuthorization(started.authorizationUrl);
                yield* client.oauth.complete({ payload: { state: started.state, code } });

                const connection = yield* client.connections.get({
                  params: { owner: "org", integration: slug, name },
                });
                // Where did the minted tokens actually land? This is the root
                // cause made visible: "keychain" = non-durable on sandbox hosts.
                console.info(
                  `[durability repro] minted connection provider: ${String(connection.provider)}`,
                );

                const healthy = yield* client.connections.checkHealth({
                  params: { owner: "org", integration: slug, name },
                  query: {},
                });
                expect(
                  healthy.status,
                  `the fresh OAuth connection is healthy (detail: ${healthy.detail ?? "-"})`,
                ).toBe("healthy");
              }),
            { dataDir, env: serverEnv, castName: "terminal-boot1.cast" },
          );

          // ---- Sandbox stop/recreate: keychain gone, data dir kept. ---------
          wipeKeychainService(keychainService);

          // ---- Boot 2: the connection must still work. ----------------------
          yield* withLocalServer(
            cli,
            runDir,
            (server) =>
              Effect.gen(function* () {
                const client = yield* apiClient(server);

                const health = yield* client.connections.checkHealth({
                  params: { owner: "org", integration: slug, name },
                  query: {},
                });
                console.info(
                  `[durability repro] post-recreate health: ${health.status} — ${health.detail ?? "-"}`,
                );
                // THE guarantee: OAuth credentials live in the durable store
                // (EXECUTOR_DATA_DIR), so losing the host's ephemeral keychain
                // must not kill the connection. With the bug this reads
                // expired: "Stored refresh token could not be resolved."
                expect(
                  health.status,
                  `the OAuth connection survives a sandbox recreate (detail: ${health.detail ?? "-"})`,
                ).toBe("healthy");
              }),
            { dataDir, env: serverEnv, castName: "terminal-boot2.cast" },
          );
        }),
        Effect.sync(() => {
          wipeKeychainService(keychainService);
          rmSync(dataDir, { recursive: true, force: true });
        }),
      );
    }),
  ),
);
