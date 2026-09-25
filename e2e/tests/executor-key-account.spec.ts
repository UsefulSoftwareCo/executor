/** Default management keys are ordinary personal accounts bound to one profile per user. */
import { holdTeamInstallation, InstallationDirectory } from "../support/team-installation.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Schema, Schedule } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
const App = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  activeDeployment: Schema.String,
  accounts: Schema.optional(Schema.Never),
});
const Inventory = Schema.Struct({
  apps: Schema.Array(App),
  accounts: Schema.Array(
    Schema.Struct({ id: Schema.String, method: Schema.String, label: Schema.String }),
  ),
});
const Profile = Schema.Struct({
  id: Schema.String,
  revision: Schema.Number,
  accounts: Schema.Struct({ service: Schema.String }),
});
const Identity = Schema.Struct({ organization: Schema.String, role: Schema.String });
layer(HostedLive, { excludeTestServices: true })("Executor API-key account", (it) => {
  it.effect(scenarios.executorAppCardAccount.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const selectedAccounts: string[] = [];
        for (const actor of [actors.owner, actors.admin]) {
          const inventory = yield* api.request(actor, "GET", `${prefix}/inventory`).pipe(
            Effect.flatMap((response) => body(Inventory, response)),
            Effect.repeat({
              schedule: Schedule.spaced("250 millis"),
              until: (data) =>
                data.apps.some((app) => app.name === "Executor") &&
                data.accounts.some((account) => account.method === "apiKey"),
            }),
            Effect.timeout("90 seconds"),
          );
          const app = inventory.apps.find((app) => app.name === "Executor");
          if (app === undefined) return yield* Effect.die("Default Executor app missing");
          expect(app.accounts).toBeUndefined();
          const profiles = yield* body(
            Schema.Array(Profile),
            yield* api.request(actor, "GET", `${prefix}/apps/${app.id}/profiles`),
          );
          const profile = profiles[0];
          if (profile === undefined) return yield* Effect.die("Default profile missing");
          const account = inventory.accounts.find((item) => item.id === profile.accounts.service);
          if (account === undefined) return yield* Effect.die("Managed account missing");
          expect(selectedAccounts).not.toContain(account.id);
          for (const previous of selectedAccounts)
            expect(inventory.accounts.some((item) => item.id === previous)).toBe(false);
          selectedAccounts.push(account.id);

          yield* browser.login(actor);
          yield* browser.use("Open Executor with its default profile", (page) =>
            page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
          );
          yield* browser.use("The Accounts tab shows this user's managed account", (page) =>
            page.getByRole("link", { name: account.label, exact: true }).waitFor(),
          );
          yield* browser.use("Return to the app list", (page) =>
            page.getByRole("link", { name: "Back to apps", exact: true }).click(),
          );
          yield* browser.use("The Executor card is loaded", (page) =>
            page.getByRole("link", { name: "Open Executor", exact: true }).waitFor(),
          );
          yield* browser.checkpoint(`Executor card for ${account.label}`);
          const card = yield* browser.use("The card agrees with the Accounts tab", (page) =>
            page.getByRole("link", { name: "Open Executor", exact: true }).innerText(),
          );
          expect(card).toContain(account.label);
          expect(card).not.toContain("Needs account");
          for (const view of ["available", "managed"]) {
            const directory = yield* body(
              Schema.Struct({
                apps: Schema.Array(Schema.Struct({ app: App, profiles: Schema.Array(Profile) })),
              }),
              yield* api.request(actor, "GET", `${prefix}/resources?view=${view}`),
            );
            const entry = directory.apps.find((entry) => entry.app.id === app.id);
            expect(entry?.app.accounts).toBeUndefined();
            expect(entry?.profiles.map((item) => item.id)).toEqual([profile.id]);
            expect(entry?.profiles[0]?.accounts.service).toBe(account.id);
          }
          yield* Effect.scoped(
            Effect.gen(function* () {
              const profilePath = `${prefix}/apps/${app.id}/profiles/${profile.id}`;
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  const current = yield* body(
                    Schema.Struct({ revision: Schema.Number }),
                    yield* api.request(actor, "GET", profilePath),
                  );
                  expect(
                    (yield* api.request(actor, "PATCH", profilePath, {
                      accounts: profile.accounts,
                      expectedRevision: current.revision,
                    })).status,
                  ).toBe(200);
                }).pipe(Effect.orDie),
              );
              yield* browser.use("Reopen Executor from its card", (page) =>
                page.getByRole("link", { name: "Open Executor", exact: true }).click(),
              );
              yield* browser.use("Open the selected profile's accounts", (page) =>
                page
                  .getByRole("navigation", { name: "App navigation" })
                  .getByRole("link", { name: "Accounts", exact: true })
                  .click(),
              );
              yield* browser.use(
                "Remove the binding without disconnecting the saved account",
                (page) =>
                  page
                    .getByRole("button", { name: `Remove ${account.label}`, exact: true })
                    .click(),
              );
              yield* browser.use("Wait for the confirmed removal", (page) =>
                page
                  .getByRole("link", { name: account.label, exact: true })
                  .waitFor({ state: "hidden" }),
              );
              yield* browser.use("Return to the list after changing the profile", (page) =>
                page.getByRole("link", { name: "Back to apps", exact: true }).click(),
              );
              yield* browser.use("A genuinely missing binding still needs an account", (page) =>
                page
                  .getByRole("link", { name: "Open Executor", exact: true })
                  .getByText("Needs account", { exact: true })
                  .waitFor(),
              );
              yield* browser.checkpoint("Needs account only after removing the profile binding");
            }),
          );
        }
      }),
    ),
  );
  it.effect(scenarios.executorInstallationLoading.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const read = (actor: Session) =>
          api.request(actor, "GET", `${prefix}/inventory`).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.flatMap((response) => body(Inventory, response)),
          );
        // Setup runs without an inventory request. Reads only observe committed progress.
        yield* read(actors.owner).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("250 millis"),
            until: (inventory) =>
              inventory.apps.some((app) => app.name === "Executor") &&
              inventory.accounts.some((account) => account.method === "apiKey"),
          }),
          Effect.timeout("90 seconds"),
        );
        yield* browser.login(actors.owner);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const directory = yield* body(
              InstallationDirectory,
              yield* api.request(actors.owner, "GET", `${prefix}/resources`),
            );
            expect(directory.pendingApp).toBe(false);
            const held = yield* holdTeamInstallation(
              [actors.organization.id, actors.organization.slug].map(
                (reference) => `/api/organizations/${reference}/resources`,
              ),
              directory,
            );
            yield* browser.use("Open Apps during team installation", (page) =>
              page.goto(`/org/${actors.organization.slug}/apps`),
            );
            yield* held.requested;
            yield* browser.use("Missing app has one skeleton while the workflow runs", (page) =>
              page.getByRole("status", { name: "Installing app", exact: true }).waitFor(),
            );
            expect(
              yield* browser.use("The pending app is not a navigable optimistic card", (page) =>
                page.getByRole("link", { name: "Open Executor", exact: true }).count(),
              ),
            ).toBe(0);
            yield* browser.use("Team controls stay available", (page) =>
              page.getByRole("link", { name: "Add app", exact: true }).waitFor(),
            );
            yield* browser.checkpoint("One app skeleton while team installation runs");
            yield* held.stop;
            yield* browser.use("Stopped installation does not leave an endless skeleton", (page) =>
              page.getByRole("heading", { name: "No apps available", exact: true }).waitFor(),
            );
            expect(
              yield* browser.use("No provisioning skeleton after failure", (page) =>
                page.getByRole("status", { name: "Installing app", exact: true }).count(),
              ),
            ).toBe(0);
            yield* held.resume;
            yield* browser.use("Retried installation shows the skeleton again", (page) =>
              page.getByRole("status", { name: "Installing app", exact: true }).waitFor(),
            );
            yield* browser.use("Search is usable during installation", (page) =>
              page.getByRole("textbox", { name: "Search apps…" }).fill("Executor"),
            );
            yield* held.release;
            yield* browser.use("The real app arrives without a reload", (page) =>
              page.getByRole("link", { name: "Open Executor", exact: true }).waitFor(),
            );
            expect(
              yield* browser.use("Search survives background completion", (page) =>
                page.getByRole("textbox", { name: "Search apps…" }).inputValue(),
              ),
            ).toBe("Executor");
            expect(
              yield* browser.use("Completed installation has no skeleton", (page) =>
                page.getByRole("status", { name: "Installing app", exact: true }).count(),
              ),
            ).toBe(0);
            yield* browser.checkpoint("The installed app replaces the skeleton");
          }),
        );
      }),
    ),
  );
  it.effect(scenarios.executorKeyAccount.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const read = (actor: Session) =>
          api.request(actor, "GET", `${prefix}/inventory`).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.flatMap((response) => body(Inventory, response)),
          );
        // Setup runs without an inventory request. Reads only observe committed progress.
        yield* read(actors.owner).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("250 millis"),
            until: (inventory) =>
              inventory.apps.some((app) => app.name === "Executor") &&
              inventory.accounts.some((account) => account.method === "apiKey"),
          }),
          Effect.timeout("90 seconds"),
        );
        yield* read(actors.admin).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("250 millis"),
            until: (inventory) => inventory.accounts.some((account) => account.method === "apiKey"),
          }),
          Effect.timeout("90 seconds"),
        );
        const reads = yield* Effect.forEach([0, 1, 2, 3], () => read(actors.owner), {
          concurrency: 4,
        });
        const initial = reads[0],
          app = initial?.apps.find((app) => app.name === "Executor");
        if (!initial || !app) return yield* Effect.die("Default Executor app missing");
        expect(app.accounts).toBeUndefined();
        const path = `${prefix}/apps/${app.id}`;
        const profile = (actor: Session) =>
          Effect.gen(function* () {
            const rows = yield* body(
              Schema.Array(Profile),
              yield* api.request(actor, "GET", `${path}/profiles`),
            );
            expect(rows).toHaveLength(1);
            const row = rows[0];
            if (!row) return yield* Effect.die("Default profile missing");
            return row;
          });
        const own = yield* profile(actors.owner),
          account = own.accounts.service;
        expect(initial.accounts.find((item) => item.id === account)?.method).toBe("apiKey");
        const nativeKeys = yield* body(
          Schema.Struct({
            apiKeys: Schema.Array(Schema.Struct({ name: Schema.NullOr(Schema.String) })),
          }),
          yield* api.request(actors.owner, "GET", "/api/auth/api-key/list"),
        );
        expect(nativeKeys.apiKeys.filter((key) => key.name === "Executor app")).toHaveLength(1);
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/accounts/${account}`, {
            label: "My Executor key",
          })).status,
        ).toBe(200);
        for (const inventory of yield* Effect.forEach([0, 1, 2, 3], () => read(actors.owner), {
          concurrency: 4,
        })) {
          expect(inventory.apps.find((item) => item.id === app.id)).not.toHaveProperty("accounts");
          expect(
            inventory.accounts.filter((item) => item.method === "apiKey").map((item) => item.id),
          ).toEqual([account]);
          expect(inventory.accounts.find((item) => item.id === account)?.label).toBe(
            "My Executor key",
          );
        }
        expect((yield* profile(actors.owner)).id).toBe(own.id);
        const [adminInventory, admin] = yield* Effect.all(
          [read(actors.admin), profile(actors.admin)],
          { concurrency: 2 },
        );
        expect(admin.id).not.toBe(own.id);
        expect(admin.accounts.service).not.toBe(account);
        expect(adminInventory.accounts.some((item) => item.id === account)).toBe(false);
        const call = (actor: Session, profile: string) =>
          api.request(actor, "POST", `${path}/tools/call`, {
            profile,
            tool: "queries.context_get",
            input: {},
          });
        const [ownerCall, adminCall, deniedCall] = yield* Effect.all(
          [call(actors.owner, own.id), call(actors.admin, admin.id), call(actors.admin, own.id)],
          { concurrency: 3 },
        );
        expect(ownerCall.status, JSON.stringify(ownerCall.body)).toBe(200);
        expect(yield* body(Identity, ownerCall)).toEqual({
          organization: actors.organization.id,
          role: "owner",
        });
        expect(adminCall.status).toBe(200);
        expect(yield* body(Identity, adminCall)).toEqual({
          organization: actors.organization.id,
          role: "admin",
        });
        expect(deniedCall.status).toBe(403);
        const connection = yield* body(
          Schema.Struct({ id: Schema.String }),
          yield* api.request(actors.owner, "POST", `${path}/connections`, {
            profile: own.id,
            requirement: "service",
          }),
        );
        const manual = yield* body(
          Schema.Struct({ id: Schema.String }),
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/submit`,
            {
              method: "apiKey",
              label: "Manual key",
              fields: { token: "synthetic-manual-key", organization: actors.organization.id },
            },
          ),
        );
        yield* read(actors.owner);
        const chosen = yield* profile(actors.owner);
        expect(chosen.accounts.service).toBe(manual.id);
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/profiles/${own.id}`, {
            expectedRevision: chosen.revision,
            accounts: { service: account },
          })).status,
        ).toBe(200);
        expect(
          (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${manual.id}`)).status,
        ).toBe(200);
        const restored = yield* call(actors.owner, own.id);
        expect(restored.status).toBe(200);
        expect(yield* body(Identity, restored)).toEqual({
          organization: actors.organization.id,
          role: "owner",
        });
      }),
    ),
  );
});
