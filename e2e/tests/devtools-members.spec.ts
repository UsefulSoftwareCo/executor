/** Real dev server, real member admission, and browser switching; no application implementation imports. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, SessionClients } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { Evidence } from "../support/evidence.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { startDevelopmentServer } from "../support/managed-server.ts";
import { scenarios } from "../test-plan.ts";
const Member = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  role: Schema.String,
});
const Directory = Schema.Struct({
  organization: Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String }),
  accounts: Schema.Array(Member),
  selected: Schema.NullOr(Schema.String),
  impersonating: Schema.Boolean,
});
const Identity = Schema.Struct({ userId: Schema.String });
const Resource = Schema.Struct({ id: Schema.String });
layer(TestLive, { excludeTestServices: true })("Dev tools members", (it) => {
  it.effect(scenarios.devtoolsMembers.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const production = yield* Api,
          browser = yield* Browser,
          target = yield* Target,
          evidence = yield* Evidence;
        const productionAnonymous = yield* production.session();
        expect(
          (yield* production.request(productionAnonymous, "GET", "/api/devtools")).status,
        ).toBe(404);
        const origin = yield* startDevelopmentServer(target);
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
        );
        const anonymous = yield* api.session();
        yield* evidence.json("development-origin.json", { origin });
        const headers = { origin };
        const owner = yield* api.session();
        const initial = yield* body(
          Directory,
          yield* api.request(owner, "GET", `${origin}/api/devtools`, undefined, headers),
        );
        const ownerAccount = initial.accounts.find((account) => account.role === "owner");
        if (!ownerAccount) throw new Error("Development owner is missing");
        const selection = { organization: initial.organization.id, userId: ownerAccount.id };
        expect(
          (yield* api.request(owner, "POST", `${origin}/api/devtools/account`, selection, headers))
            .status,
        ).toBe(200);
        const user = yield* api.session();
        const suffix = randomUUID().slice(0, 8),
          name = `Taylor Brooks ${suffix}`,
          email = `taylor-${suffix}@example.test`;
        const invite = yield* body(
          Resource,
          yield* api.request(
            owner,
            "POST",
            `${origin}/api/auth/organization/invite-member`,
            { organizationId: initial.organization.id, email, role: "member" },
            headers,
          ),
        );
        expect(
          (yield* api.request(
            user,
            "POST",
            `${origin}/api/auth/self-host/register`,
            { invitation: invite.id, name, email, password: "password1234" },
            headers,
          )).status,
        ).toBe(200);
        const identity = yield* body(
          Identity,
          yield* api.request(user, "GET", `${origin}/api/viewer`, undefined, headers),
        );
        const list = () =>
          api
            .request(
              owner,
              "GET",
              `${origin}/api/devtools?organization=${initial.organization.slug}`,
              undefined,
              headers,
            )
            .pipe(Effect.flatMap((response) => body(Directory, response)));
        const added = yield* list();
        expect(added.accounts).toHaveLength(initial.accounts.length + 1);
        expect(added.accounts.find((account) => account.id === identity.userId)).toMatchObject({
          name,
          email,
          role: "member",
        });
        const targetSelection = { organization: initial.organization.id, userId: identity.userId };
        expect(
          (yield* api.request(
            anonymous,
            "POST",
            `${origin}/api/devtools/account`,
            targetSelection,
            { origin: "https://example.com" },
          )).status,
        ).toBe(403);
        expect(
          (yield* api.request(
            anonymous,
            "POST",
            `${origin}/api/devtools/account`,
            { ...targetSelection, organization: "foreign" },
            headers,
          )).status,
        ).toBe(403);
        expect(
          (yield* api.request(
            anonymous,
            "POST",
            `${origin}/api/devtools/account`,
            { ...targetSelection, userId: "missing-user" },
            headers,
          )).status,
        ).toBe(403);
        const switched = yield* api.session();
        expect(
          (yield* api.request(
            switched,
            "POST",
            `${origin}/api/devtools/account`,
            targetSelection,
            headers,
          )).status,
        ).toBe(200);
        const sessionView = yield* body(
          Schema.Struct({
            user: Schema.Struct({ id: Schema.String }),
            session: Schema.Struct({ impersonatedBy: Schema.NonEmptyString }),
          }),
          yield* api.request(switched, "GET", `${origin}/api/auth/get-session`, undefined, headers),
        );
        expect(sessionView.user.id).toBe(identity.userId);
        expect(sessionView.session.impersonatedBy).toBe("executor-devtools-operator");
        expect(
          (yield* api.request(
            owner,
            "GET",
            `${origin}/api/auth/admin/list-users`,
            undefined,
            headers,
          )).status,
        ).toBe(403);
        yield* browser.login(owner);
        yield* browser.use("Open the organization's groups", (page) =>
          page.goto(`${origin}/org/${initial.organization.slug}/groups`),
        );
        yield* browser.use("Open the real member picker", (page) =>
          page.getByRole("button", { name: "Open Executor dev tools", exact: true }).click(),
        );
        yield* browser.use("Search the newly joined member", (page) =>
          page
            .getByRole("textbox", { name: "Search organization members", exact: true })
            .fill(email),
        );
        yield* browser.use("Switch to a non-fixture member", (page) =>
          page
            .getByRole("button", { name: `Impersonate ${name}, Member, ${email}`, exact: true })
            .click(),
        );
        yield* browser.use("The dashboard uses the selected person's identity", (page) =>
          page
            .getByRole("textbox", { name: "Search organization members", exact: true })
            .waitFor({ state: "hidden" }),
        );
        yield* browser.use("Reopen the picker after switching", (page) =>
          page.getByRole("button", { name: "Open Executor dev tools", exact: true }).click(),
        );
        yield* browser.use("Search the active member", (page) =>
          page
            .getByRole("textbox", { name: "Search organization members", exact: true })
            .fill(name),
        );
        expect(
          yield* browser.use("The selected ID is active independently of role", (page) =>
            page
              .getByRole("button", { name: `Impersonate ${name}, Member, ${email}`, exact: true })
              .getAttribute("aria-pressed"),
          ),
        ).toBe("true");
        yield* browser.checkpoint("Real organization members in the local picker");
        const members = yield* body(
          Schema.Struct({
            members: Schema.Array(Schema.Struct({ id: Schema.String, userId: Schema.String })),
          }),
          yield* api.request(
            owner,
            "GET",
            `${origin}/api/organizations/${initial.organization.id}/groups`,
            undefined,
            headers,
          ),
        );
        const joined = members.members.find((member) => member.userId === identity.userId);
        if (!joined) throw new Error("Joined membership is missing");
        expect(
          (yield* api.request(
            owner,
            "POST",
            `${origin}/api/auth/organization/remove-member`,
            { organizationId: initial.organization.id, memberIdOrEmail: joined.id },
            headers,
          )).status,
        ).toBe(200);
        expect((yield* list()).accounts.some((account) => account.id === identity.userId)).toBe(
          false,
        );
        const denied = yield* api.request(
          anonymous,
          "POST",
          `${origin}/api/devtools/account`,
          targetSelection,
          headers,
        );
        expect(denied.status).toBe(403);
        yield* browser.login(yield* api.session());
        yield* browser.use("Open a sign-in link for another organization", (page) =>
          page.goto(`${origin}/login?redirect=${encodeURIComponent("/org/unavailable-org/apps")}`),
        );
        yield* browser.use("Open dev tools on the scoped login page", (page) =>
          page.getByRole("button", { name: "Open Executor dev tools", exact: true }).click(),
        );
        yield* browser.use(
          "An unavailable organization never falls back to fixture members",
          (page) => page.getByText("Could not load dev tools.", { exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("No default person is offered for another organization", (page) =>
            page.getByRole("button", { name: /^Impersonate / }).count(),
          ),
        ).toBe(0);
      }),
    ),
  );
});
