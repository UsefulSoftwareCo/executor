import { scenarios } from "../test-plan.ts";
/** Cloud-only removal: a throwaway organization with real state is deleted by its owner alone. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { App, Inventory, Organization, Resource } from "../support/contracts.ts";

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

const files = [
  {
    path: "index.ts",
    content: `
import { mutation, defineApp, defineProvider, secrets, object, string } from "apps";
const service = defineProvider({ name: "Removal service", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ accounts: { service } }, async ({ accounts }) => ({
   mutations: {
    echo: mutation({ description: "Echo with the connected account", input: object({ message: string() })},
      async (_, input) => ({ message: input.message, connected: accounts.service.fields.token === "synthetic-removal-token" }))
  }
}));
`,
  },
];

layer(HostedLive, { excludeTestServices: true })("Organization removal", (it) => {
  it.effect(scenarios.organizationRemoval.title, (context) =>
    withCase(
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
              `${prefix}/apps/${application.id}/connections`,
              { requirement: "service" },
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
            const selected = yield* api.request(
              actors.owner,
              "GET",
              `${prefix}/apps/${application.id}`,
            );
            expect(selected.status).toBe(200);
            expect(
              (yield* body(
                Schema.Struct({ accounts: Schema.Struct({ service: Schema.String }) }),
                selected,
              )).accounts.service,
            ).toBe(account.id);
            return { app: application.id, account: account.id };
          }),
        );

        yield* evidence.step(
          "Non-owners cannot remove the organization",
          Effect.gen(function* () {
            expect((yield* api.request(actors.admin, "DELETE", prefix)).status).toBe(403);
            expect((yield* api.request(actors.member, "DELETE", prefix)).status).toBe(403);
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
        expect(
          yield* browser.use("Admin has no removal card", (page) =>
            page.getByRole("heading", { name: "Delete organization", exact: true }).count(),
          ),
        ).toBe(0);
        expect(
          yield* browser.use("Admin has no removal control", (page) =>
            page.getByRole("button", { name: "Delete organization", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Admin organization settings without a danger zone");

        // Read the authoritative inventory last, so the card and the removal report describe it.
        const held = yield* evidence.step(
          "Record everything the organization owns before removal",
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "GET", `${prefix}/inventory`);
            expect(response.status).toBe(200);
            const inventory = yield* body(Inventory, response);
            expect(inventory.apps.map((entry) => entry.id)).toContain(state.app);
            expect(inventory.accounts.map((entry) => entry.id)).toContain(state.account);
            const counts = {
              apps: inventory.apps.length,
              accounts: inventory.accounts.length,
            };
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
                new URL(response.url()).pathname === prefix,
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
});
