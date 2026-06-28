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

scenario(
  "Local · a stdio MCP server's tools are detected on a fresh install, with env stored as a secret",
  // Must stay STRICTLY greater than the boot-URL wait in `withLocalServer`
  // (currently 180s). When this CI job runs `stdio-mcp.test.ts` alone it always
  // pays a cold `vite optimizeDeps` boot (no prior file to warm the cache), the
  // one variable step. If this test timeout equals the boot wait, both deadlines
  // fire together and vitest's generic "Test timed out" wins, swallowing the
  // harness's "printed no ?_token URL\n<terminal tail>" error that tells us what
  // boot actually got stuck on. Keep the gap so the boot diagnostic surfaces.
  { timeout: 240_000 },
  Effect.gen(function* () {
    const cli = yield* Cli;
    const runDir = yield* RunDir;

    yield* withLocalServer(cli, runDir, (server) =>
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
      }),
    );
  }),
);
