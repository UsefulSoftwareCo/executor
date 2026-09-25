/** Real self-host invitation registration, replay, concurrency and existing-account authority. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Api, body, type Session } from "../support/api.ts";
import { Actors, password } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Invitation redemption", (it) => {
  it.effect(scenarios.invitationRedemption.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const organizationId = actors.organization.id;
        const invite = (email: string, role: "admin" | "member") =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.admin,
              "POST",
              "/api/auth/organization/invite-member",
              { organizationId, email, role },
            );
            expect(response.status).toBe(200);
            return (yield* body(Resource, response)).id;
          });
        const register = (session: Session, invitation: string, email: string, secret = password) =>
          api.request(session, "POST", "/api/auth/self-host/register", {
            invitation,
            email,
            name: "Invited user",
            password: secret,
          });
        const email = "new-admin@example.test";
        const invitation = yield* invite(email, "admin");
        const recipient = yield* api.session();
        expect((yield* register(recipient, invitation, "wrong@example.test")).status).toBe(403);
        expect((yield* register(recipient, "unknown-invitation", email)).status).toBe(403);
        const rival = yield* api.session();
        const raced = yield* Effect.all(
          [register(recipient, invitation, email), register(rival, invitation, email)],
          { concurrency: 2 },
        );
        expect(raced.map((response) => response.status).sort()).toEqual([200, 403]);
        const login = yield* api.session();
        expect(
          (yield* api.request(login, "POST", "/api/auth/sign-in/email", { email, password }))
            .status,
        ).toBe(200);
        const access = yield* api.request(
          login,
          "GET",
          `/api/organizations/${organizationId}/access`,
        );
        expect(access.status).toBe(200);
        expect((yield* body(Schema.Struct({ role: Schema.String }), access)).role).toBe("admin");
        expect((yield* register(recipient, invitation, email)).status).toBe(403);
        const cancelledEmail = "cancelled@example.test";
        const cancelled = yield* invite(cancelledEmail, "member");
        expect(
          (yield* api.request(actors.admin, "POST", "/api/auth/organization/cancel-invitation", {
            invitationId: cancelled,
          })).status,
        ).toBe(200);
        expect((yield* register(recipient, cancelled, cancelledEmail)).status).toBe(403);
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/organization/remove-member", {
            organizationId,
            memberIdOrEmail: email,
          })).status,
        ).toBe(200);
        const readmission = yield* invite(email, "member");
        expect(
          (yield* register(recipient, readmission, email, "attacker-chosen-password")).status,
        ).toBe(403);
        expect((yield* register(recipient, readmission, email)).status).toBe(200);
        const readmitted = yield* api.request(
          recipient,
          "GET",
          `/api/organizations/${organizationId}/access`,
        );
        expect((yield* body(Schema.Struct({ role: Schema.String }), readmitted)).role).toBe(
          "member",
        );
        // A failed password check rolls back consumption; the original password and role survive.
        expect(
          (yield* api.request(yield* api.session(), "POST", "/api/auth/sign-in/email", {
            email,
            password: "attacker-chosen-password",
          })).status,
        ).toBe(401);
      }),
    ),
  );
});
