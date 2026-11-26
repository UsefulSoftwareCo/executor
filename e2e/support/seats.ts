import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "./actors.ts";
import { Api, body } from "./api.ts";
import { Resource } from "./contracts.ts";

const SessionIdentity = Schema.Struct({ user: Schema.Struct({ email: Schema.String }) });

export const freeSeat = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
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
  const rejoin = Effect.gen(function* () {
    const invited = yield* api.request(
      actors.owner,
      "POST",
      "/api/auth/organization/invite-member",
      { organizationId, email: user.email, role: "member", resend: true },
    );
    expect(invited.status).toBe(200);
    const invitation = yield* body(Resource, invited);
    expect(
      (yield* api.request(actors.member, "POST", "/api/auth/organization/accept-invitation", {
        invitationId: invitation.id,
      })).status,
    ).toBe(200);
  });
  return { email: user.email, rejoin };
});
