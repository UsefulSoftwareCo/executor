import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([openApiHttpPlugin()] as const);

const spec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Cloudflare admin fixture", version: "1.0.0" },
  servers: [{ url: "https://example.test" }],
  paths: {
    "/ping": {
      get: { operationId: "ping", responses: { "200": { description: "ok" } } },
    },
  },
});

scenario(
  "Cloudflare · an Access admin can choose Workspace for a connection",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const apiClient = yield* client(api, identity);
    const slug = `cf_admin_${randomBytes(4).toString("hex")}`;

    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* apiClient.openapi.addSpec({
          payload: { spec: { kind: "blob", value: spec }, slug },
        });

        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open the test integration", async () => {
            await visit(page, `/integrations/${slug}`);
            await page.getByText("Connections").first().waitFor();
          });

          await step("Open Add connection", async () => {
            await page.getByRole("button", { name: "Add connection" }).first().click();
            await page.getByRole("dialog", { name: /Add connection/ }).waitFor();
          });

          await step("The Access admin can choose Workspace", async () => {
            const dialog = page.getByRole("dialog", { name: /Add connection/ });
            await dialog.getByRole("combobox").click();
            await page.getByRole("option", { name: "Workspace", exact: true }).waitFor();
            expect(
              await page.getByRole("option", { name: "Personal", exact: true }).isVisible(),
              "the personal owner remains available",
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
