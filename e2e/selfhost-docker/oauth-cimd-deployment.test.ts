import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { connectEmulator } from "@executor-js/emulate";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { runSelfhostContainer, stopSelfhostContainer } from "../setup/selfhost-docker.boot";
import { createEmulatorInstance } from "../src/emulator-instance";
import { e2ePort } from "../src/ports";
import { scenario } from "../src/scenario";
import { Api, Browser, Mcp, RunDir, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";
import { SELFHOST_ADMIN } from "../targets/selfhost";

const api = composePluginApi([mcpHttpPlugin(), openApiHttpPlugin()] as const);

// A new production container on the SAME named volume changes the actual
// process environment. No application config, database, or OAuth mocks.
const restart = (webBaseUrl: string, enabled: false | undefined) =>
  Effect.promise(async () => {
    const image =
      process.env.E2E_SELFHOST_DOCKER_RESOLVED_IMAGE ?? process.env.E2E_SELFHOST_DOCKER_IMAGE;
    if (!image) throw new Error("The CIMD deployment scenario requires an explicit Docker image");
    const port = e2ePort("E2E_SELFHOST_DOCKER_PORT", 5);
    await stopSelfhostContainer(port);
    await runSelfhostContainer({
      image,
      port,
      webBaseUrl,
      admin: SELFHOST_ADMIN,
      oauthCimdEnabled: enabled,
      publishPort: true,
    });
  });

for (const protocol of ["MCP", "OpenAPI"] as const) {
  scenario(
    `Docker OAuth · ${protocol} uses DCR when CIMD is disabled and CIMD after restart`,
    { timeout: 360_000 },
    Effect.scoped(
      Effect.gen(function* () {
        const target = yield* Target;
        const browser = yield* Browser;
        const mcp = yield* Mcp;
        const runDir = yield* RunDir;
        const { client: makeClient } = yield* Api;
        const service = protocol === "MCP" ? "mcp" : "posthog";
        const consentUser = protocol === "MCP" ? /admin@localhost/ : /cimd@example.com/;
        const localUrl =
          process.env[protocol === "MCP" ? "E2E_CIMD_MCP_URL" : "E2E_CIMD_OPENAPI_URL"];
        const baseUrl = localUrl ?? (yield* createEmulatorInstance(service, "oauth-deployment"));
        const emulator = yield* Effect.promise(() => connectEmulator({ baseUrl }));
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            writeFileSync(
              join(runDir, "ledger.json"),
              JSON.stringify(await emulator.ledger.list(), null, 2),
            );
          }).pipe(Effect.ignore),
        );
        yield* Effect.promise(() =>
          emulator.seed(
            service === "mcp"
              ? {
                  oauth: { clientIdMetadataDocumentSupported: true },
                }
              : {
                  users: [{ email: "cimd@example.com", name: "CIMD Test" }],
                  projects: [{ id: 1, name: "CIMD Project" }],
                },
          ),
        );
        const slug = IntegrationSlug.make(`cimd_${service}_${randomBytes(4).toString("hex")}`);
        yield* restart(target.baseUrl, false);
        const identity = yield* target.newIdentity();
        const client = yield* makeClient(api, identity);
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const clients = yield* client.oauth.listClients();
            for (const app of clients.filter((candidate) =>
              candidate.tokenUrl.startsWith(`${baseUrl}/`),
            )) {
              yield* client.oauth.removeClient({
                params: { slug: app.slug },
                payload: { owner: app.owner },
              });
            }
          }).pipe(Effect.ignore),
        );
        const resourceUrl = service === "mcp" ? `${baseUrl}/mcp` : baseUrl;
        const probe = yield* client.oauth.probe({ payload: { url: resourceUrl } });
        expect(probe.clientIdMetadataDocumentSupported).toBe(false);
        expect(probe.registrationEndpoint).toBeTruthy();

        if (protocol === "MCP") {
          yield* client.mcp.addServer({
            payload: {
              slug,
              name: "CIMD deployment MCP",
              transport: "remote",
              endpoint: resourceUrl,
              authenticationTemplate: [{ kind: "oauth2" }],
            },
          });
        } else {
          yield* client.openapi.addSpec({
            payload: {
              slug,
              name: "CIMD deployment OpenAPI",
              spec: { kind: "url", url: emulator.openapiUrl },
            },
          });
        }
        yield* Effect.addFinalizer(() =>
          (protocol === "MCP"
            ? client.mcp.removeServer({ params: { slug } })
            : client.openapi.removeSpec({ params: { slug } })
          ).pipe(Effect.ignore),
        );

        // Keep a single browser session so the recording includes the restart
        // and both authorizations for the integration created while disabled.
        yield* browser.session(identity, async ({ page, step }) => {
          for (const flow of ["dcr", "cimd"] as const) {
            if (flow === "cimd") {
              await step("Restart Docker with EXECUTOR_OAUTH_CIMD_ENABLED unset", async () => {
                await Effect.runPromise(restart(target.baseUrl, undefined));
              });
            }
            const effective = await Effect.runPromise(
              client.oauth.probe({ payload: { url: resourceUrl } }),
            );
            expect(
              effective.clientIdMetadataDocumentSupported,
              "the deployment switch controls the live CIMD capability",
            ).toBe(flow === "cimd");
            await emulator.ledger.clear();
            const before = await Effect.runPromise(
              client.connections.list({ query: { integration: slug } }),
            );
            await step(`Connect ${protocol} using ${flow.toUpperCase()}`, async () => {
              await visit(page, `/integrations/${slug}`);
              await page
                .getByRole("button", { name: "Add connection", exact: true })
                .first()
                .click();
              if (protocol === "OpenAPI") await page.getByRole("tab", { name: /OAuth/ }).click();
              const connect = page
                .getByRole("dialog")
                .getByRole("button", { name: /^(Connect|Connect with OAuth)$/ });
              await connect.waitFor({ timeout: 15_000 });
              const [popup] = await Promise.all([page.waitForEvent("popup"), connect.click()]);
              await popup.getByRole("button", { name: consentUser }).waitFor({ timeout: 30_000 });
              const authorization = new URL(popup.url());
              const clientId = authorization.searchParams.get("client_id") ?? "";
              expect(
                clientId.includes("/api/oauth/client-id-metadata/"),
                "the real authorization request uses the expected client identity",
              ).toBe(flow === "cimd");
              await Promise.all([
                popup.waitForEvent("close", { timeout: 60_000 }),
                popup.getByRole("button", { name: consentUser }).click(),
              ]);
              await page
                .getByRole("heading", { name: /Add connection/ })
                .waitFor({ state: "hidden", timeout: 60_000 });
            });

            await step(
              `Call the authenticated ${protocol} operation through Executor`,
              async () => {
                const after = await Effect.runPromise(
                  client.connections.list({ query: { integration: slug } }),
                );
                const connection = after.find(
                  (candidate) =>
                    !before.some(
                      (previous) =>
                        previous.name === candidate.name && previous.owner === candidate.owner,
                    ),
                );
                expect(connection, "OAuth callback persisted a new connection").toBeDefined();
                const tools = await Effect.runPromise(
                  client.tools.list({ query: { integration: slug } }),
                );
                const tool = tools.find(
                  (candidate) =>
                    candidate.connection === connection?.name &&
                    (protocol === "MCP"
                      ? String(candidate.address).endsWith("get_me")
                      : String(candidate.address).endsWith("projectsList")),
                );
                expect(
                  tool,
                  `the authenticated operation exists on the new connection: ${tools.map((item) => item.address).join(", ")}`,
                ).toBeDefined();
                const session = mcp.session(identity);
                let result = await Effect.runPromise(
                  session.call("execute", {
                    code: `return await ${tool?.address}({});`,
                  }),
                );
                for (
                  let approval = 0;
                  approval < 10 && result.text.includes("executionId:");
                  approval++
                ) {
                  result = await Effect.runPromise(session.approvePaused(result.text));
                }
                expect(result.ok, result.text).toBe(true);
                expect(result.text).toContain(protocol === "MCP" ? "admin" : "CIMD Project");
                const ledger = await emulator.ledger.list();
                writeFileSync(join(runDir, `${flow}-ledger.json`), JSON.stringify(ledger, null, 2));
                expect(
                  ledger.some(
                    (entry) =>
                      entry.method === "POST" &&
                      /\/register\/?$/.test(entry.path) &&
                      entry.response.status === 201,
                  ),
                ).toBe(flow === "dcr");
                expect(
                  ledger.some(
                    (entry) =>
                      entry.method === "POST" &&
                      /\/token\/?$/.test(entry.path) &&
                      entry.response.status === 200,
                  ),
                ).toBe(true);
                expect(
                  ledger.some(
                    (entry) =>
                      entry.response.status === 200 &&
                      entry.identity.user?.login ===
                        (protocol === "MCP" ? "admin" : "cimd@example.com") &&
                      (protocol === "MCP"
                        ? entry.method === "POST" &&
                          entry.path.endsWith("/mcp") &&
                          JSON.stringify(entry.request.body).includes("tools/call")
                        : entry.method === "GET" && entry.path.endsWith("/api/projects/")),
                  ),
                ).toBe(true);
              },
            );
          }
        });
      }),
    ),
  );
}

