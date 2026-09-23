import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withCase } from "../support/case.ts";

const Key = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });
const Keys = Schema.Struct({ apiKeys: Schema.Array(Schema.Struct({ id: Schema.String })) });
const Resource = Schema.Struct({ id: Schema.String });
const SessionIdentity = Schema.Struct({ user: Schema.Struct({ email: Schema.String }) });

layer(HostedLive, { excludeTestServices: true })("Membership API keys", (it) => {
  it.effect(scenarios.memberApiKeys.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const anonymous = yield* api.session();
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const lifecycle = "/api/auth/api-key";
        const { user } = yield* body(
          SessionIdentity,
          yield* api.request(actors.admin, "GET", "/api/auth/get-session"),
        );
        const keys: { actor: Session; id: string }[] = [];
        let removed = false;
        const rejoin = Effect.gen(function* () {
          const invited = yield* api.request(
            actors.owner,
            "POST",
            "/api/auth/organization/invite-member",
            {
              organizationId: organization,
              email: user.email,
              role: "admin",
              resend: true,
            },
          );
          expect(invited.status).toBe(200);
          const invitation = yield* body(Resource, invited);
          expect(
            (yield* api.request(actors.admin, "POST", "/api/auth/organization/accept-invitation", {
              invitationId: invitation.id,
            })).status,
          ).toBe(200);
          removed = false;
        });
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (removed) yield* rejoin;
            for (const key of keys)
              yield* api.request(key.actor, "POST", `${lifecycle}/delete`, { keyId: key.id });
          }).pipe(Effect.orDie),
        );
        const create = (actor: Session, pinned: boolean) =>
          Effect.gen(function* () {
            const response = yield* api.request(actor, "POST", `${lifecycle}/create`, {
              name: "Membership lifecycle",
              ...(pinned ? { metadata: { organization } } : {}),
            });
            expect(response.status).toBe(200);
            const key = yield* body(Key, response);
            keys.push({ actor, id: key.id });
            return key;
          });
        const request = (key: typeof Key.Type) =>
          api.request(anonymous, "GET", `${prefix}/inventory`, undefined, {
            authorization: `Bearer ${Redacted.value(key.key)}`,
          });
        const fullAccount = yield* create(actors.admin, false);
        const otherUser = yield* create(actors.owner, true);
        for (const actor of [actors.admin, actors.owner]) {
          yield* evidence.step(
            actor === actors.admin
              ? "Self-removal revokes pinned keys"
              : "Owner removal revokes pinned keys",
            Effect.gen(function* () {
              const pinned = yield* create(actors.admin, true);
              expect((yield* request(pinned)).status).toBe(200);
              expect(
                (yield* api.request(actor, "POST", "/api/auth/organization/remove-member", {
                  organizationId: organization,
                  memberIdOrEmail: user.email,
                })).status,
              ).toBe(200);
              removed = true;
              const listed = yield* body(
                Keys,
                yield* api.request(actors.admin, "GET", `${lifecycle}/list`),
              );
              expect(listed.apiKeys.map((key) => key.id)).not.toContain(pinned.id);
              expect(listed.apiKeys.map((key) => key.id)).toContain(fullAccount.id);
              expect((yield* request(pinned)).status).toBe(401);
              expect((yield* request(fullAccount)).status).toBe(403);
              expect((yield* request(otherUser)).status).toBe(200);
              expect(
                (yield* api.request(actors.admin, "POST", `${lifecycle}/create`, {
                  name: "Cannot replace removed key",
                  metadata: { organization },
                })).status,
              ).toBe(403);
              yield* rejoin;
              expect((yield* request(pinned)).status).toBe(401);
              expect((yield* request(fullAccount)).status).toBe(200);
              const replacement = yield* create(actors.admin, true);
              expect((yield* request(replacement)).status).toBe(200);
            }),
          );
        }
      }),
    ),
  );
});
