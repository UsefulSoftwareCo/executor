// Selfhost-only (browser): the connect modal's API-key credential UX.
//  - the credential field MERGES the placement's lead + prefix as an affix, so
//    it reads as the header value being built ("Authorization: Bearer ▏token");
//  - the "Add authentication method" editor offers placement presets;
//  - a prefix with no trailing space (sent joined to the value) warns, and the
//    warning clears once the space is restored;
//  - a very long pasted key wraps inside the dialog instead of stretching it
//    past the viewport (the preview breaks mid-token, the merged affix
//    truncates).
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

/** Horizontal overflow of the open dialog in px (0 = fits). Infinity when no
 *  dialog is open, so an assertion against it always fails loudly. */
const dialogOverflow = (page: {
  readonly evaluate: <T>(fn: () => T) => Promise<T>;
}): Promise<number> =>
  page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return dialog === null ? Number.POSITIVE_INFINITY : dialog.scrollWidth - dialog.clientWidth;
  });

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

            await step("A long pasted key never widens the dialog", async () => {
              // A key mistakenly pasted into Prefix is the worst case: one
              // unbroken 700-char token rendered into the preview line. The
              // dialog must keep its width (the preview wraps mid-token).
              const longKey = `${"x".repeat(300)}Bearer${"x".repeat(400)}`;
              // The preview line renders only once the placement is named.
              await page.getByPlaceholder("Authorization").first().fill("Authorization");
              await page.getByPlaceholder("Bearer ").first().fill(longKey);
              await page.getByText("Preview").waitFor();
              // ≤ 1px: subpixel rounding can report a fractional scrollWidth.
              expect(
                await dialogOverflow(page),
                "the add-method dialog must not scroll horizontally",
              ).toBeLessThanOrEqual(1);
            });

            await step("The merged affix truncates a long saved prefix", async () => {
              // Saving the method returns to the connect modal with the new
              // method selected; its credential field merges the (700-char)
              // prefix as the affix, which must truncate inside the field.
              await page.getByRole("button", { name: "Add method", exact: true }).click();
              await page.getByRole("heading", { name: /Add connection/ }).waitFor();
              await page.getByText("Authorization: x").first().waitFor();
              expect(
                await dialogOverflow(page),
                "the connect modal must not scroll horizontally",
              ).toBeLessThanOrEqual(1);
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
