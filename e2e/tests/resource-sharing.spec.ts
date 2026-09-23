/** Sharing drafts and revision conflicts are checked through real hosted forms. */
import { createProfile } from "../support/profiles.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";

const Access = Schema.Struct({ revision: Schema.String });
const Group = Schema.Struct({ id: Schema.String, revision: Schema.String });
const source = `import {defineApp, defineProvider, secrets, query, object, string} from "apps";
const service=defineProvider({name:"Sharing fixture",auth:{key:secrets({label:"Key",fields:object({token:string()})})}});
export default defineApp({accounts:{service:service.many()}},{name:"Sharing fixture",queries:{identity:query({input:object({})},async()=>"allowed")}});`;

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
        const group = yield* body(
          Group,
          yield* api.request(actors.owner, "POST", `${prefix}/groups`, {
            name: groupName,
            description: "",
            memberIds: [],
          }),
        );
        const app = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Sharing ${suffix}`,
            files: [{ path: "index.ts", content: source }],
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
        for (const kind of ["personal", "shared"] as const) {
          const label = `${kind} ${suffix}`;
          if (kind === "personal") {
            yield* browser.use("Open account selections", (page) =>
              page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
            );
            yield* browser.use("Add a personal account", (page) =>
              page
                .getByRole("button", { name: "Add Sharing fixture account", exact: true })
                .click(),
            );
          } else {
            const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
            const connection = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
                profile: profile.id,
                requirement: "service",
                destination: { kind: "shared", audience: { kind: "everyone" } },
              }),
            );
            yield* browser.use("Open the shared connection handoff", (page) =>
              page.goto(`/org/${actors.organization.slug}/connections/${connection.id}`),
            );
          }
          yield* browser.use("Name the account", (page) =>
            page.getByLabel("Account name", { exact: true }).fill(label),
          );
          yield* browser.use("Enter a synthetic token", (page) =>
            page.getByLabel("Token", { exact: true }).fill("synthetic"),
          );
          yield* browser.use("Authenticate the new account", (page) =>
            page.getByRole("button", { name: "Connect account", exact: true }).click(),
          );
          yield* browser.use("Wait for account setup to finish", (page) =>
            page.getByRole("dialog").waitFor({ state: "hidden" }),
          );
          yield* browser.use("See the connected account", (page) =>
            page.getByRole("link", { name: label, exact: true }).waitFor(),
          );
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
          expect(connected).toHaveLength(kind === "personal" ? 1 : 2);
        }
        yield* browser.use("Open the unified account list", (page) =>
          page.goto(`/org/${actors.organization.slug}/accounts`),
        );
        for (const kind of ["personal", "shared"])
          yield* browser.use("Personal and shared accounts appear together", (page) =>
            page.getByRole("link", { name: `${kind} ${suffix}`, exact: true }).waitFor(),
          );
        const deleting = connected[0];
        if (!deleting) throw new Error("The connected personal account is missing");
        yield* browser.use("Open the personal account", (page) =>
          page.goto(`/org/${actors.organization.slug}/accounts/${deleting}`),
        );
        yield* browser.use("Start deleting the account", (page) =>
          page.getByRole("link", { name: "Delete account", exact: true }).click(),
        );
        const deleted = yield* browser.use("Confirm account deletion", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "DELETE" &&
                new URL(response.url()).pathname === `${prefix}/accounts/${deleting}`,
            ),
            page.getByRole("button", { name: "Delete account", exact: true }).click(),
          ]).then(([response]) => response.status()),
        );
        expect(deleted).toBe(200);
        yield* browser.use("Deletion returns to the account list", (page) =>
          page.waitForURL(`**/org/${actors.organization.slug}/accounts`),
        );
        yield* browser.use("Deleted accounts leave the list", (page) =>
          page
            .getByRole("link", { name: `personal ${suffix}`, exact: true })
            .waitFor({ state: "hidden" }),
        );
        const after = yield* api.request(actors.owner, "GET", `${prefix}/accounts/${deleting}`);
        expect([403, 404]).toContain(after.status);
        connected.splice(0, 1);
        yield* browser.use("The team account remains", (page) =>
          page.getByRole("link", { name: `shared ${suffix}`, exact: true }).waitFor(),
        );
      }),
    ),
  );
});
