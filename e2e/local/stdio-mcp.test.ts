// Repro + regression guard for the user report: "On a totally fresh install
// (no existing data dir) on macOS, Executor does not detect any tools for a
// STDIO MCP server."
//
// `withLocalServer` boots a real `executor web` on a THROWAWAY data dir (the
// fresh-install condition) and the `local` app is the only surface that enables
// stdio MCP (`dangerouslyAllowStdioMCP: true`). We add a stdio MCP server over
// the bearer-authed API and assert its tools are discoverable — and that the
// secret env it needs is stored on the connection (the secret store), not in
// the integration's config blob.
//
// The original bug: `mcp.addServer` only registered an INTEGRATION. Per the
// v1.5 integrations/connections split, tools are produced per-CONNECTION, and a
// stdio add never created one, so the integration landed with zero connections
// and zero tools. The fix auto-creates the default connection on add and routes
// the env values into the connection's secret store.
//
// The scenario also covers what ELSE reaches that subprocess. A stdio server
// that declared any `env` used to be spawned with `{ ...process.env, ...env }`,
// so it received every variable the daemon holds — including the key that
// decrypts the secret store. `withLocalServer`'s `env` option plants two
// variables on the real daemon process (see DAEMON_ENV) and the fixture reports
// which of them survived the spawn, so the boundary is measured on the product
// path rather than at the call site of the transport.
import { fileURLToPath } from "node:url";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Cli, RunDir } from "../src/services";
import { withLocalServer } from "./local-server";

const api = composePluginApi([mcpHttpPlugin()] as const);

const FIXTURE = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));

// The fixture exposes `whoami` ONLY when EXECUTOR_E2E_SECRET is present in its
// process env. So `whoami` showing up in the discovered tools is direct proof
// the connection's secret env reached the spawned subprocess.
const SECRET = "s3cr3t-from-the-vault";

// Planted on the `executor web` process itself, so the only way either value
// can reach a stdio subprocess is by being inherited across the spawn.
//
// NO_PROXY stands in for the infrastructure allowlist: it is one of the
// variables a stdio server must keep inheriting, and it is the inert member of
// that list — with no proxy configured alongside it, it changes nothing about
// the daemon's own egress, so planting it cannot perturb the rest of the run.
//
// The sentinel stands in for a real host secret such as EXECUTOR_SECRET_KEY.
// A variable only this scenario sets keeps the assertion honest on a machine
// where the real one happens not to be exported.
const PROXY_VALUE = "stdio-env-e2e.invalid";
const HOST_ONLY_SENTINEL = "host-secret-that-must-not-reach-a-stdio-server";
const DAEMON_ENV = {
  NO_PROXY: PROXY_VALUE,
  EXECUTOR_E2E_HOST_ONLY_SECRET: HOST_ONLY_SENTINEL,
};

