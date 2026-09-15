import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { connectEmulator } from "@executor-js/emulate";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, IntegrationSlug } from "@executor-js/sdk/shared";

import { runSelfhostContainer, stopSelfhostContainer } from "../setup/selfhost-docker.boot";
import { createEmulatorInstance } from "../src/emulator-instance";
import { e2ePort } from "../src/ports";
import { scenario } from "../src/scenario";
import { Api, Browser, Mcp, RunDir, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";
import { SELFHOST_ADMIN } from "../targets/selfhost";

const api = composePluginApi([openApiHttpPlugin()] as const);

for (const issuer of ["root", "path"] as const) {
  scenario(
    `Docker OAuth · issuer-only legacy OpenAPI survives upgrade (${issuer} issuer)`,
    { timeout: 360_000 },
    Effect.scoped(
      Effect.gen(function* () {
        const target = yield* Target;
        const browser = yield* Browser;
        const mcp = yield* Mcp;
        const runDir = yield* RunDir;
        const { client: makeClient } = yield* Api;
        const legacyImage = process.env.E2E_CIMD_LEGACY_IMAGE;
        const currentImage = process.env.E2E_SELFHOST_DOCKER_IMAGE;
        if (!legacyImage || !currentImage) {
          return yield* Effect.die(
            new Error("Explicit legacy and current Docker images are required"),
          );
        }
        const reboot = (image: string) =>
          Effect.promise(async () => {
            const port = e2ePort("E2E_SELFHOST_DOCKER_PORT", 5);
            await stopSelfhostContainer(port);
            await runSelfhostContainer({
              image,
              port,
              webBaseUrl: target.baseUrl,
              admin: SELFHOST_ADMIN,
              publishPort: true,
            });
          });
        if (issuer === "path" && !process.env.E2E_CIMD_OPENAPI_PATH_URL) {
          return yield* Effect.die(
            new Error("E2E_CIMD_OPENAPI_PATH_URL is required for path-issuer coverage"),
          );
        }
        const baseUrl =
          process.env[issuer === "root" ? "E2E_CIMD_OPENAPI_URL" : "E2E_CIMD_OPENAPI_PATH_URL"] ??
          (yield* createEmulatorInstance("posthog", "cimd-legacy"));
        const emulator = yield* Effect.promise(() => connectEmulator({ baseUrl }));
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            writeFileSync(
              join(runDir, "ledger.json"),
              JSON.stringify(await emulator.ledger.list(), null, 2),
            );
            await emulator.faults.clear();
          }).pipe(Effect.ignore),
        );
        yield* Effect.promise(async () => {
          await emulator.seed({
            users: [{ email: "legacy@example.com", name: "Legacy Test" }],
            projects: [{ id: 1, name: "Legacy Project" }],
          });
          // Use the emulator's real fault control to model an AS-only provider.
          // Authorization, CIMD document fetches, tokens, and API calls stay real.
          await emulator.faults.arm({
            match: { method: "GET", pathPattern: "/.well-known/oauth-protected-resource*" },
            response: { status: 404, body: { error: "not_found" } },
            times: 1000,
          });
        });
        yield* reboot(legacyImage);
        const identity = yield* target.newIdentity();
        const client = yield* makeClient(api, identity);
        const slug = IntegrationSlug.make(`cimd_legacy_${randomBytes(4).toString("hex")}`);
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* client.openapi.removeSpec({ params: { slug } });
            for (const app of yield* client.oauth.listClients()) {
              if (app.tokenUrl.startsWith(`${baseUrl}/`)) {
                yield* client.oauth.removeClient({
                  params: { slug: app.slug },
                  payload: { owner: app.owner },
                });
              }
            }
          }).pipe(Effect.ignore),
        );
        const probe = yield* client.oauth.probe({ payload: { url: baseUrl } });
        expect(probe.clientIdMetadataDocumentSupported).toBe(true);
        expect(probe.resource).toBeNull();
        expect(probe.issuer).toBe(baseUrl);
        yield* client.openapi.addSpec({
          payload: {
            slug,
            name: "Legacy issuer-only OpenAPI",
            spec: { kind: "url", url: emulator.openapiUrl },
          },
        });
        // The old image creates this shape through normal discovery; no stored
        // configuration, OAuth clients, or tokens are fabricated for the upgrade.
        const original = yield* client.openapi.getConfig({ params: { slug } });
        const oauth = original?.authenticationTemplate?.find((method) => method.kind === "oauth2");
        expect(oauth).toMatchObject({
          kind: "oauth2",
          resource: null,
          supportsClientIdMetadataDocument: true,
        });
        expect(oauth).not.toHaveProperty("discoveryUrl");
        writeFileSync(join(runDir, "legacy-config.json"), JSON.stringify(original, null, 2));

        yield* browser.session(identity, async ({ page, step }) => {
          const callProjects = async (connectionName?: string) => {
            const tools = await Effect.runPromise(
              client.tools.list({ query: { integration: slug } }),
            );
            const tool = tools.find(
              (item) =>
                String(item.address).endsWith("projectsList") &&
                (connectionName === undefined || item.connection === connectionName),
            );
            expect(tool).toBeDefined();
            const session = mcp.session(identity);
            let result = await Effect.runPromise(
              session.call("execute", {
                code: `return await ${tool?.address}({});`,
              }),
            );
            for (let i = 0; i < 10 && result.text.includes("executionId:"); i++) {
              result = await Effect.runPromise(session.approvePaused(result.text));
            }
            expect(result.ok, result.text).toBe(true);
            expect(result.text).toContain("Legacy Project");
            const ledger = await emulator.ledger.list();
            expect(
              ledger.some(
                (entry) =>
                  entry.path === "/api/projects/" &&
                  entry.response.status === 200 &&
                  entry.identity.user?.login === "legacy@example.com",
              ),
            ).toBe(true);
          };
          for (const phase of ["legacy", "upgraded"] as const) {
            if (phase === "upgraded") {
              await step("Upgrade the same Docker volume with CIMD still enabled", async () => {
                await Effect.runPromise(reboot(currentImage));
                const restored = await Effect.runPromise(
                  client.openapi.getConfig({ params: { slug } }),
                );
                writeFileSync(
                  join(runDir, "upgraded-config.json"),
                  JSON.stringify(restored, null, 2),
                );
              });
              await emulator.ledger.clear();
              await step("Call projects using the existing connection after upgrade", () =>
                callProjects(),
              );
              writeFileSync(
                join(runDir, "existing-connection-ledger.json"),
                JSON.stringify(await emulator.ledger.list(), null, 2),
              );
            }
            const stored = await Effect.runPromise(client.openapi.getConfig({ params: { slug } }));
            expect(stored?.authenticationTemplate).toEqual(original?.authenticationTemplate);
            await emulator.ledger.clear();
            const before = await Effect.runPromise(
              client.connections.list({ query: { integration: slug } }),
            );
            await step(`Connect with CIMD on the ${phase} image`, async () => {
              await visit(page, `/integrations/${slug}`);
              await page
                .getByRole("button", { name: "Add connection", exact: true })
                .first()
                .click();
              await page.getByRole("tab", { name: /OAuth/ }).click();
              const [popup] = await Promise.all([
                page.waitForEvent("popup"),
                page
                  .getByRole("dialog")
                  .getByRole("button", { name: /^(Connect|Connect with OAuth)$/ })
                  .click(),
              ]);
              await popup
                .getByRole("button", { name: /legacy@example.com/ })
                .waitFor({ timeout: 30_000 });
              expect(new URL(popup.url()).searchParams.get("client_id")).toContain(
                "/api/oauth/client-id-metadata/",
              );
              await Promise.all([
                popup.waitForEvent("close", { timeout: 60_000 }),
                popup.getByRole("button", { name: /legacy@example.com/ }).click(),
              ]);
              await page
                .getByRole("heading", { name: /Add connection/ })
                .waitFor({ state: "hidden", timeout: 60_000 });
            });
            const after = await Effect.runPromise(
              client.connections.list({ query: { integration: slug } }),
            );
            const connection = after.find(
              (item) =>
                !before.some(
                  (previous) => previous.name === item.name && previous.owner === item.owner,
                ),
            );
            expect(connection, "CIMD created a new connection").toBeDefined();
            await step(`Call projects after ${phase} CIMD authorization`, () =>
              callProjects(connection?.name),
            );
            const ledger = await emulator.ledger.list();
            writeFileSync(join(runDir, `${phase}-ledger.json`), JSON.stringify(ledger, null, 2));
            expect(
              ledger.some(
                (entry) =>
                  entry.path === "/oauth/token/" &&
                  entry.method === "POST" &&
                  entry.response.status === 200,
              ),
            ).toBe(true);
            expect(
              ledger.some((entry) => entry.path === "/oauth/register/" && entry.method === "POST"),
            ).toBe(false);
          }
        });
        const recovered = yield* client.openapi.getConfig({ params: { slug } });
        expect(recovered?.authenticationTemplate).toEqual(
          original?.authenticationTemplate?.map((method) =>
            method.kind === "oauth2" ? { ...method, discoveryUrl: new URL(baseUrl).href } : method,
          ),
        );
        writeFileSync(join(runDir, "recovered-config.json"), JSON.stringify(recovered, null, 2));
        // A caller holding the original catalog URL must also work after the
        // migration persisted a better candidate from the spec's servers.
        const reprobe = yield* client.oauth.probe({
          payload: {
            url: original?.specUrl ?? baseUrl,
            integration: slug,
            template: AuthTemplateSlug.make("oauth-DiscoveredOAuth2"),
          },
        });
        expect(reprobe).toMatchObject({ issuer: baseUrl, clientIdMetadataDocumentSupported: true });
        // The API/SDK uses the same recovery and must reject a different endpoint
        // pair, even when a candidate serves valid metadata on the same origin.
        yield* client.openapi.configure({
          params: { slug },
          payload: {
            mode: "replace",
            authenticationTemplate: original?.authenticationTemplate?.flatMap((method) =>
              method.kind === "oauth2" ? [{ ...method, tokenUrl: `${baseUrl}/other/token` }] : [],
            ),
          },
        });
        const rejected = yield* client.oauth
          .probe({
            payload: {
              url: baseUrl,
              integration: slug,
              template: AuthTemplateSlug.make("oauth-DiscoveredOAuth2"),
            },
          })
          .pipe(Effect.result);
        expect(rejected).toMatchObject({ _tag: "Failure", failure: { _tag: "OAuthProbeError" } });
        writeFileSync(
          join(runDir, "probe-validation.json"),
          JSON.stringify({ reprobe, rejected }, null, 2),
        );
        const rejectedConfig = yield* client.openapi.getConfig({ params: { slug } });
        expect(
          rejectedConfig?.authenticationTemplate?.find((method) => method.kind === "oauth2"),
        ).not.toHaveProperty("discoveryUrl");
      }),
    ),
  );
}
