import { scenarios } from "../test-plan.ts";
/** Cloud-only: a person deletes their own user, with the organizations only they belong to. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Organization } from "../support/contracts.ts";
import { appLinksFixture, keyProvider, ok } from "../support/app-links.ts";
import { managementApp } from "../support/management-app.ts";

/** An app whose many() app requirement reports the accounts a call ran with. */
const source = `import { defineApp, defineProvider, query, secrets, object, string, router, type QueryContext } from "apps";
const team = ${keyProvider("User removal link fixture")};
const requirements = { app: { accounts: { team: team.many() } } };
const accounts = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) => ({
  team: ctx.app.accounts.team.map((account) => account.id),
}));
export default defineApp(requirements, async () => ({ tools: router({ accounts }) }));`;
const Accounts = Schema.Struct({ team: Schema.Array(Schema.String) });

/** Public projections owned by this scenario; no server or SDK implementation is imported. */
const Session = Schema.Struct({ user: Schema.Struct({ id: Schema.String, email: Schema.String }) });
const Preview = Schema.Struct({
  organizations: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      slug: Schema.String,
      outcome: Schema.Literals(["delete", "leave", "blocked"]),
    }),
  ),
  personalAccounts: Schema.Number,
});
const Key = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });
const Members = Schema.Struct({
  members: Schema.Array(Schema.Struct({ user: Schema.Struct({ email: Schema.String }) })),
});
const ToolIndex = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });
/** The organization row is deleted by a durable step, not by the request that deletes the user. */
class StillListed extends Error {}

