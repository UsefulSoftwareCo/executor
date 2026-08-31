// Codex plugins as one-click stdio presets.
//
// The server-side scanner reads `$CODEX_HOME` and reports locally installed
// OpenAI Codex plugins with stdio MCP servers: the three curated ones the
// shared "Codex Computer Use" client binary implements (Apple Messages,
// Computer Use, Computer History) plus anything in the plugin cache with a
// local-command `.mcp.json`. This scenario boots the real local server with
// `CODEX_HOME` pointed at a fixture layout whose "client binary" is a wrapper
// around the e2e stdio MCP fixture, and drives the same API the add-form's
// Codex-plugins section uses:
//
//   1. `mcp.listCodexPlugins` reports the curated entries and the scanned
//      cache entry, all available.
//   2. Adding an entry with its reported recipe (the one-click card path)
//      registers the integration, auto-connects, and detects its tools —
//      including `saw_codex_home`, which the fixture advertises only when
//      CODEX_HOME actually reached the spawned subprocess.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";

import { scenario } from "../src/scenario";
import { Cli, RunDir } from "../src/services";
import { withLocalServer } from "./local-server";

const api = composePluginApi([mcpHttpPlugin()] as const);

const FIXTURE = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));
const CHROME_CLIENT_RELATIVE = join(
  "plugins",
  "cache",
  "openai-bundled",
  "chrome",
  "latest",
  "scripts",
  "browser-client.mjs",
);
const COMPUTER_USE_CLIENT_RELATIVE = join(
  "plugins",
  "cache",
  "openai-bundled",
  "computer-use",
  "1.0.0",
  "scripts",
  "computer-use-client.mjs",
);
const APP_SERVER_FIXTURE = fileURLToPath(
  new URL("./fixtures/codex-app-server.mjs", import.meta.url),
);

/** A fixture CODEX_HOME: the curated install markers (the Computer Use app
 *  and a `codex` CLI whose `app-server` is the fake app-server fixture) and
 *  one cached plugin wrapping the self-contained stdio MCP fixture. */
const makeCodexHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "codex-home-e2e-"));
  const wrapper = `#!/bin/sh\nexec node "${FIXTURE}" "$@"\n`;

  // The Computer Use app is the plugin-installed marker; the bridge never
  // spawns it, so an empty executable is enough.
  const clientDir = join(
    home,
    "computer-use",
    "Codex Computer Use.app",
    "Contents",
    "SharedSupport",
    "SkyComputerUseClient.app",
    "Contents",
    "MacOS",
  );
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(join(clientDir, "SkyComputerUseClient"), wrapper, { mode: 0o755 });

  // The `codex` CLI the curated recipes spawn — resolved through PATH, so
  // the scenario prepends this bin dir to the server's PATH.
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", "codex"), `#!/bin/sh\nexec node "${APP_SERVER_FIXTURE}" "$@"\n`, {
    mode: 0o755,
  });

  // Plugin-owned runtime clients: Computer Use's versioned trusted-runtime
  // wrapper and Chrome's browser client behind the `latest` symlink Codex keeps.
  const computerUseClient = join(home, COMPUTER_USE_CLIENT_RELATIVE);
  mkdirSync(join(computerUseClient, ".."), { recursive: true });
  writeFileSync(computerUseClient, "export const setupComputerUseRuntime = async () => ({});\n");

  const chromeClient = join(home, CHROME_CLIENT_RELATIVE);
  mkdirSync(join(chromeClient, ".."), { recursive: true });
  writeFileSync(chromeClient, "export const setupBrowserRuntime = async () => ({});\n");

  const versionDir = join(home, "plugins", "cache", "personal", "echo-suite", "1.0.2");
  mkdirSync(join(versionDir, ".codex-plugin"), { recursive: true });
  mkdirSync(join(versionDir, "bin"), { recursive: true });
  writeFileSync(
    join(versionDir, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "echo-suite",
      mcpServers: "./.mcp.json",
      interface: { displayName: "Echo Suite", shortDescription: "Echo tools for e2e" },
    }),
  );
  writeFileSync(
    join(versionDir, ".mcp.json"),
    JSON.stringify({ mcpServers: { "echo-suite": { command: "./bin/run", cwd: "." } } }),
  );
  writeFileSync(join(versionDir, "bin", "run"), wrapper, { mode: 0o755 });

  return home;
};

