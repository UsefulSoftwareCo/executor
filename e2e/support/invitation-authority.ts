import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Api, body } from "./api.ts";
import { Actors, password } from "./actors.ts";
import { Resource } from "./contracts.ts";
import { Target } from "./platform.ts";
import { freeSeat } from "./seats.ts";

const Invitations = Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String }));

export interface RoleStatement {
  readonly sql: string;
  readonly params: ReadonlyArray<string>;
}

type Write<E, R> = (
  statements: readonly [RoleStatement],
) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, E, R>;

const demoteAdmin = <E, R>(write: Write<E, R>) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const { userId } = yield* body(
      Schema.Struct({ userId: Schema.String }),
      yield* api.request(actors.admin, "GET", "/api/viewer"),
    );
    const demote: readonly [RoleStatement] = [
      {
        sql: `update member set role = 'member' where "organizationId" = $1 and "userId" = $2
          returning role`,
        params: [actors.organization.id, userId],
      },
    ];
    expect(yield* write(demote)).toEqual([[{ role: "member" }]]);
  });

export const staleInvitations = <E, R>(write: Write<E, R>) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      target = yield* Target;
    const cloud = target.metadata.target === "cloud";
    const organizationId = actors.organization.id;
    const invite = (email: string) =>
      Effect.gen(function* () {
        const response = yield* api.request(
          actors.admin,
          "POST",
          "/api/auth/organization/invite-member",
          { organizationId, email, role: "admin" },
        );
        expect(response.status).toBe(200);
        return (yield* body(Resource, response)).id;
      });
    const seat = yield* freeSeat;
    const returning = yield* invite(seat.email);
    const newcomer = "invited-before-demotion@example.test";
    const unregistered = cloud ? undefined : yield* invite(newcomer);
    yield* demoteAdmin(write);
    const invitations = yield* body(
      Invitations,
      yield* api.request(
        actors.owner,
        "GET",
        `/api/auth/organization/list-invitations?organizationId=${organizationId}`,
      ),
    );
    for (const id of [returning, unregistered].filter((id) => id !== undefined))
      expect(invitations.find((invitation) => invitation.id === id)?.status).toBe("pending");
    if (cloud) {
      const entry = yield* api.request(actors.member, "POST", "/api/onboarding/prepare");
      expect(entry.status).toBe(200);
      expect((yield* body(Schema.Struct({ status: Schema.String }), entry)).status).toBe("draft");
    }
    expect(
      (yield* api.request(actors.member, "POST", "/api/auth/organization/accept-invitation", {
        invitationId: returning,
      })).status,
    ).toBe(400);
    expect(
      (yield* api.request(actors.member, "GET", `/api/organizations/${organizationId}/access`))
        .status,
    ).toBe(403);
    if (unregistered !== undefined)
      expect(
        (yield* api.request(yield* api.session(), "POST", "/api/auth/self-host/register", {
          invitation: unregistered,
          email: newcomer,
          name: "Invited user",
          password,
        })).status,
      ).toBe(403);
  });

export const resentStaleInvitation = <E, R>(write: Write<E, R>) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const organizationId = actors.organization.id;
    const resend = (actor: typeof actors.owner, email: string) =>
      api.request(actor, "POST", "/api/auth/organization/invite-member", {
        organizationId,
        email,
        role: "admin",
        resend: true,
      });
    const seat = yield* freeSeat;
    const invited = yield* resend(actors.admin, seat.email);
    expect(invited.status).toBe(200);
    const { id } = yield* body(Resource, invited);
    yield* demoteAdmin(write);
    expect((yield* resend(actors.admin, seat.email)).status).toBe(403);
    const resent = yield* resend(actors.owner, seat.email);
    expect(resent.status).toBe(200);
    expect((yield* body(Resource, resent)).id).toBe(id);
    expect(
      (yield* api.request(actors.member, "POST", "/api/auth/organization/accept-invitation", {
        invitationId: id,
      })).status,
    ).toBe(200);
    expect(
      (yield* api.request(actors.member, "GET", `/api/organizations/${organizationId}/access`))
        .status,
    ).toBe(200);
  });
