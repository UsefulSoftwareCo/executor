import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { accessBeforeConnect, formOrder } from "../support/oauth-client-form.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const Failure = Schema.Struct({
  _tag: Schema.Literal("OAuthSetupFailed"),
  reason: Schema.String,
  retryAfter: Schema.optional(Schema.String),
});
/** A rate limiter's Retry-After as an HTTP date, and how the form words it. */
const retryAfter = "Wed, 21 Oct 2099 07:28:00 GMT";
const retryAt = "Try again after 07:28 UTC on 21 Oct 2099.";

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
              content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Sample service",auth:{oauth:oauth2({discover:${JSON.stringify(issuer.origin + "/mcp")}})}});
export default defineApp({accounts:{service}},async()=>({tools: router({})}));`,
            },
            appsManifest,
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
        yield* issuer.configure({ retryAfter });
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
          // Executor reached the service, which is limiting requests: not an outage.
          ["rate-limited", "rate_limited", "Service rate limit reached", retryAt, true],
          [
            "unavailable",
            "service_unavailable",
            "The connected service’s sign-in is unavailable",
            "Try again in a moment, or check the service’s status if this continues.",
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
          const failure = yield* body(Failure, response);
          expect(failure.reason).toBe(reason);
          expect(failure.retryAfter).toBe(
            reason === "rate_limited" ? "2099-10-21T07:28:00.000Z" : undefined,
          );
          // The page responds to input once hydrated; the harness waits between steps.
          yield* browser.use(`Open account setup with ${discovery} metadata`, (page) =>
            page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
          );
          yield* browser.use("Add an account", (page) =>
            page
              .getByRole("button", { name: "Connect new account", exact: true })
              .click()
              .then(() => page.getByRole("alert").getByText(title, { exact: true }).waitFor()),
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
            yield* browser.use("Reading the error keeps the connection form open", (page) =>
              page.getByRole("dialog").getByRole("alert", { name: title, exact: true }).count(),
            ),
          ).toBe(1);
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
        expect((yield* issuer.metrics).registrations).toBe(0);
        yield* browser.checkpoint("OAuth-setup-recovered");
        // Registration failures are split by who can act. Services that refuse Executor
        // open manual client entry; an unusable 2xx response is Executor's problem. A refusal
        // says once, in the reason's own words, what happened and what to do, with the
        // service's own error inline.
        const refusal = "Redirect URIs must be on a host this service has approved";
        for (const [name, registration, title, explanation, clientEntry, response] of [
          [
            "not-approved",
            { registrationStatus: 400, registrationError: "invalid_redirect_uri" },
            "Callback URL refused during registration",
            [
              "This service doesn’t accept Executor’s callback URL.",
              "Create an OAuth app there with this redirect URL and enter its client ID and secret, or ask the service to allow it.",
            ],
            true,
            `invalid_redirect_uri: ${refusal}`,
          ],
          [
            "protected",
            { registrationStatus: 401 },
            "Automatic registration not allowed",
            [
              "This service only accepts OAuth apps created in its developer settings.",
              "Create an OAuth app there with this redirect URL, then enter its client ID and secret.",
            ],
            true,
            `invalid_client: ${refusal}`,
          ],
          [
            "metadata-refused",
            { registrationStatus: 400, registrationError: "invalid_client_metadata" },
            "Service did not accept Executor’s callback URL",
            [
              "Executor’s callback URL is most likely not among the service’s allowed redirect URIs.",
              "Ask the service’s administrator to allow it, or create an OAuth app there and enter its client ID and secret.",
            ],
            true,
            `invalid_client_metadata: ${refusal}`,
          ],
          [
            "rejected",
            { registrationStatus: 400, registrationError: "invalid_request" },
            "Service rejected Executor’s registration",
            [
              "Without an OAuth client for this service, Executor can’t start sign-in.",
              "Create an OAuth app there with this redirect URL and enter its client ID and secret, or copy the fix prompt to investigate.",
            ],
            true,
            `invalid_request: ${refusal}`,
          ],
          [
            "incompatible",
            { registrationStatus: 200, malformedRegistration: true },
            "Executor could not use the service’s response",
            ["Retrying won’t help until Executor is fixed."],
            false,
            undefined,
          ],
          // A rate limiter's HTML page: Executor reached the service, which says when to retry.
          [
            "rate-limited",
            { registrationStatus: 429 },
            "Service rate limit reached",
            ["The service asked Executor to wait before sending more sign-in requests.", retryAt],
            false,
            "429 Too Many Requests 429 Too Many Requests synthetic-edge",
          ],
        ] as const) {
          yield* issuer.configure({
            malformedRegistration: false,
            registrationErrorDescription: refusal,
            ...registration,
          });
          // The page responds to input once hydrated; the harness waits between steps.
          yield* browser.use(`Start sign-in when registration is ${name}`, (page) =>
            page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
          );
          yield* browser.use("Add an account", (page) =>
            page
              .getByRole("button", { name: "Connect new account", exact: true })
              .click()
              .then(() =>
                page.getByRole("button", { name: "Connect Sample service", exact: true }).click(),
              )
              .then(() => page.getByRole("alert").getByText(title, { exact: true }).waitFor()),
          );
          const text = yield* browser.use("Read the registration error", (page) =>
            page.getByRole("alert").innerText(),
          );
          for (const sentence of explanation) expect(text).toContain(sentence);
          expect(text).not.toContain("PRIVATE_UPSTREAM_DIAGNOSTIC");
          // The error code is for agents: the fix prompt keeps it, the form does not show it.
          expect(text).not.toContain("OAuthSetupFailed");
          if (response === undefined) expect(text).not.toContain("Service response");
          else {
            expect(text).toContain(`Service response: ${response}`);
            // A short response is shown whole, with nothing to expand.
            expect(
              yield* browser.use("The service response is not cut short", (page) =>
                page.getByRole("button", { name: "Show full service response" }).count(),
              ),
            ).toBe(0);
          }
          // Client entry shows the callback URL once, in its own form field.
          expect(text).not.toContain("/api/oauth/callback");
          // The failure's recovery is the form's one next step: its helper line is not shown.
          expect(
            yield* browser.use("The steps are given once, with what happened", (page) => {
              const dialog = page.getByRole("dialog");
              return Promise.all([
                dialog.getByText("Create an OAuth app", { exact: false }).count(),
                dialog.getByText("enter its client ID", { exact: false }).count(),
                dialog.getByText("Use an OAuth app in", { exact: false }).count(),
              ]);
            }),
          ).toEqual([clientEntry ? 1 : 0, clientEntry ? 1 : 0, 0]);
          const order = yield* browser.use("Read the form top to bottom", (page) => {
            const dialog = page.getByRole("dialog");
            return formOrder({
              notice: dialog.getByRole("alert", { name: title, exact: true }),
              ...(clientEntry
                ? {
                    redirect: dialog.getByRole("button", {
                      name: "Copy redirect URL",
                      exact: true,
                    }),
                    clientId: dialog.getByLabel("Client ID", { exact: true }),
                    clientSecret: dialog.getByLabel("Client secret", { exact: true }),
                  }
                : {}),
              access: dialog.locator("[data-credential-access]"),
              connect: dialog.getByRole("button", { name: "Connect Sample service", exact: true }),
            });
          });
          expect(order).toEqual(
            clientEntry
              ? ["notice", "redirect", "clientId", "clientSecret", "access", "connect"]
              : ["notice", "access", "connect"],
          );
          expect(
            yield* browser.use("Where the sign-in goes is said just above Connect", (page) =>
              accessBeforeConnect(page.getByRole("dialog")),
            ),
          ).toBe(true);
          expect(
            yield* browser.use("Client entry follows the cause", (page) =>
              page.getByRole("dialog").getByLabel("Client ID", { exact: true }).count(),
            ),
          ).toBe(clientEntry ? 1 : 0);
          expect(
            yield* browser.use("Self-host does not claim a failure was tracked", (page) =>
              page.getByText("We’ve tracked this automatically", { exact: false }).count(),
            ),
          ).toBe(0);
          if (name === "rate-limited") {
            expect(text).not.toContain("couldn’t reach");
            // Nothing in the app or its client needs fixing, so there is no fix prompt.
            expect(
              yield* browser.use("A rate limit offers no fix prompt", (page) =>
                page
                  .getByRole("dialog")
                  .getByRole("button", { name: "Copy fix prompt", exact: true })
                  .count(),
              ),
            ).toBe(0);
          }
          if (name === "rejected") {
            const copied = yield* browser.use(
              "The fix prompt keeps the code and response",
              (page) =>
                page
                  .context()
                  .grantPermissions(["clipboard-read", "clipboard-write"])
                  .then(() =>
                    page.getByRole("button", { name: "Copy fix prompt", exact: true }).click(),
                  )
                  .then(() => page.evaluate(() => navigator.clipboard.readText())),
            );
            expect(copied).toContain("OAuthSetupFailed");
            expect(copied).toContain(`Service response: ${response}`);
          }
          yield* browser.checkpoint(`OAuth-registration-${name}-desktop`);
        }
        // Without registration, client entry is the only way to connect, and nothing failed.
        const steps =
          "Create an OAuth app there with this redirect URL, then enter its client ID and secret.";
        yield* issuer.configure({ registration: false, registrationStatus: 201 });
        yield* browser.use("Open a service without automatic registration", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("Add an account", (page) =>
          page
            .getByRole("button", { name: "Connect new account", exact: true })
            .click()
            .then(() => page.getByLabel("Client secret", { exact: true }).waitFor()),
        );
        const required = yield* browser.use("Read the client-required form", (page) => {
          const dialog = page.getByRole("dialog");
          return Promise.all([
            dialog.getByRole("alert").count(),
            formOrder({
              guidance: dialog.getByText(
                `Executor can’t set up sign-in for Sample service automatically. ${steps}`,
                { exact: true },
              ),
              redirect: dialog.getByRole("button", { name: "Copy redirect URL", exact: true }),
              clientId: dialog.getByLabel("Client ID", { exact: true }),
              clientSecret: dialog.getByLabel("Client secret", { exact: true }),
              access: dialog.locator("[data-credential-access]"),
              connect: dialog.getByRole("button", { name: "Connect Sample service", exact: true }),
            }),
            accessBeforeConnect(dialog),
          ]);
        });
        expect(required).toEqual([
          0,
          ["guidance", "redirect", "clientId", "clientSecret", "access", "connect"],
          true,
        ]);
        yield* browser.checkpoint("OAuth-client-required-desktop");
      }),
    ),
  );
});
