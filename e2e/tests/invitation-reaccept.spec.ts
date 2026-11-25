import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";

const SessionIdentity = Schema.Struct({ user: Schema.Struct({ email: Schema.String }) });

layer(HostedLive, { excludeTestServices: true })("Invitation reaccept", (it) => {
  it.effect(scenarios.invitationReaccept.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const organizationId = actors.organization.id;
        const { user } = yield* body(
          SessionIdentity,
          yield* api.request(actors.member, "GET", "/api/auth/get-session"),
        );
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/organization/remove-member", {
            organizationId,
            memberIdOrEmail: user.email,
          })).status,
        ).toBe(200);
        const invite = Effect.gen(function* () {
          const invited = yield* api.request(
            actors.owner,
            "POST",
            "/api/auth/organization/invite-member",
            { organizationId, email: user.email, role: "member", resend: true },
          );
          expect(invited.status).toBe(200);
          return (yield* body(Resource, invited)).id;
        });
        const accept = (step: string, invitation: string) =>
          Effect.gen(function* () {
            yield* browser.use(`${step}: open the invitation link`, (page) =>
              page.goto(`/invite?invitation=${encodeURIComponent(invitation)}`),
            );
            yield* browser.use(`${step}: accept`, (page) =>
              page.getByRole("button", { name: "Accept invitation", exact: true }).click(),
            );
            return yield* browser.use(`${step}: wait for the outcome`, (page) =>
              Promise.race([
                page
                  .getByRole("alert")
                  .waitFor({ state: "visible" })
                  .then(() => page.getByRole("alert").textContent()),
                page.waitForURL((url) => url.pathname !== "/invite").then(() => null),
                page
                  .getByRole("heading", { name: "You're already in this organization" })
                  .waitFor({ state: "visible" })
                  .then(() => "already a member"),
              ]),
            );
          });
        yield* browser.login(actors.member);

        const revoked = yield* invite;
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/organization/cancel-invitation", {
            invitationId: revoked,
          })).status,
        ).toBe(200);
        const revokedAlert = yield* accept("Revoked invitation", revoked);
        yield* browser.checkpoint("Opened a revoked invitation");
        expect(revokedAlert).toContain("already been used, was revoked, or has expired");

        const invitation = yield* invite;
        expect(yield* accept("First visit", invitation)).toBeNull();
        const access = yield* api.request(
          actors.member,
          "GET",
          `/api/organizations/${organizationId}/access`,
        );
        expect(access.status).toBe(200);
        yield* browser.checkpoint("Joined the organization");
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/organization/cancel-invitation", {
            invitationId: invitation,
          })).status,
        ).toBe(400);

        const reopened = yield* accept("Second visit", invitation);
        yield* browser.checkpoint("Reopened an accepted invitation");
        expect(reopened).toBe("already a member");
        const organizations = yield* body(
          Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
          yield* api.request(actors.member, "GET", "/api/auth/organization/list"),
        );
        const name = organizations.find((item) => item.id === organizationId)?.name;
        expect(name).toBeDefined();
        expect(
          yield* browser.use("The page names the organization", (page) =>
            page.locator("main, body").first().textContent(),
          ),
        ).toContain(`You've already joined ${name} with this invitation.`);
        yield* browser.use("Continue into the organization", (page) =>
          page.getByRole("button", { name: "Continue", exact: true }).click(),
        );
        yield* browser.use("Continue leaves the invitation page", (page) =>
          page.waitForURL((url) => url.pathname !== "/invite"),
        );
        yield* browser.checkpoint("Continued into the organization");
      }),
    ),
  );
});
