import { connectionsPath, linkedAccountIds } from "../support/app-accounts.ts";
import { scenarios } from "../test-plan.ts";
/** Cloud-only removal: a throwaway organization with real state is deleted by its owner alone. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Inventory, Organization, Resource } from "../support/contracts.ts";
import { managementApp } from "../support/management-app.ts";
import { appsManifest } from "../support/apps-release.ts";

/** Public projections owned by this scenario; no server or SDK implementation is imported. */
const Access = Schema.Struct({ organization: Schema.String, role: Schema.String });
const Members = Schema.Struct({
  members: Schema.Array(
    Schema.Struct({ role: Schema.String, user: Schema.Struct({ email: Schema.String }) }),
  ),
});
const OrganizationRemoved = Schema.Struct({
  organization: Schema.String,
  apps: Schema.Number,
  accounts: Schema.Number,
});
/** The danger-zone card counts what removal deletes, in the product's own wording. */
const noun = (value: number, word: string) => `${value} ${word}${value === 1 ? "" : "s"}`;
/** The organization row is deleted by a durable step, not by the request that accepts removal. */
class StillListed extends Error {}
/** A terminated run settles after its terminate request returns. */
class StillRunning extends Error {}

const files = [
  {
    path: "index.ts",
    content: `
import { mutation, defineApp, defineProvider, secrets, object, string, router } from "apps";
const service = defineProvider({ name: "Removal service", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { service } } }, async ({ user: { accounts } }) => ({
   tools: router({
     echo: mutation({ description: "Echo with the connected account", input: object({ message: string() })},
      async (_, input) => ({ message: input.message, connected: accounts.service.fields.token === "synthetic-removal-token" })),
   })
}));
`,
  },
  appsManifest,
];

