// Demo recording (AFTER the fix): adding a second connection without typing a
// name derives the same default name as the first — the create is REJECTED
// with the conflict error and the original connection survives untouched.
// Video is the artifact.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

const bearerSpec = (): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Bearer Fixture", version: "1.0.0" },
    servers: [{ url: "https://api.bearerfix.test" }],
    security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    paths: {
      "/ping": { get: { operationId: "ping", responses: { "200": { description: "ok" } } } },
    },
  });

scenario(
  "Connections · a second connection with the default name is rejected, not overwritten",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const browser = yield* Browser;
      const identity = yield* target.newIdentity();
      const apiClient = yield* makeApiClient(api, identity);
      const slug = `dup_name_demo_${randomBytes(4).toString("hex")}`;

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* apiClient.openapi.addSpec({
            payload: { spec: { kind: "blob", value: bearerSpec() }, slug },
          });

          yield* browser.session(identity, async ({ page, step }) => {
            const addConnection = async (key: string) => {
              await page.getByRole("button", { name: "Add connection" }).first().click();
              await page.getByRole("heading", { name: /Add connection/ }).waitFor();
              const dialog = page.getByRole("dialog", { name: /Add connection/ });
              await dialog.locator('input[type="password"]').first().fill(key);
              await dialog.getByRole("button", { name: "Continue" }).click();
              // Leave the display name empty: the default derives the SAME
              // connection name both times.
              await dialog.getByRole("button", { name: "Add connection" }).click();
            };

            await step("Add the first connection with the default name", async () => {
              await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
              await page.getByText("Connections").first().waitFor();
              await addConnection("first-key");
              await page.getByText("Connection added").waitFor();
            });

            await step("Add a second connection, also leaving the name empty", async () => {
              await page.waitForTimeout(1_000); // let the first toast clear
              await addConnection("second-key");
            });

            await step("The duplicate is rejected with the conflict error", async () => {
              await page.getByText(/already exists/).waitFor();
              await page.waitForTimeout(2_000); // hold the error on screen
            });
          });

          const connections = yield* apiClient.connections.list({
            query: { integration: IntegrationSlug.make(slug) },
          });
          expect(connections.length, "the original connection is the only one").toBe(1);
        }),
        apiClient.openapi
          .removeSpec({ params: { slug: IntegrationSlug.make(slug) } })
          .pipe(Effect.ignore),
      );
    }),
  ),
);
