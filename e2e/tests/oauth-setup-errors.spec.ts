import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const Failure = Schema.Struct({
  _tag: Schema.Literal("OAuthSetupFailed"),
  reason: Schema.String,
});

layer(HostedLive, { excludeTestServices: true })("OAuth setup errors", (it) => {
  it.effect(scenarios.oauthSetupErrors.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Connection error examples",
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2 } from "apps";
const service=defineProvider({name:"Sample service",auth:{oauth:oauth2({discover:${JSON.stringify(issuer.origin + "/mcp")}})}});
export default defineApp({accounts:{service}},async()=>({queries:{}}));`,
            },
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.owner);
        yield* browser.use("Use the product dark theme", (page) =>
          page.emulateMedia({ colorScheme: "dark" }),
        );
        for (const [discovery, reason, title, nextStep, retryable] of [
          [
            "no-oauth",
            "discovery_missing",
            "OAuth settings not found",
            "Check the app’s server URL and sign-in method.",
            false,
          ],
          [
            "missing",
            "discovery_missing",
            "OAuth settings not found",
            "Check the app’s server URL and sign-in method.",
            false,
          ],
          [
            "invalid-json",
            "discovery_invalid",
            "OAuth settings not valid",
            "Check the app’s OAuth server URL and configuration.",
            false,
          ],
          [
            "invalid-metadata",
            "discovery_invalid",
            "OAuth settings not valid",
            "Check the app’s OAuth server URL and configuration.",
            false,
          ],
          [
            "blocked",
            "discovery_blocked",
            "OAuth address blocked",
            "Review the app’s server URL and this instance’s network policy.",
            false,
          ],
          [
            "unavailable",
            "discovery_unavailable",
            "The connected service’s sign-in is unavailable",
            "Try again.",
            true,
          ],
        ] as const) {
          yield* issuer.configure({ discovery });
          const response = yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/providers/${app.requirements.accounts.service.provider}/oauth/oauth/setup`,
          );
          expect(response.status).toBe(422);
          expect((yield* body(Failure, response)).reason).toBe(reason);
          yield* browser.use(`Open account setup with ${discovery} metadata`, (page) =>
            page
              .goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`)
              .then(() =>
                page
                  .getByRole("button", { name: "Add Sample service account", exact: true })
                  .click(),
              )
              .then(() => page.getByRole("alert").getByText(title, { exact: true }).waitFor())
              .then(() => page.getByLabel("Account name", { exact: true }).fill("Work reports")),
          );
          expect(
            yield* browser.use("Retry follows the cause", (page) =>
              page.getByRole("button", { name: "Try again", exact: true }).count(),
            ),
          ).toBe(retryable ? 1 : 0);
          const text = yield* browser.use("Read the error without opening anything", (page) =>
            page.getByRole("alert").innerText(),
          );
          expect(text).toContain(nextStep);
          expect(text).not.toContain("No account credentials were changed");
          expect(text).toContain("OAuthSetupFailed");
          expect(text).not.toContain("PRIVATE_UPSTREAM_DIAGNOSTIC");
          expect(text).not.toContain(issuer.origin);
          expect(text).not.toContain("blocked.internal");
          expect(
            yield* browser.use("Recovery is not behind a Details control", (page) =>
              page.getByRole("button", { name: "Error details", exact: true }).count(),
            ),
          ).toBe(0);
          yield* browser.checkpoint(`OAuth-${discovery}-card-desktop`);
          if (discovery === "missing") {
            const copied = yield* browser.use("Copy a safe fix prompt for an agent", (page) =>
              page
                .context()
                .grantPermissions(["clipboard-read", "clipboard-write"])
                .then(() =>
                  page
                    .getByRole("button", { name: "Copy fix prompt", exact: true })
                    .focus()
                    .then(() => page.keyboard.press("Enter")),
                )
                .then(() => page.evaluate(() => navigator.clipboard.readText())),
            );
            expect(copied).toContain("OAuthSetupFailed");
            expect(copied).toContain("Diagnose and fix this problem in Executor");
            expect(copied).toContain("provider definition");
            expect(copied).toContain(
              "Do not disable authentication just because OAuth metadata is missing",
            );
            expect(copied).toContain("Verify the failed operation");
            expect(copied).not.toContain("Copy fix prompt");
            expect(copied).not.toContain("PRIVATE_UPSTREAM_DIAGNOSTIC");
            expect(copied).not.toContain("with its author");
            expect(copied).not.toContain(issuer.origin);
            expect(copied).not.toContain("Work reports");
            yield* browser.use("Review the full error card on mobile", (page) =>
              page.setViewportSize({ width: 390, height: 844 }),
            );
            yield* browser.use("The error card fits the mobile viewport", (page) => {
              const details = page.getByRole("alert", { name: title, exact: true });
              return details
                .evaluate(() =>
                  Promise.allSettled(
                    document.getAnimations().map((animation) => animation.finished),
                  ),
                )
                .then(() => details.scrollIntoViewIfNeeded())
                .then(() => details.boundingBox())
                .then((bounds) => {
                  expect(bounds).not.toBeNull();
                  if (bounds === null) throw new Error("The full error card must be visible");
                  expect(bounds.x).toBeGreaterThanOrEqual(0);
                  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
                  expect(bounds.y).toBeGreaterThanOrEqual(0);
                  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
                });
            });
            yield* browser.checkpoint("OAuth-missing-card-mobile");
            yield* browser.use("Restore desktop", (page) =>
              page.setViewportSize({ width: 1440, height: 960 }),
            );
          }
          expect(
            yield* browser.use("Reading the error preserves the form", (page) =>
              page.getByLabel("Account name", { exact: true }).inputValue(),
            ),
          ).toBe("Work reports");
        }
        yield* issuer.configure({ discovery: "available" });
        yield* browser.use("Retry recovers through the real setup endpoint", (page) =>
          page
            .getByRole("button", { name: "Try again", exact: true })
            .click()
            .then(() =>
              page.getByRole("button", { name: "Connect Sample service", exact: true }).waitFor(),
            )
            .then(() => page.getByRole("alert").waitFor({ state: "hidden" })),
        );
        expect(
          yield* browser.use("Retry preserves the name", (page) =>
            page.getByLabel("Account name", { exact: true }).inputValue(),
          ),
        ).toBe("Work reports");
        expect((yield* issuer.metrics).registrations).toBe(0);
        yield* browser.checkpoint("OAuth-setup-recovered");
      }),
    ),
  );
});