layer(HostedLive, { excludeTestServices: true })("Organization removal", (it) => {
  it.effect(scenarios.organizationRemoval.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const suffix = randomUUID().slice(0, 8);
        const slug = `removal-${suffix}`;
        const name = `Removal ${suffix}`;

        const created = yield* evidence.step(
          "Owner creates a throwaway organization",
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.owner,
              "POST",
              "/api/auth/organization/create",
              { name, slug, keepCurrentActiveOrganization: true },
            );
            expect(response.status).toBe(200);
            const organization = yield* body(Organization, response);
            expect(organization.slug).toBe(slug);
            expect(organization.id).not.toBe(actors.organization.id);
            return organization;
          }),
        );
        const prefix = `/api/organizations/${created.id}`;
        // This scenario deletes the organization itself; the finalizer only covers an early failure.
        let removedByTest = false;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const cleanupStatus = removedByTest
              ? null
              : yield* api.request(actors.owner, "DELETE", prefix).pipe(
                  Effect.map((response) => response.status),
                  Effect.catch(() => Effect.succeed(0)),
                );
            yield* evidence.json("cleanup.json", {
              organization: created.id,
              removedByTest,
              cleanupStatus,
            });
          }).pipe(Effect.orDie),
        );

        const adminEmail = yield* evidence.step(
          "Read the shared admin identity from its membership",
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.owner,
              "GET",
              `/api/auth/organization/list-members?organizationId=${actors.organization.id}&limit=100&offset=0&sortBy=id&sortDirection=asc`,
            );
            expect(response.status).toBe(200);
            const listed = yield* body(Members, response);
            const admin = listed.members.find((member) => member.role === "admin");
            if (admin === undefined) throw new Error("The shared organization has no admin member");
            return admin.user.email;
          }),
        );
        yield* evidence.step(
          "An admin joins the throwaway organization",
          Effect.gen(function* () {
            const invitation = yield* api.request(
              actors.owner,
              "POST",
              "/api/auth/organization/invite-member",
              { organizationId: created.id, email: adminEmail, role: "admin", resend: true },
            );
            expect(invitation.status).toBe(200);
            const { id } = yield* body(Resource, invitation);
            const accepted = yield* api.request(
              actors.admin,
              "POST",
              "/api/auth/organization/accept-invitation",
              { invitationId: id },
            );
            expect(accepted.status).toBe(200);
            const access = yield* api.request(actors.admin, "GET", `${prefix}/access`);
            expect(access.status).toBe(200);
            const membership = yield* body(Access, access);
            expect(membership.organization).toBe(created.id);
            expect(membership.role).toBe("admin");
          }),
        );

        const state = yield* evidence.step(
          "The organization holds a configured app and a saved account",
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${name} app`,
              files,
            });
            expect(deployed.status).toBe(200);
            const application = yield* body(App, deployed);
            const connection = yield* api.request(
              actors.owner,
              "POST",
              connectionsPath(`${prefix}/apps/${application.id}`, "user", "service"),
              {},
            );
            expect(connection.status).toBe(200);
            const requirement = yield* body(Resource, connection);
            const saved = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${requirement.id}/submit`,
              { method: "key", label: name, fields: { token: "synthetic-removal-token" } },
            );
            expect(saved.status).toBe(200);
            const account = yield* body(Resource, saved);
            expect(
              yield* linkedAccountIds(actors.owner, `${prefix}/apps/${application.id}`),
            ).toEqual([account.id]);
            return { app: application.id, account: account.id };
          }),
        );

        yield* evidence.step(
          "Non-owners cannot remove the organization",
          Effect.gen(function* () {
            expect((yield* api.request(actors.admin, "DELETE", prefix)).status).toBe(403);
            expect((yield* api.request(actors.member, "DELETE", prefix)).status).toBe(403);
            expect((yield* api.request(actors.admin, "GET", `${prefix}/removal`)).status).toBe(403);
            expect((yield* api.request(actors.member, "GET", `${prefix}/removal`)).status).toBe(
              403,
            );
            // The admin is a real member here, so 403 is about the role and not the membership.
            expect((yield* api.request(actors.admin, "GET", `${prefix}/inventory`)).status).toBe(
              200,
            );
          }),
        );

        yield* browser.login(actors.admin);
        yield* browser.use("Admin opens organization settings", (page) =>
          page.goto(`/org/${slug}/organization`),
        );
        yield* browser.use("Admin settings finish loading", (page) =>
          page
            .getByRole("heading", { name: "Organization name", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("Admin can see the restricted removal card", (page) =>
          page.getByRole("heading", { name: "Delete organization", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Admin cannot activate removal", (page) =>
            page.getByRole("button", { name: "Delete organization", exact: true }).isDisabled(),
          ),
        ).toBe(true);
        yield* browser.checkpoint("Admin organization settings with disabled removal");

        // Each user sees only their usable resources. Removal must count both
        // users' private accounts without exposing those accounts to the other.
        yield* Effect.all(
          [managementApp(actors.owner, created.id), managementApp(actors.admin, created.id)],
          { concurrency: 2 },
        );
        const held = yield* evidence.step(
          "Record everything the organization owns before removal",
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "GET", `${prefix}/inventory`);
            expect(response.status).toBe(200);
            const inventory = yield* body(Inventory, response);
            expect(inventory.apps.map((entry) => entry.id)).toContain(state.app);
            expect(inventory.accounts.map((entry) => entry.id)).toContain(state.account);
            const adminResponse = yield* api.request(actors.admin, "GET", `${prefix}/inventory`);
            expect(adminResponse.status).toBe(200);
            const adminInventory = yield* body(Inventory, adminResponse);
            const counts = {
              apps: new Set([...inventory.apps, ...adminInventory.apps].map((entry) => entry.id))
                .size,
              accounts: new Set(
                [...inventory.accounts, ...adminInventory.accounts].map((entry) => entry.id),
              ).size,
            };
            expect(counts.accounts).toBeGreaterThan(inventory.accounts.length);
            const preview = yield* api.request(actors.owner, "GET", `${prefix}/removal`);
            expect(preview.status).toBe(200);
            expect(preview.body).toEqual({ organization: created.id, ...counts });
            yield* evidence.json("inventory-before-removal.json", counts);
            return counts;
          }),
        );

        yield* browser.login(actors.owner);
        yield* browser.use("Owner opens organization settings", (page) =>
          page.goto(`/org/${slug}/organization`),
        );
        yield* browser.use("The danger zone reports what removal deletes", (page) =>
          page
            .getByText(
              `${noun(held.apps, "app")} and ${noun(held.accounts, "account")}, with their saved credentials, are deleted with it.`,
              { exact: true },
            )
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("Show the complete deletion counts", (page) =>
          page
            .getByRole("button", { name: "Delete organization", exact: true })
            .scrollIntoViewIfNeeded(),
        );
        yield* browser.checkpoint("Owner organization settings with the danger zone");

        yield* browser.use("Open the confirmation dialog", (page) =>
          page.getByRole("button", { name: "Delete organization", exact: true }).click(),
        );
        yield* browser.use("The dialog names this organization", (page) =>
          page
            .getByRole("dialog")
            .getByText(`Delete ${name}?`, { exact: true })
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("Removal is disabled before the URL is typed", (page) =>
            page
              .getByRole("dialog")
              .getByRole("button", { name: "Delete organization", exact: true })
              .isDisabled(),
          ),
        ).toBe(true);
        yield* browser.use("Type a URL that does not match", (page) =>
          page.getByLabel("Confirm organization URL", { exact: true }).fill(`${slug}-other`),
        );
        expect(
          yield* browser.use("A different URL does not enable removal", (page) =>
            page
              .getByRole("dialog")
              .getByRole("button", { name: "Delete organization", exact: true })
              .isDisabled(),
          ),
        ).toBe(true);
        yield* browser.checkpoint("Confirm dialog before the organization URL matches");
        yield* browser.use("Type the organization URL", (page) =>
          page.getByLabel("Confirm organization URL", { exact: true }).fill(slug),
        );
        expect(
          yield* browser.use("The matching URL enables removal", (page) =>
            page
              .getByRole("dialog")
              .getByRole("button", { name: "Delete organization", exact: true })
              .isDisabled(),
          ),
        ).toBe(false);
        yield* browser.checkpoint("Confirm dialog with the organization URL typed");

        const outcome = yield* browser.use("Confirm the removal", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "DELETE" &&
                [prefix, `/api/organizations/${slug}`].includes(new URL(response.url()).pathname),
            ),
            page
              .getByRole("dialog")
              .getByRole("button", { name: "Delete organization", exact: true })
              .click(),
          ]).then(([response]) =>
            response.json().then((value: unknown) => ({ status: response.status(), body: value })),
          ),
        );
        expect(outcome.status).toBe(200);
        const report = yield* Schema.decodeUnknownEffect(OrganizationRemoved)(outcome.body);
        removedByTest = true;
        yield* evidence.json("removal.json", report);
        expect(report.organization).toBe(created.id);
        expect(report.apps).toBe(held.apps);
        expect(report.accounts).toBe(held.accounts);

        yield* browser.use("The tab leaves the deleted organization", (page) =>
          page.waitForURL(`**/org/${actors.organization.slug}/apps`),
        );
        yield* browser.checkpoint("The next remaining organization after removal");
        yield* browser.use("Open the organization switcher", (page) =>
          page.getByRole("button", { name: /^Organization: / }).click(),
        );
        expect(
          yield* browser.use("The deleted organization is no longer listed", (page) =>
            page.getByRole("menuitemradio", { name, exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.use("Close the organization switcher", (page) =>
          page.keyboard.press("Escape"),
        );

        yield* evidence.step(
          "No organization record, access or inventory survives",
          Effect.gen(function* () {
            // Access is refused the moment removal is accepted; the auth records
            // are deleted by the workflow, so wait for the list to agree.
            expect((yield* api.request(actors.owner, "GET", `${prefix}/access`)).status).toBe(403);
            expect((yield* api.request(actors.admin, "GET", `${prefix}/access`)).status).toBe(403);
            expect((yield* api.request(actors.owner, "GET", `${prefix}/inventory`)).status).toBe(
              403,
            );
            expect(
              (yield* api.request(actors.owner, "GET", `${prefix}/apps/${state.app}`)).status,
            ).toBe(403);
            yield* api.request(actors.owner, "GET", "/api/auth/organization/list").pipe(
              Effect.flatMap((listed) => body(Schema.Array(Organization), listed)),
              Effect.flatMap((remaining) =>
                remaining.some((entry) => entry.id === created.id)
                  ? Effect.fail(new StillListed())
                  : Effect.succeed(remaining),
              ),
              Effect.retry({
                while: (error) => error instanceof StillListed,
                schedule: Schedule.spaced("500 millis"),
              }),
              Effect.timeout("60 seconds"),
              Effect.tap((remaining) =>
                Effect.sync(() =>
                  expect(remaining.some((entry) => entry.id === actors.organization.id)).toBe(true),
                ),
              ),
            );
          }),
        );
      }),
    ),
  );

  // Owner removal is reached only through a Cloud organization's removal: local's owners are
  // fixed, and self-host has one instance organization. A running workflow refuses it.
  it.effect(scenarios.organizationRemovalWorkflowRefusal.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api;
        const suffix = randomUUID().slice(0, 8);
        const created = yield* body(
          Organization,
          yield* api.request(actors.owner, "POST", "/api/auth/organization/create", {
            name: `Busy ${suffix}`,
            slug: `busy-${suffix}`,
            keepCurrentActiveOrganization: true,
          }),
        );
        const prefix = `/api/organizations/${created.id}`;
        let removed = false;
        yield* Effect.addFinalizer(() =>
          removed ? Effect.void : api.request(actors.owner, "DELETE", prefix).pipe(Effect.ignore),
        );
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Busy ${suffix} app`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, object, router, workflow } from "apps";
export const slow = workflow({ input: object({}) }, async (ctx) => {
  await ctx.step.sleep("hold", "1 minute");
  return null;
});
export default defineApp({}, { tools: router({}), workflows: { slow } });`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/apps/${app.id}`;
        const started = yield* api.request(actors.owner, "POST", `${path}/workflow-runs`, {
          workflow: "slow",
          input: {},
          key: randomUUID(),
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const run = yield* body(Resource, started);

        const refused = yield* api.request(actors.owner, "DELETE", prefix);
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ _tag: "AppWorkflowsActive", app: app.id });
        // Nothing was hidden or deleted: the app is still there.
        expect((yield* api.request(actors.owner, "GET", path)).status).toBe(200);

        expect(
          (yield* api.request(actors.owner, "POST", `${path}/workflow-runs/${run.id}/terminate`))
            .status,
        ).toBe(200);
        const accepted = yield* api.request(actors.owner, "DELETE", prefix).pipe(
          Effect.flatMap((response) =>
            response.status === 409 ? Effect.fail(new StillRunning()) : Effect.succeed(response),
          ),
          Effect.retry({
            while: (error) => error instanceof StillRunning,
            schedule: Schedule.spaced("250 millis"),
          }),
          Effect.timeout("30 seconds"),
        );
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
        removed = true;
      }),
    ),
  );
});
