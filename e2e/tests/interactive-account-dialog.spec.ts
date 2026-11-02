/**
 * The Accounts tab's Connect dialog runs an app-owned sign-in: it shows the app's code and link
 * while it waits, takes a pasted address, saves the account the app returns, and confirms before
 * unlinking an app-bound account, which deletes it where the app signed it in.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { Access } from "../support/hosted-app-accounts.ts";
import {
  interactiveAccountBackend,
  interactiveAccountSource,
  interactiveBackendKey,
} from "../support/interactive-account-backend.ts";
import { scenarios } from "../test-plan.ts";

const Links = Schema.Array(
  Schema.Struct({ requirement: Schema.String, account: Schema.Struct({ label: Schema.String }) }),
);
/** The app's own many() requirement for accounts it signs in itself. */
const acquiredSection = (page: Page) =>
  page
    .getByRole("region", { name: "App accounts", exact: true })
    .getByRole("region", { name: "Interactive account (sharedIdentity)", exact: true });
const dialog = (page: Page) => page.getByRole("dialog");
/** Polling finishes the device sign-in on its second status read, a few seconds in. */
const signedIn = { timeout: 30_000 };

layer(HostedLive, { excludeTestServices: true })("Interactive account dialog", (it) => {
  it.effect(scenarios.interactiveAccountDialog.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const backend = yield* interactiveAccountBackend;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Interactive dialog ${randomUUID().slice(0, 8)}`,
          files: [
            { path: "index.ts", content: interactiveAccountSource(backend.origin) },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed),
          path = `${prefix}/apps/${app.id}`;
        const accounts: string[] = [];
        // The app goes first: deleting it releases the accounts linked for everyone.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", path);
            for (const account of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const access = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        // The app reaches its backend with its own key account, linked for everyone.
        const connection = yield* api.request(
          actors.owner,
          "POST",
          `${path}/accounts/app/backend/connections`,
          {},
        );
        expect(connection.status, JSON.stringify(connection.body)).toBe(200);
        const key = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${(yield* body(Resource, connection)).id}/submit`,
          { method: "key", fields: { token: interactiveBackendKey } },
        );
        expect(key.status, JSON.stringify(key.body)).toBe(200);
        accounts.push((yield* body(Resource, key)).id);

        yield* browser.login(actors.owner);
        yield* browser.use("Open the app's accounts", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        const connect = (method: string) =>
          Effect.gen(function* () {
            yield* browser.use(`Connect a new ${method} account`, (page) =>
              acquiredSection(page)
                .getByRole("button", { name: "Connect new account", exact: true })
                .click(),
            );
            yield* browser.use("Open the sign-in methods", (page) =>
              dialog(page).getByRole("combobox").click(),
            );
            yield* browser.use(`Choose ${method}`, (page) =>
              page.getByRole("option", { name: method, exact: true }).click(),
            );
            yield* browser.use(`Start the ${method} sign-in`, (page) =>
              dialog(page)
                .getByRole("button", { name: `Sign in with ${method}`, exact: true })
                .click(),
            );
          });
        /** New accounts are named after they connect; closing the prompt keeps the default. */
        const keepName = Effect.gen(function* () {
          yield* browser.use("The account connected and asks for a name", (page) =>
            page.getByRole("dialog", { name: "Name this account" }).waitFor(signedIn),
          );
          yield* browser.use("Keep the default name", (page) => page.keyboard.press("Escape"));
        });

        // A device sign-in shows the app's code and link, then finishes by itself.
        yield* connect("Device code");
        yield* browser.use("The dialog waits for the device sign-in", (page) =>
          dialog(page)
            .getByText(/Waiting for Device code/)
            .waitFor(),
        );
        const shown = yield* browser.use("Read the device sign-in steps", (page) =>
          Promise.all([
            dialog(page)
              .getByText(/^CODE-\d+$/)
              .textContent(),
            dialog(page).getByRole("link", { name: "Open Device code" }).getAttribute("href"),
          ]),
        );
        expect(shown[0]).toMatch(/^CODE-\d+$/);
        expect(shown[1]).toBe(`${backend.origin}/authorize`);
        yield* browser.checkpoint("Device sign-in waiting");
        yield* evidence.attach(
          "interactive-device-waiting.png",
          "image/png",
          yield* browser.use("Capture the waiting dialog", (page) => page.screenshot()),
        );
        yield* keepName;
        yield* browser.use("The device account is linked for everyone", (page) =>
          acquiredSection(page)
            .getByRole("checkbox", { name: "Synthetic device account", checked: true, exact: true })
            .waitFor(signedIn),
        );

        // A paste sign-in takes the address the browser ended on.
        yield* connect("Paste address");
        yield* browser.use("Paste the final address", (page) =>
          dialog(page)
            .getByLabel("Paste the final address")
            .fill("http://localhost:48765/done?code=synthetic"),
        );
        yield* evidence.attach(
          "interactive-paste.png",
          "image/png",
          yield* browser.use("Capture the paste step", (page) => page.screenshot()),
        );
        yield* browser.use("Send the pasted address", (page) =>
          dialog(page).getByRole("button", { name: "Connect", exact: true }).click(),
        );
        yield* keepName;
        yield* browser.use("The pasted account is linked too", (page) =>
          acquiredSection(page)
            .getByRole("checkbox", { name: "Synthetic pasted account", checked: true, exact: true })
            .waitFor(signedIn),
        );
        yield* evidence.attach(
          "interactive-accounts-linked.png",
          "image/png",
          yield* browser.use("Capture the linked accounts", (page) =>
            page.screenshot({ fullPage: true }),
          ),
        );

        // Clearing an app-bound account asks first, since it deletes the account.
        yield* browser.use("Clear the device account", (page) =>
          acquiredSection(page)
            .getByRole("checkbox", { name: "Synthetic device account", exact: true })
            .click(),
        );
        yield* evidence.attach(
          "interactive-remove-confirm.png",
          "image/png",
          yield* browser.use("Capture the removal confirmation", (page) =>
            page.getByRole("dialog", { name: "Remove Synthetic device account?" }).screenshot(),
          ),
        );
        yield* browser.use("Confirm removing it", (page) =>
          page
            .getByRole("dialog", { name: "Remove Synthetic device account?" })
            .getByRole("button", { name: "Remove account", exact: true })
            .click(),
        );
        yield* browser.use("The confirmation closes once the unlink finished", (page) =>
          page
            .getByRole("dialog", { name: "Remove Synthetic device account?" })
            .waitFor({ state: "detached" }),
        );
        yield* browser.use("The device account is gone", (page) =>
          acquiredSection(page)
            .getByRole("checkbox", { name: "Synthetic device account", exact: true })
            .waitFor({ state: "detached" }),
        );
        // Unlinking deleted it: the account no longer exists for its owner.
        const links = yield* body(
          Links,
          yield* api.request(actors.owner, "GET", `${path}/accounts/app`),
        );
        expect(
          links
            .filter((link) => link.requirement === "sharedIdentity")
            .map((link) => link.account.label),
        ).toEqual(["Synthetic pasted account"]);
        // An app-bound account takes no new credentials; its menu removes it behind the same question.
        yield* browser.use("Open the pasted account's menu", (page) =>
          acquiredSection(page)
            .getByRole("button", { name: "Manage Synthetic pasted account", exact: true })
            .click(),
        );
        expect(
          yield* browser.use("Read the menu", (page) =>
            Promise.all([
              page.getByRole("menuitem", { name: "Update credentials" }).count(),
              page.getByRole("menuitem", { name: "Reconnect" }).count(),
            ]),
          ),
        ).toEqual([0, 0]);
        yield* browser.use("Choose Remove account", (page) =>
          page.getByRole("menuitem", { name: "Remove account…", exact: true }).click(),
        );
        yield* browser.use("Confirm removing the pasted account", (page) =>
          page
            .getByRole("dialog", { name: "Remove Synthetic pasted account?" })
            .getByRole("button", { name: "Remove account", exact: true })
            .click(),
        );
        yield* browser.use("The pasted account is gone", (page) =>
          page
            .getByRole("dialog", { name: "Remove Synthetic pasted account?" })
            .waitFor({ state: "detached" }),
        );
        yield* browser.use("Only the backend account is left", (page) =>
          acquiredSection(page)
            .getByRole("checkbox", { name: "Synthetic pasted account", exact: true })
            .waitFor({ state: "detached" }),
        );

        // A refused sign-in says why, and starting again asks the app for a fresh attempt.
        yield* connect("Failure");
        yield* browser.use("The app's refusal shows", (page) =>
          dialog(page).getByText("Synthetic refusal", { exact: true }).waitFor(signedIn),
        );
        yield* browser.use("Start again", (page) =>
          dialog(page).getByRole("button", { name: "Start again", exact: true }).click(),
        );
        yield* browser.use("The new attempt is refused too", (page) =>
          dialog(page).getByText("Synthetic refusal", { exact: true }).waitFor(signedIn),
        );
        // Switching methods after a refusal cancels it, so the next method starts cleanly.
        yield* browser.use("Open the sign-in methods again", (page) =>
          dialog(page).getByRole("combobox").click(),
        );
        yield* browser.use("Choose Device code", (page) =>
          page.getByRole("option", { name: "Device code", exact: true }).click(),
        );
        yield* browser.use("Start the device sign-in", (page) =>
          dialog(page)
            .getByRole("button", { name: "Sign in with Device code", exact: true })
            .click(),
        );
        yield* keepName;
        yield* browser.use("The new device account is linked", (page) =>
          acquiredSection(page)
            .getByRole("checkbox", { name: "Synthetic device account", checked: true, exact: true })
            .waitFor(signedIn),
        );
        const calls = yield* backend.calls;
        expect(
          calls.filter((call) => call.step === "start" && call.method === "failure"),
        ).toHaveLength(2);
        expect(calls.some((call) => call.step === "cancel" && call.method === "failure")).toBe(
          true,
        );
        expect(calls.filter((call) => call.step === "remove")).toHaveLength(2);
        expect(calls.some((call) => call.step === "submit" && call.method === "paste")).toBe(true);
      }),
    ),
  );
});
