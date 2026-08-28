// The connect deep link: a customer sends an end user a direct link for ONE
// integration ("connect your Linear") instead of pointing them at the dashboard
// to hunt for it. `/connect/<integration slug>` resolves the slug against the
// tenant's catalog and lands the person in the SAME connect flow the
// integration detail page's own button opens.
//
// The slug — not a plugin id — is the stable identity here: it is what a
// customer can write down and template into an email.
//
// Covered:
//   1. Signed in, known slug  → the Add connection flow is open on the right
//      integration, with the auth methods the spec declares
//   2. Unknown slug           → a clear not-found state, not a blank page or a
//      crash (an end user WILL mistype these, and links outlive integrations)
//   3. Already connected      → the deep link shows the existing connection and
//      still offers to add another account
import { randomBytes, randomUUID } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { AccountHttpApi } from "@executor-js/api";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
} from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([openApiHttpPlugin()] as const);

/** OpenAPI 3 spec with a single operation — enough to be a real catalog entry. */
const greetSpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Deep Link API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/greet": {
        get: {
          operationId: "getGreeting",
          summary: "Return a greeting message",
          responses: { "200": { description: "A greeting" } },
        },
      },
    },
  });

scenario(
  "Connect · /connect/<slug> lands an end user in that integration's connect flow",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client } = yield* Api;

    const identity = yield* target.newIdentity();
    const apiClient = yield* client(api, identity);

    // Selfhost shares one bootstrap-admin identity, so a unique slug keeps
    // repeated and parallel runs out of each other's catalogs.
    const slug = `connect-dl-${randomBytes(4).toString("hex")}`;
    const specBaseUrl = "http://127.0.0.1:59999"; // never contacted here

    // Org-scoped hosts canonicalize console URLs onto the active org's slug, so
    // the deep link may legitimately arrive at either `/connect/x` or
    // `/<org>/connect/x`. Read the slug the shell will canonicalize onto.
    const accountClient = yield* client(AccountHttpApi, identity);
    const me = yield* accountClient.account.me();
    const orgSlug = me.organization?.slug ?? null;
    const detailPath = orgSlug ? `/${orgSlug}/integrations/${slug}` : `/integrations/${slug}`;

    yield* Effect.ensuring(
      Effect.gen(function* () {
        const added = yield* apiClient.openapi.addSpec({
          payload: {
            spec: { kind: "blob", value: greetSpec(specBaseUrl) },
            slug,
            name: "Deep Link API",
            baseUrl: specBaseUrl,
            authenticationTemplate: [
              {
                slug: "apiKey",
                type: "apiKey",
                headers: { "x-api-key": [{ type: "variable", name: "token" }] },
              },
            ],
          },
        });
        expect(added.slug, "the integration keeps the requested slug").toBe(slug);

        yield* browser.session(identity, async ({ page, step }) => {
          await step("Open the connect deep link for the seeded integration", async () => {
            await visit(page, `/connect/${slug}`);
            // It forwards into the integration's OWN detail route rather than
            // rendering a parallel connect UI, carrying the add-account handoff.
            await page.waitForURL((url) => url.pathname === detailPath, { timeout: 30_000 });
            expect(new URL(page.url()).searchParams.get("addAccount")).toBe("1");
          });

          await step("The Add connection flow is open for that integration", async () => {
            await page
              .getByRole("heading", { name: /Add connection/ })
              .waitFor({ timeout: 20_000 });
            // The right integration, and the declared auth method is offered —
            // proof it resolved the slug rather than opening a generic dialog.
            await page
              .getByRole("dialog")
              .getByRole("textbox", { name: "x-api-key" })
              .waitFor({ timeout: 20_000 });
          });

          await step("An unknown slug is a clear not-found, not a blank page", async () => {
            await visit(page, "/connect/zz-no-such-integration");
            await page
              .getByText("Unknown integration: zz-no-such-integration")
              .waitFor({ timeout: 30_000 });
            await page.getByRole("link", { name: "Back to integrations" }).waitFor();
          });
        });

        // Already connected: the deep link must show the existing connection
        // and still let the person add another account.
        const providers = yield* apiClient.providers.list();
        expect(providers.length, "a credential provider is available").toBeGreaterThan(0);
        yield* apiClient.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("existing"),
            integration: IntegrationSlug.make(slug),
            template: AuthTemplateSlug.make("apiKey"),
            from: { provider: providers[0]!, id: ProviderItemId.make(randomUUID()) },
          },
        });

        yield* browser.session(identity, async ({ page, step }) => {
          await step("The deep link surfaces the existing connection", async () => {
            await visit(page, `/connect/${slug}`);
            await page.waitForURL((url) => url.pathname === detailPath, { timeout: 30_000 });
            // The connect flow still opens (this link means "connect me"), and
            // the already-saved account is visible behind it.
            await page
              .getByRole("heading", { name: /Add connection/ })
              .waitFor({ timeout: 20_000 });
            await page.keyboard.press("Escape");
            await page.getByText("existing").first().waitFor({ timeout: 20_000 });
          });
        });
      }),
      Effect.gen(function* () {
        yield* apiClient.connections
          .remove({
            params: {
              owner: "org",
              integration: IntegrationSlug.make(slug),
              name: ConnectionName.make("existing"),
            },
          })
          .pipe(Effect.ignore);
        yield* apiClient.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
      }).pipe(Effect.ignore),
    );
  }),
);
