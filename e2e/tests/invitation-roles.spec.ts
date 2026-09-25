/** Role boundaries through the real Better Auth HTTP API, including invitation resend. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

const Invitation = Schema.Struct({ id: Schema.String, email: Schema.String, role: Schema.String });
layer(HostedLive, { excludeTestServices: true })("Invitation roles", (it) => {
  it.effect(scenarios.invitationRoles.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const organizationId = actors.organization.id;
        const invite = (actor: typeof actors.admin, role: unknown, email: string, resend = false) =>
          api.request(actor, "POST", "/api/auth/organization/invite-member", {
            organizationId,
            email,
            role,
            resend,
          });
        const listPath = `/api/auth/organization/list-invitations?organizationId=${organizationId}`;
        const initial = yield* body(
          Schema.Array(Invitation),
          yield* api.request(actors.owner, "GET", listPath),
        );
        const initialIds = new Set(initial.map((invitation) => invitation.id));
        // This is the reported attack: native permission checks trim this value differently.
        expect((yield* invite(actors.admin, "admin, owner", "attack@example.test")).status).toBe(
          400,
        );
        for (const actor of [actors.owner, actors.admin]) {
          for (const role of [
            "owner",
            "admin,owner",
            " owner",
            "admin ",
            "member, admin",
            ["admin", "owner"],
            ["member"],
            "",
          ]) {
            expect((yield* invite(actor, role, "invalid@example.test")).status).toBe(400);
          }
        }
        for (const role of ["admin", "member"]) {
          const email = `invited-${role}@example.test`;
          const created = yield* invite(actors.admin, role, email);
          expect(created.status).toBe(200);
          const invitation = yield* body(Invitation, created);
          expect(invitation.role).toBe(role);
          expect((yield* invite(actors.admin, "admin, owner", email, true)).status).toBe(400);
          const resent = yield* invite(actors.admin, role, email, true);
          expect(resent.status).toBe(200);
          expect(yield* body(Invitation, resent)).toEqual(invitation);
          expect((yield* invite(actors.member, role, `denied-${email}`)).status).toBe(403);
        }
        const listed = yield* api.request(
          actors.owner,
          "GET",
          `/api/auth/organization/list-invitations?organizationId=${organizationId}`,
        );
        expect(listed.status).toBe(200);
        expect(
          (yield* body(Schema.Array(Invitation), listed))
            .filter((invite) => !initialIds.has(invite.id))
            .map((invite) => invite.role)
            .sort(),
        ).toEqual(["admin", "member"]);
      }),
    ),
  );
});
