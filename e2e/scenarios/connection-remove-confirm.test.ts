// Cross-target (browser): removing a connection asks for confirmation first.
// Remove is destructive and irreversible (credentials are immutable, so a
// removed connection cannot be restored — only re-created), so the row's
// Remove menu item must open a confirm dialog rather than firing the
// mutation directly. Cancel keeps the connection; confirming removes it for
// real (asserted through the API, not just the list).
import { randomBytes } from "node:crypto";

import { Effect } from "effect";
import { expect } from "@effect/vitest";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

/** Minimal apiKey-authenticated spec — a connection can bind to it; the single
 *  operation is never invoked here. */
const pingSpec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Ping API", version: "1.0.0" },
  paths: {
    "/ping": {
      get: { operationId: "ping", summary: "Ping", responses: { "200": { description: "pong" } } },
    },
  },
});

scenario(
  "Connections (UI) · Remove asks for confirmation; cancel keeps, confirm removes",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(api, identity);

    const slug = IntegrationSlug.make(`rm-confirm-${randomBytes(4).toString("hex")}`);
    const name = ConnectionName.make("main");

    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* client.openapi.addSpec({
          payload: {
            spec: { kind: "blob", value: pingSpec },
            slug,
            baseUrl: "http://127.0.0.1:59999", // never contacted
            authenticationTemplate: [
              {
                slug: "apiKey",
                type: "apiKey",
                headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
              },
            ],
          },
        });
        yield* client.connections.create({
          payload: {
            owner: "org",
            name,
            integration: slug,
            template: AuthTemplateSlug.make("apiKey"),
            value: `key_${randomBytes(8).toString("hex")}`,
          },
        });

        yield* browser.session(identity, async ({ page, step }) => {
          const connections = page.locator("section").filter({
            has: page.getByRole("heading", { level: 3, name: "Connections" }),
          });
          const row = connections.getByText("main", { exact: true });
          const menuTrigger = connections.locator('button[aria-haspopup="menu"]');
          const confirm = page.getByRole("alertdialog");

          await step("Open the integration's connections", async () => {
            await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
            await row.waitFor();
          });

          await step("Remove asks for confirmation instead of firing", async () => {
            await menuTrigger.click();
            await page.getByRole("menuitem", { name: "Remove" }).click();
            await confirm.getByText("Remove main?").waitFor();
          });

          await step("Cancel keeps the connection", async () => {
            await confirm.getByRole("button", { name: "Cancel" }).click();
            await confirm.waitFor({ state: "detached" });
            await row.waitFor();
          });

          await step("Confirming actually removes it", async () => {
            await menuTrigger.click();
            await page.getByRole("menuitem", { name: "Remove" }).click();
            await confirm.getByRole("button", { name: "Remove connection" }).click();
            await confirm.waitFor({ state: "detached" });
            await row.waitFor({ state: "detached" });
          });
        });

        // Cancel left the removal un-fired and confirm fired it for real: the
        // connection is gone from the API, not merely from the rendered list.
        const remaining = yield* client.connections.list({ query: { integration: slug } });
        expect(
          remaining.map((connection) => String(connection.name)),
          "the removed connection is gone from the API",
        ).not.toContain(String(name));
      }),
      Effect.gen(function* () {
        yield* client.connections
          .remove({ params: { owner: "org", integration: slug, name } })
          .pipe(Effect.ignore);
        yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
      }),
    );
  }),
);
