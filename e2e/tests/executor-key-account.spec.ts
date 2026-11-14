/** Default management keys are ordinary personal accounts each user links to the common app. */
import { holdTeamInstallation, InstallationDirectory } from "../support/team-installation.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Schema, Schedule } from "effect";
import type { Page } from "playwright";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import {
  connectionsPath,
  linkAccount,
  linkAccountResponse,
  linkedAccountIds,
  unlinkAccount,
} from "../support/app-accounts.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";
import { managementApp } from "../support/management-app.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { Resource } from "../support/contracts.ts";
import { randomUUID } from "node:crypto";
import { serverControl } from "../support/server-control.ts";
import { openThroughBrowser } from "../support/in-app-navigation.ts";
import { advanceToReconciliation, installBrowserClock } from "../support/query-transition.ts";
const App = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  activeVersion: Schema.String,
  accounts: Schema.optional(Schema.Never),
});
const Inventory = Schema.Struct({
  apps: Schema.Array(App),
  links: Schema.Array(Schema.Struct({ app: Schema.String, account: Schema.String })),
  accounts: Schema.Array(
    Schema.Struct({ id: Schema.String, method: Schema.String, label: Schema.String }),
  ),
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
          const appPath = `${prefix}/apps/${app.id}`;
          const linked = yield* linkedAccountIds(actor, appPath);
          expect(linked).toHaveLength(1);
          expect(inventory.links.filter((link) => link.app === app.id)).toEqual([
            { app: app.id, account: linked[0] },
          ]);
          const account = inventory.accounts.find((item) => item.id === linked[0]);
          if (account === undefined) return yield* Effect.die("Managed account missing");
          expect(selectedAccounts).not.toContain(account.id);
          for (const previous of selectedAccounts)
            expect(inventory.accounts.some((item) => item.id === previous)).toBe(false);
          selectedAccounts.push(account.id);

          yield* browser.login(actor);
          yield* browser.use("Open Executor's accounts", (page) =>
            page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
          );
          yield* browser.use("The Accounts tab shows this user's linked managed account", (page) =>
            page
              .getByRole("list", { name: "Executor accounts", exact: true })
              .getByRole("radio", { name: account.label, exact: true, checked: true })
              .waitFor(),
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
          // Add app knows the default app is installed, so its Executor row offers Open, not Add.
          yield* browser.use("Open Add app", (page) =>
            page.goto(`/org/${actors.organization.slug}/apps/add`),
          );
          const executorRow = (page: Page) =>
            page.locator(".catalog-row", {
              has: page.getByText("Executor", { exact: true }),
            });
          yield* browser.use("The Executor row offers Open", (page) =>
            executorRow(page).getByRole("link", { name: "Open", exact: true }).waitFor(),
          );
          expect(
            yield* browser.use("The Executor row offers no Add", (page) =>
              executorRow(page).getByRole("button", { name: "Add Executor", exact: true }).count(),
            ),
          ).toBe(0);
          yield* browser.checkpoint(`Add app shows Executor installed for ${account.label}`);
          yield* browser.use("Open Executor from Add app", (page) =>
            executorRow(page).getByRole("link", { name: "Open", exact: true }).click(),
          );
          yield* browser.use("Open leads to the default app", (page) =>
            page.waitForURL(`**/apps/${app.id}?view=accounts`),
          );
          yield* browser.use("Return to the app list again", (page) =>
            page.getByRole("link", { name: "Back to apps", exact: true }).click(),
          );
          yield* browser.use("The Executor card is loaded again", (page) =>
            page.getByRole("link", { name: "Open Executor", exact: true }).waitFor(),
          );
          for (const view of ["available", "managed"]) {
            const directory = yield* body(
              Schema.Struct({
                apps: Schema.Array(
                  Schema.Struct({ app: App, linkedAccounts: Schema.Array(Schema.String) }),
                ),
              }),
              yield* api.request(actor, "GET", `${prefix}/resources?view=${view}`),
            );
            const entry = directory.apps.find((entry) => entry.app.id === app.id);
            expect(entry?.app.accounts).toBeUndefined();
            expect(entry?.linkedAccounts).toEqual([account.id]);
          }
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                linkAccount(actor, appPath, "service", account.id).pipe(Effect.orDie),
              );
              yield* browser.use("Reopen Executor from its card", (page) =>
                page.getByRole("link", { name: "Open Executor", exact: true }).click(),
              );
              yield* browser.use("Open the app's accounts", (page) =>
                page
                  .getByRole("navigation", { name: "App navigation" })
                  .getByRole("link", { name: "Accounts", exact: true })
                  .click(),
              );
              yield* browser.use("Unlink the key without deleting the saved account", (page) =>
                page
                  .getByRole("list", { name: "Executor accounts", exact: true })
                  .getByRole("button", { name: `Manage ${account.label}`, exact: true })
                  .click()
                  .then(() => page.getByRole("menuitem", { name: "Unlink", exact: true }).click()),
              );
              // No other app uses the managed key, so the page offers to delete it; keep it.
              yield* browser.use("Keep the managed account when offered its deletion", (page) =>
                page
                  .getByRole("dialog", { name: "Delete unused account?" })
                  .getByRole("button", { name: "Keep account", exact: true })
                  .click(),
              );
              yield* browser.use("The deletion offer closes", (page) =>
                page
                  .getByRole("dialog", { name: "Delete unused account?" })
                  .waitFor({ state: "hidden" }),
              );
              // The kept account stays listed as one the user could link again, unselected.
              yield* browser.use("Wait for the confirmed unlink", (page) =>
                page
                  .getByRole("list", { name: "Executor accounts", exact: true })
                  .getByRole("radio", { name: account.label, exact: true, checked: false })
                  .waitFor(),
              );
              expect(yield* linkedAccountIds(actor, appPath)).toEqual([]);
              expect(
                (yield* api.request(actor, "GET", `${prefix}/accounts/${account.id}`)).status,
              ).toBe(200);
              yield* browser.use("Return to the list after unlinking", (page) =>
                page.getByRole("link", { name: "Back to apps", exact: true }).click(),
              );
              yield* browser.use("A genuinely missing link still needs an account", (page) =>
                page
                  .getByRole("link", { name: "Open Executor", exact: true })
                  .getByText("Needs account", { exact: true })
                  .waitFor(),
              );
              yield* browser.checkpoint("Needs account only after unlinking the managed key");
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
            yield* installBrowserClock;
            // A document load renders the directory on the server, beyond the browser hold.
            yield* openThroughBrowser(
              "Open Apps during team installation",
              `/org/${actors.organization.slug}/apps`,
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
              page.getByRole("button", { name: "Add app", exact: true }).waitFor(),
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
            // A settled directory learns about the retry at its next idle reconciliation.
            yield* advanceToReconciliation;
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
        const linkedKey = (actor: Session) =>
          Effect.gen(function* () {
            const rows = yield* linkedAccountIds(actor, path);
            expect(rows).toHaveLength(1);
            const row = rows[0];
            if (!row) return yield* Effect.die("Linked Executor key missing");
            return row;
          });
        const account = yield* linkedKey(actors.owner);
        expect(initial.accounts.find((item) => item.id === account)?.method).toBe("apiKey");
        const nativeKeys = yield* body(
          Schema.Struct({
            apiKeys: Schema.Array(Schema.Struct({ name: Schema.NullOr(Schema.String) })),
          }),
          yield* api.request(actors.owner, "GET", "/api/auth/api-key/list"),
        );
        expect(
          nativeKeys.apiKeys.filter((key) => key.name === "Executor app (created automatically)"),
        ).toHaveLength(1);
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
        expect(yield* linkedKey(actors.owner)).toBe(account);
        const [adminInventory, admin] = yield* Effect.all(
          [read(actors.admin), linkedKey(actors.admin)],
          { concurrency: 2 },
        );
        expect(admin).not.toBe(account);
        expect(adminInventory.accounts.some((item) => item.id === account)).toBe(false);
        expect(adminInventory.links.filter((link) => link.app === app.id)).toEqual([
          { app: app.id, account: admin },
        ]);
        const call = (actor: Session) =>
          api.request(actor, "POST", `${path}/tools/call`, {
            tool: "context.get",
            kind: "query",
            input: {},
          });
        // Each user's call runs with their own linked key; another user's key cannot be linked.
        const [ownerCall, adminCall, deniedLink] = yield* Effect.all(
          [
            call(actors.owner),
            call(actors.admin),
            linkAccountResponse(actors.admin, path, "service", account),
          ],
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
        expect(deniedLink.status, JSON.stringify(deniedLink.body)).toBe(403);
        expect(deniedLink.body).toMatchObject({ _tag: "OrganizationForbidden" });
        expect(JSON.stringify(deniedLink.body)).not.toContain(account);
        expect(yield* linkedKey(actors.admin)).toBe(admin);
        const connection = yield* body(
          Schema.Struct({ id: Schema.String }),
          yield* api.request(actors.owner, "POST", connectionsPath(path, "user", "service"), {}),
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
        // Connecting from the app links the manual key in place of the managed one, which stays
        // saved; member setup on later reads neither links it again nor mints another.
        const afterManual = yield* read(actors.owner);
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([manual.id]);
        expect(
          afterManual.accounts.filter((item) => item.method === "apiKey").map((item) => item.id),
        ).toEqual(expect.arrayContaining([account, manual.id]));
        // Calls now run with the manual key, whose synthetic token the API refuses.
        const manualCall = yield* call(actors.owner);
        expect(manualCall.status, JSON.stringify(manualCall.body)).toBe(502);
        expect(manualCall.body).toMatchObject({
          _tag: "AppProviderFailed",
          reason: "unauthorized",
          status: 401,
          account: { id: manual.id, label: "Manual key" },
        });
        // Linking the managed key again replaces the manual one.
        yield* linkAccount(actors.owner, path, "service", account);
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([account]);
        const chosen = yield* call(actors.owner);
        expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
        expect(yield* body(Identity, chosen)).toEqual({
          organization: actors.organization.id,
          role: "owner",
        });
        expect(
          (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${manual.id}`)).status,
        ).toBe(200);
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([account]);
        const restored = yield* call(actors.owner);
        expect(restored.status).toBe(200);
        expect(yield* body(Identity, restored)).toEqual({
          organization: actors.organization.id,
          role: "owner",
        });
      }),
    ),
  );
  it.effect(scenarios.executorKeyUnlinkSticks.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const { app, account } = yield* managementApp(actors.admin);
        const path = `${prefix}/apps/${app.id}`;
        const read = (actor: Session) =>
          api.request(actor, "GET", `${prefix}/inventory`).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.flatMap((response) => body(Inventory, response)),
          );
        const managedKeys = api.request(actors.admin, "GET", "/api/auth/api-key/list").pipe(
          Effect.flatMap((response) =>
            body(
              Schema.Struct({
                apiKeys: Schema.Array(Schema.Struct({ name: Schema.NullOr(Schema.String) })),
              }),
              response,
            ),
          ),
          Effect.map(
            ({ apiKeys }) =>
              apiKeys.filter((key) => key.name === "Executor app (created automatically)").length,
          ),
        );
        expect(yield* managedKeys).toBe(1);
        yield* unlinkAccount(actors.admin, path, "service", account);
        // Member setup runs on every read; none of them may link the key again or mint another.
        const unlinked = Effect.gen(function* () {
          const inventories = yield* Effect.forEach([0, 1, 2, 3], () => read(actors.admin), {
            concurrency: 4,
          });
          for (const inventory of inventories) {
            expect(inventory.links.filter((link) => link.app === app.id)).toEqual([]);
            expect(
              inventory.accounts.filter((item) => item.method === "apiKey").map((item) => item.id),
            ).toEqual([account]);
          }
          const directory = yield* body(
            Schema.Struct({
              apps: Schema.Array(
                Schema.Struct({ app: App, linkedAccounts: Schema.Array(Schema.String) }),
              ),
            }),
            yield* api.request(actors.admin, "GET", `${prefix}/resources`),
          );
          expect(directory.apps.find((entry) => entry.app.id === app.id)?.linkedAccounts).toEqual(
            [],
          );
          expect(yield* linkedAccountIds(actors.admin, path)).toEqual([]);
          expect(
            (yield* api.request(actors.admin, "GET", `${prefix}/accounts/${account}`)).status,
          ).toBe(200);
          expect(yield* managedKeys).toBe(1);
          const call = yield* api.request(actors.admin, "POST", `${path}/tools/call`, {
            tool: "context.get",
            kind: "query",
            input: {},
          });
          expect(call.status).toBe(409);
          expect(call.body).toMatchObject({ _tag: "AccountRequired", slot: "service" });
        });
        yield* unlinked;
        // A new version of the common app sends member setup past its fast path.
        const original = yield* body(
          Schema.Struct({
            files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
          }),
          yield* api.request(actors.owner, "GET", `${path}/source`),
        );
        yield* Effect.addFinalizer(() =>
          saveAndDeploy(actors.owner, path, { files: original.files }).pipe(Effect.orDie),
        );
        const redeployed = yield* saveAndDeploy(actors.owner, path, {
          files: original.files.map((file) =>
            file.path === "index.ts"
              ? { ...file, content: `${file.content}\n// Synthetic customization\n` }
              : file,
          ),
        });
        expect(redeployed.status, JSON.stringify(redeployed.body)).toBe(200);
        yield* unlinked;
        // Linking again is the member's own choice and works on the kept account.
        yield* linkAccount(actors.admin, path, "service", account);
        expect(yield* linkedAccountIds(actors.admin, path)).toEqual([account]);
      }),
    ),
  );
  it.effect(scenarios.executorAppSetupLeavesVersion.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const { app, account } = yield* managementApp(actors.owner);
        const path = `${prefix}/apps/${app.id}`;
        const Version = Schema.Struct({ activeVersion: Schema.String });
        const Source = Schema.Struct({
          files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
        });
        const source = api.request(actors.owner, "GET", `${path}/source`).pipe(
          Effect.flatMap((response) => body(Source, response)),
          Effect.map(({ files }) => ({
            files: files.toSorted((left, right) => left.path.localeCompare(right.path)),
          })),
        );
        // A version whose files differ from this host's template, as an earlier template's do.
        const earlier = (yield* source).files.map((file) =>
          file.path === "index.ts"
            ? { ...file, content: `${file.content}\n// Synthetic earlier template\n` }
            : file,
        );
        const deployed = yield* saveAndDeploy(actors.owner, path, { files: earlier });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const version = (yield* body(Schema.Struct({ app: Version }), deployed)).app.activeVersion;
        // Record it as the version Executor installed, then start the current server over it.
        yield* legacyStorage([
          {
            sql: `UPDATE "organization" SET metadata = jsonb_set(coalesce(metadata::jsonb, '{}'::jsonb), '{executorDefaults}', jsonb_build_object('installed', true, 'app', $2::text, 'deployment', $3::text))::text WHERE id = $1`,
            params: [organization, app.id, version],
          },
        ]);
        yield* serverControl("start");
        // A new admin joins, and member setup mints and links their key.
        const email = `joining-admin-${randomUUID().slice(0, 8)}@example.test`;
        const invitation = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", "/api/auth/organization/invite-member", {
            organizationId: organization,
            email,
            role: "admin",
          }),
        );
        const joining = yield* api.session();
        expect(
          (yield* api.request(joining, "POST", "/api/auth/self-host/register", {
            invitation: invitation.id,
            name: "Joining Admin",
            email,
            password: "password1234",
          })).status,
        ).toBe(200);
        const joined = yield* managementApp(joining);
        expect(joined.app.id).toBe(app.id);
        expect(joined.account).not.toBe(account);
        // Setup left the organization's version, and the keys that fit it, as they were.
        expect(
          (yield* body(Version, yield* api.request(actors.owner, "GET", path))).activeVersion,
        ).toBe(version);
        expect((yield* source).files).toEqual(earlier);
        // The owner's key still fits the app, so calls keep running with it.
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([account]);
        const call = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "context.get",
          kind: "query",
          input: {},
        });
        expect(call.status, JSON.stringify(call.body)).toBe(200);
      }),
    ),
  );
});
