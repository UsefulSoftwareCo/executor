import { randomBytes } from "node:crypto";
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { connectEmulator } from "@executor-js/emulate";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";
import { variable } from "@executor-js/sdk/http-auth";

import { createEmulatorInstance } from "../src/emulator-instance";
import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([openApiHttpPlugin()] as const);
const template = AuthTemplateSlug.make("apiKey");
const name = ConnectionName.make("test");
const authenticationTemplate = [
  {
    slug: template,
    type: "apiKey" as const,
    headers: { authorization: ["Bearer ", variable("token")] },
  },
];
const spec = (baseUrl: string) =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "RPC account health", version: "1" },
    servers: [{ url: baseUrl }],
    paths: {
      "/api/auth.test": {
        post: {
          operationId: "getAccount",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: { "200": { description: "OK" } },
        },
      },
      "/account": {
        delete: { operationId: "deleteAccount", responses: { "204": { description: "Deleted" } } },
      },
    },
  });

scenario(
  "Health checks (UI) · configure and run a POST probe with a warning",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const slug = IntegrationSlug.make(`hc-rpc-${randomBytes(4).toString("hex")}`);
      const baseUrl = yield* createEmulatorInstance("slack", "rpc-health");
      const emulator = yield* Effect.promise(() => connectEmulator({ baseUrl }));
      const credential = yield* Effect.promise(() =>
        emulator.credentials.mint({ type: "bearer-token" }),
      );
      const token = credential.token;
      if (!token) return yield* Effect.die("Emulator did not mint a bearer token");
      const body = { include: { identity: true }, fields: ["user", "team"] };

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            payload: {
              slug,
              baseUrl,
              spec: { kind: "blob", value: spec(baseUrl) },
              authenticationTemplate,
            },
          });
          yield* browser.session(identity, async ({ page, step }) => {
            await step("Choose a POST health check and read its warning", async () => {
              await visit(page, `/integrations/${slug}`);
              await page.getByRole("button", { name: "Set up", exact: true }).click();
              await page
                .getByRole("combobox", { name: "Operation", exact: true })
                .fill("getAccount");
              await page.getByRole("option", { name: /POST.*getAccount/ }).click();
              await page
                .getByRole("alert")
                .filter({ hasText: "POST requests can change data." })
                .waitFor();
            });
            await step("Reject malformed JSON before running or saving", async () => {
              await page.getByRole("textbox", { name: "Request body (JSON)" }).fill('{"include":');
              expect(
                await page.getByRole("button", { name: "Save", exact: true }).isEnabled(),
              ).toBe(false);
              await page.getByText("Enter a valid JSON request body.").waitFor();
            });
            await step("Preview the POST read with a JSON request body", async () => {
              await page
                .getByRole("textbox", { name: "Request body (JSON)" })
                .fill(JSON.stringify(body));
              await page.getByLabel("Test credential", { exact: true }).fill(token);
              await page.getByRole("button", { name: "Preview", exact: true }).click();
              await page.getByText("Healthy", { exact: true }).waitFor();
              await page.getByText("Healthy", { exact: true }).scrollIntoViewIfNeeded();
            });
            await step("Save the health check and reopen its JSON body", async () => {
              await page.getByRole("button", { name: "Save", exact: true }).click();
              await page.locator("#health-check-operation").waitFor({ state: "hidden" });
              await page.reload();
              const section = page.locator("section").filter({
                has: page.getByRole("heading", { name: "Health check", exact: true }),
              });
              await section.getByRole("button", { name: "Edit", exact: true }).click();
              expect(
                JSON.parse(
                  await page.getByRole("textbox", { name: "Request body (JSON)" }).inputValue(),
                ),
              ).toEqual(body);
              await page
                .getByRole("alert")
                .filter({ hasText: "POST requests can change data." })
                .waitFor();
            });
          });
          const saved = yield* client.integrations.healthCheckGet({ params: { slug } });
          expect(saved?.args).toEqual({ body });
          yield* client.connections.create({
            payload: { owner: "org", integration: slug, name, template, value: token },
          });
          const result = yield* client.connections.checkHealth({
            params: { owner: "org", integration: slug, name },
            query: {},
          });
          expect(result.status).toBe("healthy");
          expect(result.httpStatus).toBe(200);
          const requests = yield* Effect.promise(() => emulator.ledger.list());
          const probes = requests.filter((request) => request.path === "/api/auth.test");
          expect(
            probes.length,
            "preview and saved-connection check both reach the upstream",
          ).toBeGreaterThanOrEqual(2);
          for (const probe of probes) {
            expect(probe.method).toBe("POST");
            expect(probe.request.body).toEqual(body);
            expect(probe.response.status).toBe(200);
            expect(probe.response.body).toMatchObject({ ok: true });
            expect(probe.sideEffects).toEqual([]);
          }
        }),
        Effect.gen(function* () {
          yield* client.connections
            .remove({ params: { owner: "org", integration: slug, name } })
            .pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
          yield* Effect.promise(() => emulator.reset());
        }),
      );
    }),
  ),
);

scenario(
  "Health checks (UI) · explain why an unsupported method cannot run",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const slug = IntegrationSlug.make(`hc-refused-${randomBytes(4).toString("hex")}`);
      const baseUrl = "https://example.invalid";
      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            payload: {
              slug,
              baseUrl,
              spec: { kind: "blob", value: spec(baseUrl) },
              authenticationTemplate,
            },
          });
          const candidates = yield* client.integrations.healthCheckCandidates({ params: { slug } });
          const mutation = candidates.find((candidate) => candidate.method === "delete");
          if (!mutation) return yield* Effect.die("Expected an unsupported DELETE operation");
          yield* client.integrations.healthCheckSet({
            params: { slug },
            payload: { spec: { operation: mutation.operation } },
          });
          yield* client.connections.create({
            payload: {
              owner: "org",
              integration: slug,
              name,
              template,
              value: "test-only-credential",
            },
          });
          const result = yield* client.connections.checkHealth({
            params: { owner: "org", integration: slug, name },
            query: {},
          });
          expect(result.status).toBe("unknown");
          expect(result.httpStatus).toBeUndefined();
          expect(result.detail).toContain("not supported for health checks");
          yield* browser.session(identity, async ({ page, step }) => {
            await step("See why the configured health check could not run", async () => {
              await visit(page, `/integrations/${slug}`);
              await page.getByText(result.detail!, { exact: true }).waitFor();
              expect(
                await page.getByText("No health check configured.", { exact: true }).count(),
              ).toBe(0);
            });
            await step("Edit the unsupported operation to see how to fix it", async () => {
              const section = page.locator("section").filter({
                has: page.getByRole("heading", { name: "Health check", exact: true }),
              });
              await section.getByRole("button", { name: "Edit", exact: true }).click();
              await page
                .getByText("This method is not supported for health checks.", { exact: false })
                .waitFor();
              expect(
                await page.getByRole("button", { name: "Save", exact: true }).isEnabled(),
              ).toBe(false);
            });
          });
        }),
        Effect.gen(function* () {
          yield* client.connections
            .remove({ params: { owner: "org", integration: slug, name } })
            .pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
