// Cross-target (browser): OpenAPI security strategies that require multiple
// API key headers must collect one credential value per header. Cloudflare's
// legacy API key auth is the concrete regression: one OpenAPI security object
// requires both `api_email` and `api_key`, so Add connection must show two
// credential inputs, not one shared token field.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

const cloudflareStyleSpec = (): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Cloudflare Auth Fixture", version: "1.0.0" },
    servers: [{ url: "https://api.cloudflare.test/client/v4" }],
    security: [{ api_email: [], api_key: [] }],
    components: {
      securitySchemes: {
        api_email: { type: "apiKey", in: "header", name: "X-Auth-Email" },
        api_key: { type: "apiKey", in: "header", name: "X-Auth-Key" },
      },
    },
    paths: {
      "/accounts": {
        get: {
          operationId: "listAccounts",
          summary: "List accounts",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });

scenario(
  "OpenAPI · the Cloudflare email and key auth method shows separate credential fields",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const apiClient = yield* makeApiClient(api, identity);
    const slug = `openapi_auth_fields_${randomBytes(4).toString("hex")}`;

    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* apiClient.openapi.addSpec({
          payload: {
            spec: { kind: "blob", value: cloudflareStyleSpec() },
            slug,
          },
        });

        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open the Cloudflare-style integration", async () => {
            await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
            await page.getByText("Connections").first().waitFor();
          });

          await step("Open the add-connection modal", async () => {
            await page.getByRole("button", { name: "Add connection" }).first().click();
            await page.getByRole("dialog", { name: /Add connection/ }).waitFor();
          });

          await step("The legacy Cloudflare method asks for email and key separately", async () => {
            await page.getByRole("tab", { name: "API key (X-Auth-Email)" }).click();
            const dialog = page.getByRole("dialog", { name: /Add connection/ });

            const credentialInputs = dialog.locator('input[type="password"]');
            await dialog.getByPlaceholder("paste X-Auth-Email").waitFor();
            await dialog.getByPlaceholder("paste X-Auth-Key").waitFor();
            expect(
              await credentialInputs.count(),
              "the modal renders one secret input for each required header",
            ).toBe(2);
            expect(
              await dialog.getByPlaceholder("paste X-Auth-Email").isVisible(),
              "email has its own input",
            ).toBe(true);
            expect(
              await dialog.getByPlaceholder("paste X-Auth-Key").isVisible(),
              "API key has its own input",
            ).toBe(true);
          });
        });
      }),
      apiClient.openapi
        .removeSpec({ params: { slug: IntegrationSlug.make(slug) } })
        .pipe(Effect.ignore),
    );
  }),
);
