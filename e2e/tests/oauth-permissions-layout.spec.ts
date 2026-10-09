import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const Setup = Schema.Struct({
  scopes: Schema.Array(Schema.String),
  userScopes: Schema.Array(Schema.String),
});

layer(HostedLive, { excludeTestServices: true })("OAuth permissions", (it) => {
  it.effect(scenarios.oauthPermissionsLayout.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const browser = yield* Browser;
        const issuer = yield* oauthSetupIssuer;
        const scopes = [
          ...Array.from({ length: 100 }, (_, index) => `report_${index}:read`),
          `https://permissions.example.test/${"long_permission_".repeat(12)}:read`,
        ];
        // Slack's user_scope asks for the signed-in user's own token beside the scopes.
        const userScopes = ["users:read", "chat:write"];
        yield* issuer.configure({ scopes });
        const prefix = `/api/organizations/${actors.organization.id}`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Permissions ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service = defineProvider({name: "Permissions fixture", hosts: ${JSON.stringify([new URL(issuer.origin).host])}, auth: {oauth: oauth2({discover: ${JSON.stringify(issuer.origin + "/mcp")}, scopes: ${JSON.stringify(scopes)}, authorizationParams: {user_scope: ${JSON.stringify(userScopes.join(","))}}})}});
export default defineApp({accounts: {service}}, async () => ({tools: router({})}));`,
            },
            appsManifest,
          ],
        });
        expect(response.status).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        // Agents read the same permissions from the setup check before handing over a link.
        const setup = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/providers/${app.requirements.accounts.service.provider}/oauth/oauth/setup`,
        );
        expect(setup.status, JSON.stringify(setup.body)).toBe(200);
        expect(yield* body(Setup, setup)).toEqual({ scopes, userScopes });
        yield* browser.login(actors.owner);
        yield* browser.use("Open the app with many OAuth permissions", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("Choose an account for the app", (page) =>
          page.getByRole("button", { name: "Connect new account", exact: true }).click(),
        );
        yield* browser.use("Wait for advanced connection options", (page) =>
          page.getByText("Advanced", { exact: true }).waitFor({ state: "visible" }),
        );
        // Signing in enters no token, so one line says where the sign-in goes.
        const notice = yield* browser.use("Read where the sign-in goes", (page) => {
          const lines = page.getByRole("dialog").locator("[data-credential-access]");
          return Promise.all([
            lines.evaluateAll((all) =>
              all.map((line) => line.getAttribute("data-credential-access")),
            ),
            lines.first().textContent(),
          ]);
        });
        expect(notice[0]).toEqual(["hidden"]);
        expect(notice[1]).toBe(
          `Your Permissions fixture sign-in is only sent to ${new URL(issuer.origin).host}.`,
        );
        for (const viewport of [
          { width: 1440, height: 900 },
          { width: 390, height: 844 },
          { width: 667, height: 375 },
        ]) {
          yield* browser.use("Set the connection dialog viewport", (page) =>
            page.setViewportSize(viewport),
          );
          yield* browser.use("Permissions start collapsed and Connect stays reachable", (page) => {
            const dialog = page.getByRole("dialog");
            const button = dialog.getByRole("button", {
              name: "Connect Permissions fixture",
              exact: true,
            });
            return dialog
              .getByText("report_0:read", { exact: true })
              .isVisible()
              .then((visible) => {
                expect(visible).toBe(false);
              })
              .then(() => dialog.locator("summary").filter({ hasText: "Advanced" }).textContent())
              .then((text) => {
                expect(text).toContain(
                  `${scopes.length + userScopes.length} permissions requested`,
                );
              })
              .then(() => button.scrollIntoViewIfNeeded())
              .then(() => button.boundingBox())
              .then((bounds) => {
                if (bounds === null) throw new Error("Expected visible Connect button");
                expect(bounds.y).toBeGreaterThanOrEqual(0);
                expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
              });
          });
          yield* browser.checkpoint(`Collapsed permissions ${viewport.width}`);
          yield* browser.use("Expand permissions with the keyboard", (page) => {
            const dialog = page.getByRole("dialog");
            const advanced = dialog.locator("summary").filter({ hasText: "Advanced" });
            const list = page.getByRole("region", { name: "Requested permissions", exact: true });
            return advanced
              .focus()
              .then(() => advanced.press("Enter"))
              .then(() => list.waitFor({ state: "visible" }))
              .then(() => list.locator("code").allTextContents())
              .then((values) => {
                expect(values).toEqual(scopes);
              })
              .then(() =>
                page
                  .getByRole("region", { name: "User token permissions", exact: true })
                  .locator("code")
                  .allTextContents(),
              )
              .then((values) => {
                expect(values).toEqual(userScopes);
              })
              .then(() =>
                list.evaluate((element) => ({
                  height: element.clientHeight,
                  scrollHeight: element.scrollHeight,
                  width: element.clientWidth,
                  scrollWidth: element.scrollWidth,
                })),
              )
              .then((dimensions) => {
                expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.height);
                expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
              })
              .then(() => list.locator("code").last().scrollIntoViewIfNeeded())
              .then(() => list.evaluate((element) => element.scrollTop))
              .then((scrollTop) => {
                expect(scrollTop).toBeGreaterThan(0);
              })
              .then(() => dialog.boundingBox())
              .then((bounds) => {
                if (bounds === null) throw new Error("Expected visible connection dialog");
                expect(bounds.x).toBeGreaterThanOrEqual(0);
                expect(bounds.y).toBeGreaterThanOrEqual(0);
                expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
                expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
              });
          });
          yield* browser.checkpoint(`Expanded permissions ${viewport.width}`);
          yield* browser.use("Collapse permissions without submitting", (page) => {
            const dialog = page.getByRole("dialog");
            const advanced = dialog.locator("summary").filter({ hasText: "Advanced" });
            return advanced
              .focus()
              .then(() => advanced.press("Space"))
              .then(() =>
                page
                  .getByRole("region", { name: "Requested permissions", exact: true })
                  .waitFor({ state: "hidden" }),
              )
              .then(() =>
                dialog
                  .getByRole("button", { name: "Connect Permissions fixture", exact: true })
                  .isVisible(),
              )
              .then((open) => {
                expect(open).toBe(true);
              });
          });
        }
      }),
    ),
  );
});
