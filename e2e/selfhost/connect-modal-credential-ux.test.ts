// Selfhost-only (browser): the connect modal's API-key credential UX.
//  - the credential field MERGES the placement's lead + prefix as an affix, so
//    it reads as the header value being built ("Authorization: Bearer ▏token");
//  - the "Add authentication method" editor offers placement presets;
//  - a prefix with no trailing space (sent joined to the value) warns, and the
//    warning clears once the space is restored.
// Video is the artifact.
import { randomBytes } from "node:crypto";

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
  "Connect modal · API key credential UX: merged affix, add-method, prefix warning",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const browser = yield* Browser;
      const identity = yield* target.newIdentity();
      const apiClient = yield* makeApiClient(api, identity);
      const slug = `connect_ux_${randomBytes(4).toString("hex")}`;

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* apiClient.openapi.addSpec({
            payload: { spec: { kind: "blob", value: bearerSpec() }, slug },
          });

          yield* browser.session(identity, async ({ page, step }) => {
            await step("Open the connect modal", async () => {
              await page.goto(`/integrations/${slug}?addAccount=1`, { waitUntil: "networkidle" });
              await page.getByRole("heading", { name: /Add connection/ }).waitFor();
            });

            await step("The credential field merges the placement prefix", async () => {
              // The placement's lead + prefix renders as a non-editable affix
              // inside the field, so there is no separate preview line.
              await page.getByText("Authorization: Bearer").first().waitFor();
            });

            await step("The add-method editor offers placement presets", async () => {
              await page.getByRole("button", { name: "Add authentication method" }).click();
              await page.getByRole("heading", { name: "Add authentication method" }).waitFor();
              await page.getByRole("button", { name: "Bearer header" }).waitFor();
              await page.getByRole("button", { name: "API key query" }).waitFor();
            });

            await step("A prefix with no trailing space warns", async () => {
              await page.getByPlaceholder("Bearer ").first().fill("Bearer");
              await page.getByText("Prefix has no trailing space").waitFor();
            });

            await step("Restoring the trailing space clears the warning", async () => {
              await page.getByPlaceholder("Bearer ").first().fill("Bearer ");
              await page.getByText("Prefix has no trailing space").waitFor({ state: "detached" });
            });
          });
        }),
        apiClient.openapi
          .removeSpec({ params: { slug: IntegrationSlug.make(slug) } })
          .pipe(Effect.ignore),
      );
    }),
  ),
);
