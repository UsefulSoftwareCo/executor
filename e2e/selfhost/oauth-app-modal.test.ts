// Selfhost (browser): a registered OAuth app is managed entirely from the
// Add-connection modal — there is no separate "OAuth apps" page. The user
// registers a bring-your-own app for an integration, edits its stored client
// id, and removes it, all from the OAuth app picker inside the modal.
//
// The integration only needs to DECLARE an OAuth method for the picker to show;
// registering/editing/removing an app touches stored credentials only and never
// calls the authorization/token endpoints, so a static issuer is enough and no
// OAuth provider is started.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

/** Minimal OpenAPI 3 spec — one operation, server never contacted. */
const greetSpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "OAuth Modal API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/greet": {
        get: {
          operationId: "getGreeting",
          summary: "Return a greeting",
          responses: { "200": { description: "A greeting" } },
        },
      },
    },
  });

scenario(
  "OAuth apps · a registered app is edited and removed from the connect modal",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);

    // Selfhost shares the bootstrap-admin identity, so prefix every resource
    // with a per-run id to stay out of parallel/repeated runs' way.
    const id = randomBytes(4).toString("hex");
    const integration = `oauth-modal-scn-${id}`;
    const appName = `oauthmodalapp${id}`; // lowercase+digits → slug === appName
    // The picker humanizes the slug for display ("oauthmodalappab12" →
    // "Oauthmodalappab12"); used to assert the row is gone after removal.
    const appDisplayName = appName.charAt(0).toUpperCase() + appName.slice(1);
    const specBaseUrl = "http://127.0.0.1:59998"; // never contacted

    // Stand up an integration that declares a bring-your-own OAuth2 method.
    // The endpoints are inert — app management never calls them.
    yield* client.openapi.addSpec({
      payload: {
        spec: { kind: "blob", value: greetSpec(specBaseUrl) },
        slug: integration,
        baseUrl: specBaseUrl,
        authenticationTemplate: [
          {
            slug: "oauth",
            kind: "oauth2",
            authorizationUrl: "https://auth.example/authorize",
            tokenUrl: "https://auth.example/token",
            scopes: [],
          },
        ],
      },
    });

    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* browser.session(identity, async ({ page, step }) => {
          const actions = page.getByRole("button", { name: `Actions for ${appName}` });

          await step("Open the integration and start a new connection", async () => {
            await page.goto(`/integrations/${integration}`, { waitUntil: "networkidle" });
            await page.getByRole("button", { name: "Add connection" }).click();
            // OAuth2 is the integration's only method, so the modal opens on
            // the OAuth app step with nothing registered yet. (`exact` avoids
            // the "Register app for help" tooltip button in the form.)
            await page.getByRole("button", { name: "Register app", exact: true }).waitFor();
          });

          await step("Register a bring-your-own OAuth app", async () => {
            await page.getByRole("button", { name: "Register app", exact: true }).click();
            await page.locator("#oauth-app-name").fill(appName);
            await page.locator("#oauth-client-id").fill("client-one");
            await page.locator("#oauth-client-secret").fill("secret-one");
            await page.getByRole("button", { name: "Register app", exact: true }).click();
            // Back on the picker, the new app is selectable AND manageable —
            // the per-app actions menu is what replaced the old apps page.
            await actions.waitFor();
          });

          await step("Edit opens the app prefilled with its stored client id", async () => {
            await actions.click();
            await page.getByRole("menuitem", { name: "Edit" }).click();
            await page.getByText(`Edit ${appName}`).waitFor();
            expect(
              await page.locator("#oauth-client-id").inputValue(),
              "the edit form prefills the stored client id",
            ).toBe("client-one");
          });

          await step("Change the client id and save the edit", async () => {
            await page.locator("#oauth-client-id").fill("client-two");
            await page.locator("#oauth-client-secret").fill("secret-two");
            await page.getByRole("button", { name: "Register app", exact: true }).click();
            await actions.waitFor();
          });

          await step("Reopening the app shows the saved client id", async () => {
            await actions.click();
            await page.getByRole("menuitem", { name: "Edit" }).click();
            await page.getByText(`Edit ${appName}`).waitFor();
            expect(
              await page.locator("#oauth-client-id").inputValue(),
              "the edit persisted to the saved app",
            ).toBe("client-two");
            await page.getByRole("button", { name: "Cancel" }).click();
            await actions.waitFor();
          });

          await step("Remove the app and confirm", async () => {
            await actions.click();
            await page.getByRole("menuitem", { name: "Remove" }).click();
            await page.getByRole("button", { name: "Remove app" }).click();
            // The row (and its actions menu) is gone from the picker, and the
            // empty-state register CTA is back — no app left for this method.
            await actions.waitFor({ state: "detached" });
            await page.getByRole("button", { name: "Register app", exact: true }).waitFor();
            // Scope to the modal so the "Removed …" success toast (which
            // echoes the slug) doesn't count as a lingering picker row.
            expect(
              await page.getByRole("dialog").getByText(appDisplayName).count(),
              "the removed app no longer appears in the picker",
            ).toBe(0);
          });
        });

        // The removal is real, not just visual: the app is gone from the API
        // (asserted before the finalizer, which would also remove it).
        const remaining = yield* client.oauth.listClients();
        expect(
          remaining.map((c) => String(c.slug)),
          "the removed app is gone from the OAuth client catalog",
        ).not.toContain(appName);
      }),
      // Finalizer: never leak the integration or a half-removed app into the
      // shared selfhost instance, even if a step above failed mid-flow.
      Effect.gen(function* () {
        const clients = yield* client.oauth.listClients().pipe(Effect.orElseSucceed(() => []));
        for (const c of clients) {
          if (String(c.slug) === appName) {
            yield* client.oauth
              .removeClient({ params: { slug: c.slug }, payload: { owner: c.owner } })
              .pipe(Effect.ignore);
          }
        }
        yield* client.openapi.removeSpec({ params: { slug: integration } }).pipe(Effect.ignore);
      }),
    );
  }),
);
