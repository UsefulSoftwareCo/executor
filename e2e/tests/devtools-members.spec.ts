/** Development bootstraps authority, then uses the same native flow as deployed hosted products. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, SessionClients } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { startDevelopmentServer } from "../support/managed-server.ts";
import { scenarios } from "../test-plan.ts";
const Resource = Schema.Struct({ id: Schema.String });
const Users = Schema.Struct({
  users: Schema.Array(Schema.Struct({ id: Schema.String, email: Schema.String })),
});
const Organizations = Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String }));
layer(TestLive, { excludeTestServices: true })("Dev tools members", (it) => {
  it.effect(scenarios.devtoolsMembers.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const production = yield* Api,
          browser = yield* Browser,
          target = yield* Target;
        const productionAnonymous = yield* production.session();
        expect(
          (yield* production.request(productionAnonymous, "POST", "/api/devtools/operator", {}))
            .status,
        ).toBe(404);
        const origin = yield* startDevelopmentServer(target);
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
        );
        const operator = yield* api.session(),
          headers = { origin };
        expect(
          (yield* api.request(
            operator,
            "POST",
            `${origin}/api/devtools/operator`,
            {},
            { origin: "https://example.com" },
          )).status,
        ).toBe(403);
        expect(
          (yield* api.request(operator, "POST", `${origin}/api/devtools/operator`, {}, headers))
            .status,
        ).toBe(200);
        const directory = yield* body(
          Users,
          yield* api.request(
            operator,
            "GET",
            `${origin}/api/auth/admin/list-users`,
            undefined,
            headers,
          ),
        );
        const ownerAccount = directory.users.find(
          (user) => user.email === "agent-agent@example.test",
        );
        if (!ownerAccount) return yield* Effect.die("Development owner is missing");
        expect(
          (yield* api.request(
            operator,
            "POST",
            `${origin}/api/auth/admin/impersonate-user`,
            { userId: ownerAccount.id },
            headers,
          )).status,
        ).toBe(200);
        const organizations = yield* body(
          Organizations,
          yield* api.request(
            operator,
            "GET",
            `${origin}/api/auth/organization/list`,
            undefined,
            headers,
          ),
        );
        const organization = organizations[0];
        if (!organization) return yield* Effect.die("Development organization is missing");
        const email = `taylor-${randomUUID().slice(0, 8)}@example.test`;
        const invitation = yield* body(
          Resource,
          yield* api.request(
            operator,
            "POST",
            `${origin}/api/auth/organization/invite-member`,
            { organizationId: organization.id, email, role: "member" },
            headers,
          ),
        );
        const member = yield* api.session();
        expect(
          (yield* api.request(
            member,
            "POST",
            `${origin}/api/auth/self-host/register`,
            { invitation: invitation.id, name: "Taylor Brooks", email, password: "password1234" },
            headers,
          )).status,
        ).toBe(200);
        expect(
          (yield* api.request(
            member,
            "GET",
            `${origin}/api/auth/admin/list-users`,
            undefined,
            headers,
          )).status,
        ).toBe(403);
        expect(
          (yield* api.request(
            operator,
            "POST",
            `${origin}/api/auth/admin/stop-impersonating`,
            {},
            headers,
          )).status,
        ).toBe(200);
        yield* browser.login(yield* api.session());
        yield* browser.use("Open local sign-in", (page) => page.goto(`${origin}/login`));
        yield* browser.use("Open the shared widget", (page) =>
          page.getByRole("button", { name: "Open Executor dev tools", exact: true }).click(),
        );
        yield* browser.use("Sign in as the local operator", (page) =>
          page.getByRole("button", { name: "Enable dev tools", exact: true }).click(),
        );
        yield* browser.use("Local operator sign-in completed navigation", (page) =>
          page.waitForURL(`${origin}/`),
        );
        yield* browser.use("Open the authenticated picker", (page) =>
          page.getByRole("button", { name: "Open Executor dev tools", exact: true }).click(),
        );
        yield* browser.use("Search a newly admitted user", (page) =>
          page.getByRole("textbox", { name: "Search users by email", exact: true }).fill(email),
        );
        yield* browser.use("Search", (page) =>
          page.getByRole("button", { name: "Search", exact: true }).click(),
        );
        yield* browser.use("Impersonate the new user", (page) =>
          page.getByRole("button", { name: `Impersonate ${email}`, exact: true }).click(),
        );
        yield* browser.use("The impersonation indicator stays visible", (page) =>
          page.getByRole("button", { name: "Return to my account", exact: true }).waitFor(),
        );
        yield* browser.checkpoint("Local impersonation uses the unified widget");
        yield* browser.use("Return to the developer", (page) =>
          page.getByRole("button", { name: "Return to my account", exact: true }).click(),
        );
        yield* browser.use("The shared picker is available again", (page) =>
          page.getByRole("button", { name: "Open Executor dev tools", exact: true }).waitFor(),
        );
      }),
    ),
  );
});
