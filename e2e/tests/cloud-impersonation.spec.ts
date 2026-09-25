import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { Target } from "../support/platform.ts";
import { fixtureRequest } from "../sdk/fixtures.ts";
import { scenarios } from "../test-plan.ts";

const Identity = Schema.Struct({
  user: Schema.Struct({ id: Schema.String, email: Schema.String }),
  session: Schema.Struct({ impersonatedBy: Schema.optional(Schema.NullOr(Schema.String)) }),
});
layer(HostedLive, { excludeTestServices: true })("Cloud impersonation", (it) => {
  it.effect(scenarios.cloudImpersonation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          target = yield* Target;
        const identity = (session: typeof actors.owner) =>
          api
            .request(session, "GET", "/api/auth/get-session")
            .pipe(Effect.flatMap((response) => body(Identity, response)));
        const owner = yield* identity(actors.owner),
          member = yield* identity(actors.member);
        const anonymous = yield* api.session();
        for (const session of [anonymous, actors.owner, actors.admin, actors.member]) {
          expect(
            (yield* api.request(session, "GET", "/api/auth/admin/list-users")).status,
          ).toBeGreaterThanOrEqual(400);
          expect(
            (yield* api.request(session, "POST", "/api/auth/admin/impersonate-user", {
              userId: member.user.id,
            })).status,
          ).toBeGreaterThanOrEqual(400);
        }
        yield* browser.login(actors.admin);
        yield* browser.use("Open the ordinary organization admin dashboard", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* browser.use("Wait for the organization admin dashboard", (page) =>
          page.getByRole("heading", { name: /^Apps\s*\d+$/ }).waitFor(),
        );
        expect(
          yield* browser.use("Organization admins have no authenticated user picker", (page) =>
            page.getByRole("textbox", { name: "Search users by email", exact: true }).count(),
          ),
        ).toBe(0);
        if (!target.fixtures || !target.scenarioId)
          return yield* Effect.die("Missing owned fixture control");
        yield* fixtureRequest(target.fixtures, "/operator", { id: target.scenarioId });
        expect((yield* api.request(actors.owner, "GET", "/api/auth/admin/list-users")).status).toBe(
          200,
        );
        yield* browser.login(actors.owner);
        yield* browser.use("Open the platform admin dashboard", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* browser.use("Open the shared Executor widget", (page) =>
          page.getByRole("button", { name: "Open Executor dev tools", exact: true }).click(),
        );
        yield* browser.use("Find the target by email", (page) =>
          page
            .getByRole("textbox", { name: "Search users by email", exact: true })
            .fill(member.user.email),
        );
        yield* browser.use("Submit the directory search", (page) =>
          page.getByRole("button", { name: "Search", exact: true }).click(),
        );
        yield* browser.use("Wait for the target user", (page) =>
          page
            .getByRole("button", { name: `Impersonate ${member.user.email}`, exact: true })
            .waitFor(),
        );
        yield* browser.checkpoint("Platform admin user search in the shared dev widget");
        yield* browser.use("Impersonate the member", (page) =>
          page
            .getByRole("button", { name: `Impersonate ${member.user.email}`, exact: true })
            .click(),
        );
        yield* browser.use("Return control stays visible", (page) =>
          page.getByRole("button", { name: "Return to my account", exact: true }).waitFor(),
        );
        const switched = yield* browser.use("Read the active identity", (page) =>
          page.request
            .get("/api/auth/get-session")
            .then((response) => response.json())
            .then(Schema.decodeUnknownSync(Identity)),
        );
        expect(switched.user.id).toBe(member.user.id);
        expect(switched.session.impersonatedBy).toBe(owner.user.id);
        expect(
          yield* browser.use("The member cannot list all users", (page) =>
            page.request.get("/api/auth/admin/list-users").then((response) => response.status()),
          ),
        ).toBe(403);
        yield* browser.checkpoint("Persistent impersonation status and return control");
        yield* browser.use("Return to the original admin", (page) =>
          page.getByRole("button", { name: "Return to my account", exact: true }).click(),
        );
        yield* browser.use("The normal widget returns", (page) =>
          page.getByRole("button", { name: "Open Executor dev tools", exact: true }).waitFor(),
        );
        const restored = yield* browser.use("Verify the restored identity", (page) =>
          page.request
            .get("/api/auth/get-session")
            .then((response) => response.json())
            .then(Schema.decodeUnknownSync(Identity)),
        );
        expect(restored.user.id).toBe(owner.user.id);
        expect(restored.session.impersonatedBy == null).toBe(true);
        expect(
          yield* browser.use("Platform access is restored", (page) =>
            page.request.get("/api/auth/admin/list-users").then((response) => response.status()),
          ),
        ).toBe(200);
      }),
    ),
  );
});
