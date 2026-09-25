import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors, password } from "../support/actors.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";

const Resource = Schema.Struct({ id: Schema.String });

layer(HostedLive, { excludeTestServices: true })("Warm request auth", (it) => {
  it.effect(scenarios.warmRequestAuth.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        // The access route answers from the request checks alone, with no later membership read.
        const access = `/api/organizations/${actors.organization.id}/access`;
        const status = (actor: Session) =>
          api.request(actor, "GET", access).pipe(Effect.map((response) => response.status));
        const email = `warm-${randomUUID()}@example.test`;
        const invitation = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", "/api/auth/organization/invite-member", {
            email,
            role: "member",
            organizationId: actors.organization.id,
          }),
        );
        const member = yield* api.session();
        expect(
          (yield* api.request(member, "POST", "/api/auth/self-host/register", {
            invitation: invitation.id,
            email,
            password,
            name: "Warm request member",
          })).status,
        ).toBe(200);

        yield* evidence.step(
          "A signed-out session is refused on its next request",
          Effect.gen(function* () {
            // A second jar holds the same session token after the browser signs out.
            const copy = yield* api.session(yield* member.cookies);
            expect(yield* status(member)).toBe(200);
            expect(yield* status(copy)).toBe(200);
            expect((yield* api.request(member, "POST", "/api/auth/sign-out", {})).status).toBe(200);
            expect(yield* status(copy)).toBe(401);
          }),
        );

        yield* evidence.step(
          "A removed member's live session is refused on its next request",
          Effect.gen(function* () {
            const session = yield* api.session();
            expect(
              (yield* api.request(session, "POST", "/api/auth/sign-in/email", { email, password }))
                .status,
            ).toBe(200);
            expect(yield* status(session)).toBe(200);
            expect(
              (yield* api.request(actors.owner, "POST", "/api/auth/organization/remove-member", {
                organizationId: actors.organization.id,
                memberIdOrEmail: email,
              })).status,
            ).toBe(200);
            expect(yield* status(session)).toBe(403);
          }),
        );
      }),
    ),
  );
});