layer(HostedLive, { excludeTestServices: true })("User removal", (it) => {
  it.effect(scenarios.userRemoval.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const anonymous = yield* api.session();
        const suffix = randomUUID().slice(0, 8);
        const name = `Solo ${suffix}`;
        const fixture = yield* appLinksFixture([{ path: "index.ts", content: source }]);
        const used = Effect.gen(function* () {
          const response = yield* fixture.call(actors.owner, "accounts");
          yield* ok(response);
          return (yield* body(Accounts, response)).team;
        });

        const admin = yield* body(
          Session,
          yield* api.request(actors.admin, "GET", "/api/auth/get-session"),
        );
        const solo = yield* evidence.step(
          "The admin creates an organization only they belong to",
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.admin,
              "POST",
              "/api/auth/organization/create",
              { name, slug: `solo-${suffix}`, keepCurrentActiveOrganization: true },
            );
            expect(response.status).toBe(200);
            return yield* body(Organization, response);
          }),
        );
        // Removal deletes the organization itself; this covers a failure before that.
        let removedByTest = false;
        yield* Effect.addFinalizer(() =>
          removedByTest
            ? Effect.void
            : api
                .request(actors.admin, "DELETE", `/api/organizations/${solo.id}`)
                .pipe(Effect.ignore),
        );

        const credentials = yield* evidence.step(
          "The admin holds a personal account linked for everyone and an API key",
          Effect.gen(function* () {
            // The admin links their personal account to an app for everyone in the organization.
            const account = yield* fixture.connect(actors.admin, "app", "team", `team-${suffix}`);
            expect(yield* used).toEqual([account]);
            const created = yield* api.request(actors.admin, "POST", "/api/auth/api-key/create", {
              name: "Full account token",
            });
            expect(created.status).toBe(200);
            const key = yield* body(Key, created);
            const access = yield* api.request(
              anonymous,
              "GET",
              `/api/organizations/${actors.organization.id}/access`,
              undefined,
              { authorization: `Bearer ${Redacted.value(key.key)}` },
            );
            expect(access.status).toBe(200);
            return { account, key };
          }),
        );

        yield* evidence.step(
          "Neither deletion is reachable from the Executor app or an API key",
          Effect.gen(function* () {
            // The solo organization's own Executor app runs with the admin's managed key as owner.
            const executor = yield* managementApp(actors.admin, solo.id);
            const path = `/api/organizations/${solo.id}/apps/${executor.app.id}`;
            const index = yield* body(
              ToolIndex,
              yield* api.request(actors.admin, "GET", `${path}/tools/index`),
            );
            const names = index.items.map((tool) => tool.name);
            // The read-only preview stays an agent tool; the deletions are not.
            expect(names).toContain("organizationRemoval.preview");
            expect(names).not.toContain("organizationRemoval.remove");
            expect(names).not.toContain("userRemoval.remove");
            const called = yield* api.request(actors.admin, "POST", `${path}/tools/call`, {
              tool: "organizationRemoval.remove",
              kind: "mutation",
              input: { organization: solo.id },
            });
            expect(called.status, JSON.stringify(called.body)).toBe(404);
            expect(called.body).toMatchObject({ _tag: "ToolNotFound" });
            // The API itself refuses the same credentials an app or agent would hold.
            const bearer = { authorization: `Bearer ${Redacted.value(credentials.key.key)}` };
            const organization = yield* api.request(
              anonymous,
              "DELETE",
              `/api/organizations/${solo.id}`,
              undefined,
              bearer,
            );
            expect(organization.status, JSON.stringify(organization.body)).toBe(403);
            expect(organization.body).toMatchObject({ _tag: "Forbidden" });
            const user = yield* api.request(anonymous, "DELETE", "/api/user", undefined, bearer);
            expect(user.status, JSON.stringify(user.body)).toBe(401);
            // Both are still there for the admin's own browser to delete.
            expect(
              (yield* api.request(actors.admin, "GET", `/api/organizations/${solo.id}/inventory`))
                .status,
            ).toBe(200);
            expect((yield* api.request(actors.admin, "GET", "/api/viewer")).status).toBe(200);
          }),
        );

        yield* evidence.step(
          "The only owner of an organization with other members is refused",
          Effect.gen(function* () {
            const preview = yield* body(
              Preview,
              yield* api.request(actors.owner, "GET", "/api/user/removal"),
            );
            expect(
              preview.organizations.find((entry) => entry.id === actors.organization.id)?.outcome,
            ).toBe("blocked");
            const shared = preview.organizations.find(
              (entry) => entry.id === actors.organization.id,
            );
            const refused = yield* api.request(actors.owner, "DELETE", "/api/user");
            expect(refused.status).toBe(409);
            expect(refused.body).toMatchObject({
              _tag: "UserRemovalBlocked",
              organizations: [shared?.name],
            });
            // Nothing was deleted: the owner is still signed in and still owns the organization.
            expect((yield* api.request(actors.owner, "GET", "/api/viewer")).status).toBe(200);
            const access = yield* api.request(
              actors.owner,
              "GET",
              `/api/organizations/${actors.organization.id}/access`,
            );
            expect(access.status).toBe(200);
          }),
        );

        yield* evidence.step(
          "The admin sees what deleting them does to each organization",
          Effect.gen(function* () {
            const response = yield* api.request(actors.admin, "GET", "/api/user/removal");
            expect(response.status).toBe(200);
            const preview = yield* body(Preview, response);
            const outcomes = Object.fromEntries(
              preview.organizations.map((entry) => [entry.id, entry.outcome]),
            );
            expect(outcomes).toEqual({ [actors.organization.id]: "leave", [solo.id]: "delete" });
            expect(preview.personalAccounts).toBeGreaterThanOrEqual(1);
            yield* evidence.json("preview.json", preview);
            return preview;
          }),
        );

        yield* browser.login(actors.admin);
        yield* browser.use("Open profile settings", (page) => page.goto("/account/profile"));
        yield* browser.use("The card lists each organization's outcome", (page) =>
          page
            .getByRole("list", { name: "What happens to your organizations" })
            .getByText(name, { exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("Show the delete account card", (page) =>
          page
            .getByRole("button", { name: "Delete account", exact: true })
            .scrollIntoViewIfNeeded(),
        );
        yield* browser.checkpoint("Profile settings with the delete account card");

        yield* browser.use("Open the confirmation dialog", (page) =>
          page.getByRole("button", { name: "Delete account", exact: true }).click(),
        );
        yield* browser.use("Type a different email", (page) =>
          page.getByLabel("Confirm your email", { exact: true }).fill(`other-${admin.user.email}`),
        );
        expect(
          yield* browser.use("A different email does not enable deletion", (page) =>
            page
              .getByRole("dialog")
              .getByRole("button", { name: "Delete account", exact: true })
              .isDisabled(),
          ),
        ).toBe(true);
        yield* browser.use("Type the admin's email", (page) =>
          page.getByLabel("Confirm your email", { exact: true }).fill(admin.user.email),
        );
        yield* browser.checkpoint("Confirm dialog with the email typed");

        // The tab leaves for the public root as soon as the deletion succeeds, which discards
        // the response body; the checks below read what it deleted from the product instead.
        const status = yield* browser.use("Confirm the deletion", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "DELETE" &&
                new URL(response.url()).pathname === "/api/user",
            ),
            page
              .getByRole("dialog")
              .getByRole("button", { name: "Delete account", exact: true })
              .click(),
          ]).then(([response]) => response.status()),
        );
        expect(status).toBe(200);
        removedByTest = true;

        yield* browser.use("The tab leaves the dashboard", (page) =>
          page.waitForURL((url) => !url.pathname.startsWith("/account")),
        );
        yield* browser.checkpoint("Signed out after deleting the account");

        yield* evidence.step(
          "No session, key, membership, app link or organization of the admin survives",
          Effect.gen(function* () {
            expect((yield* api.request(actors.admin, "GET", "/api/viewer")).status).toBe(401);
            const access = yield* api.request(
              anonymous,
              "GET",
              `/api/organizations/${actors.organization.id}/access`,
              undefined,
              { authorization: `Bearer ${Redacted.value(credentials.key.key)}` },
            );
            expect(access.status).toBe(401);
            const members = yield* body(
              Members,
              yield* api.request(
                actors.owner,
                "GET",
                `/api/auth/organization/list-members?organizationId=${actors.organization.id}&limit=100&offset=0&sortBy=id&sortDirection=asc`,
              ),
            );
            expect(members.members.map((entry) => entry.user.email)).not.toContain(
              admin.user.email,
            );
            // The account no longer serves the app, and its link is gone with it.
            expect(yield* used).toEqual([]);
            expect((yield* fixture.links()).map((link) => link.account.id)).not.toContain(
              credentials.account,
            );
            // The shared organization and its owner are untouched.
            expect(
              (yield* api.request(
                actors.owner,
                "GET",
                `/api/organizations/${actors.organization.id}/inventory`,
              )).status,
            ).toBe(200);
            // The admin's own organization is erased by its workflow, which frees its URL.
            const reused = yield* api
              .request(actors.owner, "POST", "/api/auth/organization/create", {
                name,
                slug: solo.slug,
                keepCurrentActiveOrganization: true,
              })
              .pipe(
                Effect.flatMap((response) =>
                  response.status === 200
                    ? body(Organization, response)
                    : Effect.fail(new StillListed()),
                ),
                Effect.retry({
                  while: (error) => error instanceof StillListed,
                  schedule: Schedule.spaced("500 millis"),
                }),
                Effect.timeout("60 seconds"),
              );
            expect(reused.id).not.toBe(solo.id);
            expect(
              (yield* api.request(actors.owner, "DELETE", `/api/organizations/${reused.id}`))
                .status,
            ).toBe(200);
          }),
        );
      }),
    ),
  );
});
