// Local-only — the integration Edit sheet for a STDIO MCP server, driven in a
// real browser. `local` is the only surface that enables stdio MCP
// (`dangerouslyAllowStdioMCP: true`), so it is the only place this sheet can be
// exercised end to end.
//
// The sheet used to say "Stdio MCP integrations cannot be edited. Remove and
// recreate the integration with the updated command." (#812) — changing a
// command meant editing `executor.jsonc` by hand, or losing the integration's
// connections and policies to a delete-and-re-add.
//
// The assertion is deliberately not "the field accepted my text". The scenario
// edits the DECLARED env map through the form and then reads the tool catalog:
// the fixture advertises `saw_declared_env` only when that variable is present
// in the spawned child's environment, so the tool appearing proves the edited
// config travelled the whole way — form, config write, respawn, rediscovery.
import { fileURLToPath } from "node:url";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";

import { scenario } from "../src/scenario";
import { Browser, Cli, RunDir, Target } from "../src/services";
import { withLocalServer } from "./local-server";

const api = composePluginApi([mcpHttpPlugin()] as const);

const FIXTURE = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));

const SECRET = "s3cr3t-typed-into-the-edit-sheet";

scenario(
  "Local · a stdio MCP server's command and environment are editable from the integration Edit sheet",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const cli = yield* Cli;
    const browser = yield* Browser;
    const target = yield* Target;
    const runDir = yield* RunDir;
    const identity = yield* target.newIdentity();

    yield* withLocalServer(cli, runDir, (server) =>
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(api, {
          baseUrl: new URL("/api", server.origin).toString(),
          transformClient: HttpClient.mapRequest((request) =>
            HttpClientRequest.setHeader(request, "authorization", `Bearer ${server.token}`),
          ),
        }).pipe(Effect.provide(FetchHttpClient.layer));

        const slug = "e2e-stdio-editable";

        // A plain stdio server: no declared env, so the env-gated tool is absent
        // until the edit adds the variable.
        yield* client.mcp.addServer({
          payload: {
            transport: "stdio",
            name: "E2E Stdio Editable",
            command: "node",
            args: [FIXTURE],
            slug,
          },
        });

        const before = yield* client.tools.list({ query: { integration: slug } });
        expect(
          before.map((t) => t.name),
          "the server starts with its base tool and no declared env",
        ).toContain("echo_tool");
        expect(
          before.map((t) => t.name),
          "the env-gated tool is absent before the edit",
        ).not.toContain("saw_declared_env");

        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open the stdio integration from the console", async () => {
            await page.goto(server.url, { waitUntil: "domcontentloaded" });
            await page.getByTestId(`integration-entry-${slug}`).first().click();
            // Wait for the detail page's own data, not just its shell: clicking
            // Edit while the accounts panel is still a skeleton races the layout
            // shift that lands when it resolves.
            await page.getByText("default").first().waitFor({ timeout: 30_000 });
            await page.getByRole("button", { name: "Edit" }).waitFor({ timeout: 30_000 });
          });

          await step("Open the Edit sheet — the stdio command is editable", async () => {
            await page.getByRole("button", { name: "Edit" }).click();
            await page.getByText("Edit integration").waitFor({ timeout: 30_000 });
            await page.getByText("Server command").waitFor({ timeout: 30_000 });
            // The read-only dead end this replaces.
            expect(
              await page.getByText("Stdio MCP integrations cannot be edited").count(),
              "the read-only message is gone",
            ).toBe(0);
            expect(
              await page.getByRole("textbox", { name: "Command" }).inputValue(),
              "the stored command is loaded into the form",
            ).toBe("node");
          });

          await step("Declare an environment variable and save", async () => {
            await page
              .getByRole("textbox", { name: "Environment variables" })
              .fill(`EXECUTOR_E2E_SECRET=${SECRET}`);
            await page.getByRole("button", { name: "Save" }).click();
            await page.getByText("Server command").waitFor({ state: "hidden", timeout: 30_000 });
          });
        });

        // The edit persisted as the DECLARED static env map on the config.
        const stored = yield* client.mcp.getServer({ params: { slug } });
        expect(
          stored?.config.transport === "stdio" ? stored.config.env : undefined,
          "the sheet wrote the declared env map",
        ).toEqual({ EXECUTOR_E2E_SECRET: SECRET });
        expect(
          stored?.config.transport === "stdio" ? stored.config.command : undefined,
          "the command it did not touch is unchanged",
        ).toBe("node");

        // And it reached the spawned server: the fixture gates this tool's very
        // existence on that variable being in its own environment.
        const after = yield* client.tools.list({ query: { integration: slug } });
        expect(
          after.map((t) => t.name),
          "the edited environment reached the respawned server and the catalog was rebuilt",
        ).toContain("saw_declared_env");
        expect(
          after.map((t) => t.name),
          "the rebuild kept the tools that still exist",
        ).toContain("echo_tool");
      }),
    );
  }),
);