scenario(
  "Docker OAuth · removing a custom OpenAPI method preserves CIMD across restart",
  { timeout: 240_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const baseUrl =
        process.env.E2E_CIMD_OPENAPI_URL ??
        (yield* createEmulatorInstance("posthog", "oauth-config"));
      const emulator = yield* Effect.promise(() => connectEmulator({ baseUrl }));
      yield* restart(target.baseUrl, undefined);
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const slug = IntegrationSlug.make(`cimd_config_${randomBytes(4).toString("hex")}`);
      yield* client.openapi.addSpec({
        payload: { slug, spec: { kind: "url", url: emulator.openapiUrl } },
      });
      yield* Effect.addFinalizer(() =>
        client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore),
      );
      const original = yield* client.openapi.getConfig({ params: { slug } });
      expect(original?.authenticationTemplate?.some((template) => template.kind === "oauth2")).toBe(
        true,
      );
      yield* client.openapi.configure({
        params: { slug },
        payload: {
          authenticationTemplate: [
            {
              type: "apiKey",
              slug: "custom_temporary",
              label: "Temporary key",
              headers: { "x-test-key": "{{token}}" },
            },
          ],
        },
      });
      yield* browser.session(identity, async ({ page, step }) => {
        await step("Disable CIMD and restart the Docker container", () =>
          Effect.runPromise(restart(target.baseUrl, false)),
        );
        await step("Remove an unrelated custom authentication method", async () => {
          await visit(page, `/integrations/${slug}`);
          await page.getByRole("button", { name: "Add connection", exact: true }).first().click();
          await page.getByRole("tab", { name: "Temporary key" }).click();
          await page.getByRole("button", { name: "Remove Temporary key", exact: true }).click();
          await page.getByRole("tab", { name: "Temporary key" }).waitFor({ state: "hidden" });
        });
        await step(
          "Unset the deployment switch and verify the original OAuth configuration",
          async () => {
            await Effect.runPromise(restart(target.baseUrl, undefined));
            const restored = await Effect.runPromise(
              client.openapi.getConfig({ params: { slug } }),
            );
            expect(restored?.authenticationTemplate).toEqual(original?.authenticationTemplate);
            await visit(page, `/integrations/${slug}`);
          },
        );
      });
    }),
  ),
);
