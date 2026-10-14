/** The credential form explains why an app's account check could not verify the entered credentials. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const Check = Schema.Struct({
  status: Schema.String,
  message: Schema.optionalKey(Schema.String),
});

/** Long enough for the host to redact it. */
const missingScope = "synthetic-missing-scope";

layer(HostedLive, { excludeTestServices: true })("Account check failures", (it) => {
  it.effect(scenarios.accountCheckFailureDetail.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        // The check answers without a network by throwing its own message.
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Checks ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `
import { defineApp, defineProvider, object, router, secrets, string } from "apps";
const service = defineProvider({
  name: "Check fixture",
  auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) },
  async health({ account }) {
    throw new Error("403: token " + account.fields.token + " lacks the accounts scope");
  },
});
export default defineApp({ user: { accounts: { service } } }, async () => ({ tools: router({}) }));
`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(
            Effect.map((response) => expect(response.status).toBe(200)),
            Effect.orDie,
          ),
        );

        yield* browser.login(actors.owner);
        yield* browser.use("Open the app's accounts", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("Connect a new account", (page) =>
          page.getByRole("button", { name: "Connect new account", exact: true }).click(),
        );
        const connect = yield* browser.use("The connection dialog opens", (page) => {
          const dialog = page.getByRole("dialog", { name: "Connect Check fixture", exact: true });
          return dialog.waitFor({ state: "visible" }).then(() => dialog);
        });
        const validate = (step: string, token: string) =>
          browser
            .use(step, (page) =>
              connect
                .getByLabel("Token", { exact: true })
                .fill(token)
                .then(() =>
                  Promise.all([
                    page.waitForResponse(
                      (response) =>
                        response.request().method() === "POST" &&
                        new URL(response.url()).pathname.endsWith("/credential-checks"),
                    ),
                    connect.getByRole("button", { name: "Validate API key", exact: true }).click(),
                  ]),
                )
                .then(([response]) => response.json() as Promise<unknown>),
            )
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Check)));
        const verdict = (step: string) =>
          browser.use(step, () => {
            const line = connect.locator('[data-credential-check="check_failed"]');
            // Let the result's fade-in finish so the checkpoint shows the settled form.
            return line
              .waitFor({ state: "visible" })
              .then(() =>
                connect.evaluate((dialog) =>
                  Promise.all(
                    dialog
                      .getAnimations({ subtree: true })
                      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
                      .map((animation) => animation.finished),
                  ),
                ),
              )
              .then(() => line.innerText());
          });

        const explained = yield* validate("Validate a token the app explains", missingScope);
        // The app's own message crosses the runtime with the checked credential replaced.
        expect(explained).toEqual({
          status: "check_failed",
          message: "403: token [redacted] lacks the accounts scope",
        });
        expect(yield* verdict("The form shows the app's explanation")).toBe(
          "Couldn't verify this API key: 403: token [redacted] lacks the accounts scope",
        );
        yield* browser.checkpoint("App explains why the check failed");
        yield* browser.use("Narrow screen", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        yield* browser.checkpoint("App explanation wraps on mobile");

        expect(
          yield* browser.use("Saving stays the user's choice", () =>
            connect.getByRole("button", { name: "Continue anyway", exact: true }).count(),
          ),
        ).toBe(1);
      }),
    ),
  );
});
