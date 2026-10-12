/** Sharing drafts and revision conflicts are checked through real hosted forms. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { nameConnectedAccount } from "../support/name-account.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const Access = Schema.Struct({ revision: Schema.String });
const Group = Schema.Struct({ id: Schema.String, revision: Schema.String });
const source = `import {defineApp, defineProvider, secrets, query, object, string, router} from "apps";
const service=defineProvider({name:"Sharing fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
export default defineApp({accounts:{service:service.many()}},{name:"Sharing fixture",tools: router({ identity:query({input:object({})},async()=>"allowed") })});`;

layer(HostedLive, { excludeTestServices: true })("Resource sharing", (it) => {
  it.effect(scenarios.resourceSharing.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const suffix = randomUUID().slice(0, 8);
        const groupName = `Sharing ${suffix}`;
        const owner = yield* body(
          Schema.Struct({ userId: Schema.String }),
          yield* api.request(actors.owner, "GET", "/api/viewer"),
        );
        const members = yield* body(
          Schema.Struct({
            members: Schema.Array(Schema.Struct({ id: Schema.String, userId: Schema.String })),
          }),
          yield* api.request(actors.owner, "GET", `${prefix}/groups`),
        );
        const ownerMember = members.members.find((member) => member.userId === owner.userId);
        if (!ownerMember) throw new Error("Expected the synthetic owner membership");
        const group = yield* body(
          Group,
          yield* api.request(actors.owner, "POST", `${prefix}/groups`, {
            name: groupName,
            description: "",
            memberIds: [ownerMember.id],
          }),
        );
        const app = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Sharing ${suffix}`,
            files: [{ path: "index.ts", content: source }, appsManifest],
          }),
        );
        const connected: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            expect(
              (yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`)).status,
            ).toBe(200);
            for (const account of connected)
              expect(
                (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`))
                  .status,
              ).toBe(200);
            expect(
              (yield* api.request(actors.owner, "DELETE", `${prefix}/groups/${group.id}`, {
                revision: group.revision,
              })).status,
            ).toBe(200);
          }).pipe(Effect.orDie),
        );
        yield* browser.login(actors.owner);
        for (const width of [1280, 390]) {
          yield* browser.use("Set sharing viewport", (page) =>
            page.setViewportSize({ width, height: 850 }),
          );
          yield* browser.use("Open app Settings", (page) =>
            page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=settings`),
          );
          yield* browser.use("Choose app audience", (page) =>
            page.getByRole("combobox", { name: "Who can use this app?" }).click(),
          );
          yield* browser.use("Choose groups", (page) =>
            page.getByRole("option", { name: "Selected groups", exact: true }).click(),
          );
          yield* browser.use("Submit empty groups", (page) =>
            page.getByRole("button", { name: "Save access", exact: true }).click(),
          );
          yield* browser.use("Show required group error", (page) =>
            page.getByRole("alert").filter({ hasText: "Choose at least one group." }).waitFor(),
          );
          yield* browser.use("Choose the group", (page) =>
            page.getByRole("checkbox", { name: groupName, exact: true }).check(),
          );
          const access = yield* body(
            Access,
            yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/access`),
          );
          expect(
            (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/access`, {
              revision: access.revision,
              audience: { kind: "everyone" },
            })).status,
          ).toBe(200);
          yield* browser.use("Submit the stale draft", (page) =>
            page.getByRole("button", { name: "Save access", exact: true }).click(),
          );
          yield* browser.use("Show save failure", (page) =>
            page.getByRole("alert").filter({ hasText: "Could not save access" }).waitFor(),
          );
          expect(
            yield* browser.use("Retain checked group", (page) =>
              page.getByRole("checkbox", { name: groupName, exact: true }).isChecked(),
            ),
          ).toBe(true);
          yield* browser.use("Reset to current settings", (page) =>
            page.getByRole("button", { name: "Reset changes", exact: true }).click(),
          );
          yield* browser.use("The fresh audience replaces the stale draft", (page) =>
            page
              .getByRole("combobox", { name: "Who can use this app?" })
              .filter({ hasText: "Everyone" })
              .waitFor(),
          );
          expect(
            yield* browser.use("Show current audience", (page) =>
              page.getByRole("combobox", { name: "Who can use this app?" }).textContent(),
            ),
          ).toContain("Everyone");
          yield* browser.use("Choose audience again", (page) =>
            page.getByRole("combobox", { name: "Who can use this app?" }).click(),
          );
          yield* browser.use("Make app private", (page) =>
            page.getByRole("option", { name: "Only me", exact: true }).click(),
          );
          yield* browser.use("Save corrected settings", (page) =>
            page.getByRole("button", { name: "Save access", exact: true }).click(),
          );
          yield* browser.use("Observe confirmed save", (page) =>
            page.getByRole("status").filter({ hasText: "Saved" }).waitFor(),
          );
          expect(
            yield* browser.use("No horizontal overflow", (page) =>
              page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            ),
          ).toBe(true);
        }
        for (const kind of ["personal", "shared", "groups"] as const) {
          const label = `${kind} ${suffix}`;
          yield* browser.use("Set account connection viewport", (page) =>
            page.setViewportSize({ width: kind === "groups" ? 390 : 1280, height: 850 }),
          );
          yield* browser.use("Open account selections", (page) =>
            page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
          );
          yield* browser.use("Add an account through the UI", (page) =>
            page.getByRole("button", { name: "Connect new account", exact: true }).click(),
          );
          yield* browser.use("New accounts default to personal access", (page) =>
            page
              .getByRole("combobox", { name: "Who can use this account?" })
              .getByText("Only me", { exact: true })
              .waitFor(),
          );
          if (kind !== "personal") {
            yield* browser.use("Choose the new account audience", (page) =>
              page
                .getByRole("combobox", { name: "Who can use this account?" })
                .click()
                .then(() =>
                  page
                    .getByRole("option", {
                      name: kind === "shared" ? "Everyone in the organization" : "Selected groups",
                      exact: true,
                    })
                    .click(),
                ),
            );
            if (kind === "groups") {
              yield* browser.use("Empty groups show an actionable error", (page) =>
                page.getByRole("alert").filter({ hasText: "Choose at least one group." }).waitFor(),
              );
              expect(
                yield* browser.use("Empty groups cannot authenticate", (page) =>
                  page.getByRole("button", { name: "Connect account", exact: true }).isDisabled(),
                ),
              ).toBe(true);
              yield* browser.use("Choose the account's group", (page) =>
                page.getByRole("checkbox", { name: groupName, exact: true }).check(),
              );
            }
          }
          yield* browser.checkpoint(`New ${kind} account audience`);
          yield* browser.use("Enter a synthetic token", (page) =>
            page.getByLabel("Token", { exact: true }).fill("synthetic"),
          );
          yield* browser.use("Authenticate the new account", (page) =>
            page.getByRole("button", { name: "Connect account", exact: true }).click(),
          );
          yield* browser.use("Name the account", (page) => nameConnectedAccount(page, label));
          yield* browser.use("Wait for account setup to finish", (page) =>
            page.getByRole("dialog").waitFor({ state: "hidden" }),
          );
          yield* browser.use("See the connected account", (page) =>
            page.getByRole("checkbox", { name: label, exact: true, checked: true }).waitFor(),
          );
          if (kind === "groups") {
            yield* browser.use("Reconnect the group-shared account", (page) =>
              page
                .getByRole("button", { name: `Manage ${label}`, exact: true })
                .click()
                .then(() =>
                  page.getByRole("menuitem", { name: "Update credentials", exact: true }).click(),
                ),
            );
            expect(
              yield* browser.use("Reconnecting does not offer to change ownership", (page) =>
                page.getByRole("combobox", { name: "Who can use this account?" }).count(),
              ),
            ).toBe(0);
            yield* browser.use("Enter replacement credentials", (page) =>
              page.getByLabel("Token", { exact: true }).fill("synthetic-replacement"),
            );
            yield* browser.use("Save replacement credentials", (page) =>
              page
                .getByRole("button", { name: "Save credentials", exact: true })
                .click()
                .then(() => page.getByRole("dialog").waitFor({ state: "hidden" })),
            );
          }
          const profile = yield* Schema.decodeUnknownEffect(Schema.String)(
            yield* browser.use("Read the selected profile", (page) =>
              page.evaluate(() => new URL(location.href).searchParams.get("profile")),
            ),
          );
          const binding = yield* body(
            Schema.Struct({ accounts: Schema.Struct({ service: Schema.Array(Schema.String) }) }),
            yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/profiles/${profile}`),
          );
          for (const id of binding.accounts.service)
            if (!connected.includes(id)) connected.push(id);
          expect(connected).toHaveLength(kind === "personal" ? 1 : kind === "shared" ? 2 : 3);
          const account = connected.at(-1);
          const access = yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/accounts/${account}/access`,
          );
          expect(access.status).toBe(200);
          expect(access.body).toMatchObject({
            ownership:
              kind === "personal"
                ? { kind: "personal" }
                : {
                    kind: "shared",
                    audience:
                      kind === "shared"
                        ? { kind: "everyone" }
                        : { kind: "groups", groups: [group.id] },
                  },
          });
          const available = yield* body(
            Schema.Struct({
              accounts: Schema.Array(
                Schema.Struct({ account: Schema.Struct({ id: Schema.String }) }),
              ),
            }),
            yield* api.request(actors.member, "GET", `${prefix}/resources`),
          );
          expect(available.accounts.some((entry) => entry.account.id === account)).toBe(
            kind === "shared",
          );
        }
        yield* browser.use("Open the unified account list", (page) =>
          page.goto(`/org/${actors.organization.slug}/accounts`),
        );
        for (const kind of ["personal", "shared"])
          yield* browser.use("Personal and shared accounts appear together", (page) =>
            page.getByRole("button", { name: `Manage ${kind} ${suffix}`, exact: true }).waitFor(),
          );
        const deleting = connected[0];
        if (!deleting) throw new Error("The connected personal account is missing");
        yield* browser.use("Start deleting the personal account", (page) =>
          page
            .getByRole("button", { name: `Manage personal ${suffix}`, exact: true })
            .click()
            .then(() =>
              page.getByRole("menuitem", { name: "Delete account", exact: true }).click(),
            ),
        );
        const deleted = yield* browser.use("Confirm account deletion", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "DELETE" &&
                [actors.organization.id, actors.organization.slug].some(
                  (organization) =>
                    new URL(response.url()).pathname ===
                    `/api/organizations/${organization}/accounts/${deleting}`,
                ),
            ),
            page
              .getByRole("dialog")
              .getByRole("button", { name: "Delete account", exact: true })
              .click(),
          ]).then(([response]) => response.status()),
        );
        expect(deleted).toBe(200);
        yield* browser.use("Deletion closes the dialog on the account list", (page) =>
          page.getByRole("dialog").waitFor({ state: "hidden" }),
        );
        yield* browser.use("Deleted accounts leave the list", (page) =>
          page
            .getByRole("button", { name: `Manage personal ${suffix}`, exact: true })
            .waitFor({ state: "hidden" }),
        );
        const after = yield* api.request(actors.owner, "GET", `${prefix}/accounts/${deleting}`);
        expect([403, 404]).toContain(after.status);
        connected.splice(0, 1);
        yield* browser.use("The team account remains", (page) =>
          page.getByRole("button", { name: `Manage shared ${suffix}`, exact: true }).waitFor(),
        );
      }),
    ),
  );
});