scenario(
  "Local · Codex plugins are discovered from CODEX_HOME and add as one-click stdio presets",
  // Above the 240s boot-URL wait in `withLocalServer` for the same reason as
  // stdio-mcp.test.ts: a cold vite boot must fail with the harness's
  // diagnostic, not vitest's generic timeout.
  { timeout: 300_000 },
  Effect.gen(function* () {
    const cli = yield* Cli;
    const runDir = yield* RunDir;
    const codexHome = makeCodexHome();

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

          // The scanner reports the curated plugins and the cached one, all
          // available (the fixture home has every binary in place).
          const { plugins } = yield* client.mcp.listCodexPlugins();
          const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
          expect([...byId.keys()].sort(), "curated + scanned entries are reported").toEqual([
            "codex-chrome",
            "codex-computer-history",
            "codex-computer-use",
            "codex-echo-suite",
            "codex-messages",
            "codex-openai-docs",
          ]);
          for (const plugin of plugins) {
            expect(plugin.available, `${plugin.id} is available`).toBe(true);
            expect(plugin.env, `${plugin.id} declares CODEX_HOME`).toEqual({
              CODEX_HOME: codexHome,
            });
          }
          // Curated entries carry the app-server bridge recipe: `codex
          // app-server`, the server name the bridge calls tools on, and the
          // preset it came from — that last one is what lets a macOS refusal
          // name the exact grant to enable.
          const messages = byId.get("codex-messages");
          expect(messages?.command.endsWith("codex"), "curated entries spawn the codex CLI").toBe(
            true,
          );
          expect(messages?.args, "curated entries run the app-server").toEqual(["app-server"]);
          expect(messages?.appServer, "curated entries name their Codex server").toEqual({
            presetId: "codex-messages",
            server: "messages",
          });
          // Computer Use and Chrome have no server of their own: both are
          // projected onto `node_repl` and carry the plugin-owned client module
          // their surface imports.
          expect(byId.get("codex-computer-use")?.appServer).toEqual({
            presetId: "codex-computer-use",
            server: "node_repl",
            surface: "sky",
            modulePath: join(codexHome, COMPUTER_USE_CLIENT_RELATIVE),
          });
          expect(byId.get("codex-chrome")?.appServer).toEqual({
            presetId: "codex-chrome",
            server: "node_repl",
            surface: "browser",
            modulePath: join(codexHome, CHROME_CLIENT_RELATIVE),
          });

          // Add two entries exactly as the add-form's Codex-plugins card does:
          // the reported recipe, verbatim.
          for (const id of ["codex-messages", "codex-echo-suite"] as const) {
            const plugin = byId.get(id)!;
            yield* client.mcp.addServer({
              payload: {
                transport: "stdio",
                name: plugin.name,
                slug: plugin.slug,
                description: plugin.summary,
                command: plugin.command,
                args: [...plugin.args],
                ...(plugin.cwd === undefined ? {} : { cwd: plugin.cwd }),
                // Static, not `env`: CODEX_HOME is a machine path the scanner
                // resolved, so it must not become a credential to type.
                ...(plugin.env === undefined ? {} : { staticEnv: { ...plugin.env } }),
                ...(plugin.appServer === undefined
                  ? {}
                  : { appServer: { server: plugin.appServer.server } }),
              },
            });
          }

          const integrations = yield* client.integrations.list();
          const slugs = integrations.map((integration) => String(integration.slug));
          expect(slugs, "both plugins registered").toEqual(
            expect.arrayContaining(["codex_messages", "codex_echo_suite"]),
          );

          // One-click means connected: the env values auto-create the default
          // connection, so tools are discovered with no further step.
          for (const slug of ["codex_messages", "codex_echo_suite"]) {
            const connections = yield* client.connections.list({ query: { integration: slug } });
            expect(
              connections.map((connection) => String(connection.name)),
              `${slug} auto-connected`,
            ).toContain("default");
            // Nothing to configure: the connection carries no credential, so
            // the person is never shown a field for a path we already know.
            expect(
              connections.map((connection) => String(connection.template)),
              `${slug} needs no credential`,
            ).toEqual(["none"]);

            const tools = yield* client.tools.list({ query: { integration: slug } });
            const names = tools.map((tool) => tool.name);
            expect(names, `${slug} tools are detected`).toContain("echo_tool");
            expect(
              names,
              `CODEX_HOME reached ${slug}'s spawned subprocess (saw_codex_home is gated on it)`,
            ).toContain("saw_codex_home");
          }
        }),
      {
        env: {
          CODEX_HOME: codexHome,
          // The scanner resolves the `codex` CLI through the server's PATH.
          PATH: `${join(codexHome, "bin")}:${process.env["PATH"] ?? ""}`,
        },
      },
    );
  }),
);