scenario(
  "Local · a stdio MCP server's tools are detected on a fresh install, with env stored as a secret and the daemon's own environment withheld",
  // Must stay STRICTLY greater than the boot-URL wait in `withLocalServer`
  // (currently 240s). When this CI job runs `stdio-mcp.test.ts` alone it always
  // pays a cold `vite optimizeDeps` boot (no prior file to warm the cache), the
  // one variable step. If this test timeout equals the boot wait, both deadlines
  // fire together and vitest's generic "Test timed out" wins, swallowing the
  // harness's "printed no ?_token URL\n<terminal tail>" error that tells us what
  // boot actually got stuck on. Keep the gap so the boot diagnostic surfaces.
  { timeout: 300_000 },
  Effect.gen(function* () {
    const cli = yield* Cli;
    const runDir = yield* RunDir;

    yield* withLocalServer(
      cli,
      runDir,
      (server) =>
        Effect.gen(function* () {
          const client = yield* HttpApiClient.make(api, {
            baseUrl: new URL("/api", server.origin).toString(),
            transformClient: HttpClient.mapRequest((request) =>
              HttpClientRequest.setHeader(request, "authorization", `Bearer ${server.token}`),
            ),
          }).pipe(Effect.provide(FetchHttpClient.layer));

          const slug = "e2e-stdio";

          // Add the stdio server exactly as the desktop/local "Add MCP" flow does,
          // including a secret env var the server needs.
          yield* client.mcp.addServer({
            payload: {
              transport: "stdio",
              name: "E2E Stdio",
              command: "node",
              args: [FIXTURE],
              env: { EXECUTOR_E2E_SECRET: SECRET },
              slug,
            },
          });

          // The integration lands in the catalog — the add itself works.
          const integrations = yield* client.integrations.list();
          expect(
            integrations.map((i) => String(i.slug)),
            "the stdio MCP integration is registered",
          ).toContain(slug);

          // The add auto-creates the default connection (the v1.5 split makes this
          // the thing that drives tool discovery). Pre-fix there were zero.
          const connections = yield* client.connections.list({ query: { integration: slug } });
          expect(
            connections.map((c) => String(c.name)),
            "a default connection was auto-created for the stdio server",
          ).toContain("default");

          // THE SYMPTOM, fixed: the stdio server's tools are detected. `whoami`
          // appearing proves the connection's secret env reached the subprocess.
          const tools = yield* client.tools.list({ query: { integration: slug } });
          const names = tools.map((t) => t.name);
          expect(names, "the stdio server's base tool is detected").toContain("echo_tool");
          expect(
            names,
            "the secret env var reached the spawned subprocess (whoami is gated on it)",
          ).toContain("whoami");

          // --- What the daemon's own environment does, and does not, hand to a
          // stdio server. This is the branch that leaked: `e2e-stdio` declares an
          // `env`, and the declared-env branch used to spawn with the whole of
          // `process.env` merged underneath. Each `saw_*` tool exists only because
          // the matching variable was present in the CHILD's environment. ---
          expect(names, "the declared env var is visible to the server").toContain(
            "saw_declared_env",
          );
          expect(
            names,
            "the host's proxy configuration still reaches the server, or every stdio server behind a corporate proxy breaks",
          ).toContain("saw_proxy_env");
          expect(
            names,
            "a host variable the source never declared (EXECUTOR_E2E_HOST_ONLY_SECRET) must not reach the server",
          ).not.toContain("saw_host_secret");

          // "Properly store auth": the secret value is NOT in the integration's
          // config blob — only the var NAME is declared there; the value lives on
          // the connection (the secret store).
          const stored = yield* client.mcp.getServer({ params: { slug } });
          expect(
            JSON.stringify(stored?.config ?? {}),
            "the secret value is not persisted in the integration config",
          ).not.toContain(SECRET);

          // --- The UI path: DECLARE env var names, then provide the secret value
          // as a connection credential (what the add form now does). ---
          const declSlug = "e2e-stdio-decl";
          yield* client.mcp.addServer({
            payload: {
              transport: "stdio",
              name: "E2E Stdio Declared",
              command: "node",
              args: [FIXTURE],
              envVars: ["EXECUTOR_E2E_SECRET"],
              slug: declSlug,
            },
          });

          // Declaring a secret env var (no value) does NOT auto-connect: the
          // secret is still missing, so there are no tools until you connect.
          const beforeConns = yield* client.connections.list({ query: { integration: declSlug } });
          expect(beforeConns, "no connection until the secret is provided").toHaveLength(0);
          const beforeTools = yield* client.tools.list({ query: { integration: declSlug } });
          expect(beforeTools, "no tools until the secret is provided").toHaveLength(0);

          // Provide the secret as the connection credential (the connect step).
          yield* client.connections.create({
            payload: {
              owner: "org",
              name: ConnectionName.make("default"),
              integration: IntegrationSlug.make(declSlug),
              template: AuthTemplateSlug.make("env"),
              values: { EXECUTOR_E2E_SECRET: SECRET },
            },
          });

          const declTools = yield* client.tools.list({ query: { integration: declSlug } });
          expect(
            declTools.map((t) => t.name),
            "connecting with the secret discovers the env-gated tool",
          ).toContain("whoami");

          // --- versionNegotiation "auto" survives the API → config → connector
          // path and still reaches a legacy server: the probe gets the fixture's
          // method-not-found for `server/discover` (a definitive legacy verdict)
          // and falls back to `initialize`. Modern-era acceptance against a real
          // legacy-disabled SDK v2 server lives in the plugin's
          // stdio-negotiation.test.ts. ---
          const autoSlug = "e2e-stdio-auto";
          yield* client.mcp.addServer({
            payload: {
              transport: "stdio",
              name: "E2E Stdio Auto",
              command: "node",
              args: [FIXTURE],
              versionNegotiation: "auto",
              slug: autoSlug,
            },
          });

          const autoStored = yield* client.mcp.getServer({ params: { slug: autoSlug } });
          expect(
            JSON.stringify(autoStored?.config ?? {}),
            "the negotiation mode is persisted on the integration config",
          ).toContain('"versionNegotiation":"auto"');

          const autoTools = yield* client.tools.list({ query: { integration: autoSlug } });
          expect(
            autoTools.map((t) => t.name),
            "auto negotiation falls back to legacy and still discovers tools",
          ).toContain("echo_tool");
        }),
      { env: DAEMON_ENV },
    );
  }),
);
