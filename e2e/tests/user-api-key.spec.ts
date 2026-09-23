import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors, password } from "../support/actors.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withCase } from "../support/case.ts";

const Key = Schema.Struct({ key: Schema.RedactedFromValue(Schema.NonEmptyString) });
const Identity = Schema.Struct({ organization: Schema.String, role: Schema.String });
const Resource = Schema.Struct({ id: Schema.String });

layer(HostedLive, { excludeTestServices: true })("User API keys", (it) => {
  it.effect(scenarios.userApiKey.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const anonymous = yield* api.session();
        const prefix = `/api/organizations/${actors.organization.id}`;
        const ensure = (actor: Session) =>
          api.request(actor, "POST", "/api/auth/api-key/create", { name: "Lifecycle test" }).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.flatMap((response) => body(Key, response)),
            Effect.mapError(() => new Error("Could not obtain the user's API key")),
          );
        expect(
          (yield* api.request(anonymous, "POST", "/api/auth/api-key/create", {
            name: "Lifecycle test",
          })).status,
        ).toBe(401);
        expect(
          (yield* api.request(
            actors.owner,
            "POST",
            "/api/auth/api-key/create",
            { name: "Lifecycle test" },
            { origin: "https://foreign.example.test" },
          )).status,
        ).toBe(403);
        const owner = yield* evidence.step(
          "Concurrent creation issues independent user-owned keys",
          Effect.gen(function* () {
            const results = yield* Effect.forEach([0, 1, 2, 3], () => ensure(actors.owner), {
              concurrency: 4,
            });
            const first = results[0];
            if (first === undefined)
              return yield* Effect.fail(new Error("Missing creation result"));
            expect(new Set(results.map((result) => Redacted.value(result.key))).size).toBe(4);
            return first;
          }),
        );
        const named = (actor: Session) =>
          api
            .request(actor, "POST", "/api/auth/api-key/create", {
              name: "Lifecycle",
            })
            .pipe(
              Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
              Effect.flatMap((response) => body(Key, response)),
            );
        const ownerNamed = yield* named(actors.owner);
        const headers = { authorization: `Bearer ${Redacted.value(owner.key)}` };
        const ownContext = yield* api.request(anonymous, "GET", "/api/context", undefined, {
          ...headers,
          "x-executor-organization": actors.organization.id,
        });
        expect(ownContext.status).toBe(200);
        expect(yield* body(Identity, ownContext)).toEqual({
          organization: actors.organization.id,
          role: "owner",
        });
        expect(
          (yield* api.request(anonymous, "GET", `${prefix}/inventory`, undefined, headers)).status,
        ).toBe(200);
        expect(
          (yield* api.request(
            anonymous,
            "GET",
            "/api/organizations/org_other/inventory",
            undefined,
            headers,
          )).status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.owner, "GET", `${prefix}/inventory`, undefined, {
            authorization: "Bearer exu_" + "x".repeat(43),
          })).status,
        ).toBe(401);
        expect(
          (yield* api.request(anonymous, "GET", "/api/viewer", undefined, headers)).status,
        ).toBe(401);
        expect(
          (yield* api.request(
            anonymous,
            "POST",
            "/api/auth/api-key/create",
            { name: "Lifecycle test" },
            headers,
          )).status,
        ).toBe(403);
        const session = yield* body(
          Schema.Struct({ user: Schema.Record(Schema.String, Schema.Unknown) }),
          yield* api.request(actors.owner, "GET", "/api/auth/get-session"),
        );
        expect(Object.hasOwn(session.user, "executorApiKeyHash")).toBe(false);
        expect(Object.hasOwn(session.user, "executorApiKeyEncrypted")).toBe(false);

        yield* evidence.step(
          "Dashboard logout does not expire the API key",
          Effect.gen(function* () {
            const browser = yield* api.session();
            expect(
              (yield* api.request(browser, "POST", "/api/auth/sign-in/email", {
                email: "owner@example.test",
                password,
              })).status,
            ).toBe(200);
            const browserNamed = yield* named(browser);
            const repeated = yield* ensure(browser);
            expect(Redacted.value(repeated.key) === Redacted.value(owner.key)).toBe(false);
            expect((yield* api.request(browser, "POST", "/api/auth/sign-out", {})).status).toBe(
              200,
            );
            expect(
              (yield* api.request(anonymous, "GET", `${prefix}/inventory`, undefined, headers))
                .status,
            ).toBe(200);
            expect(
              (yield* api.request(anonymous, "GET", `${prefix}/inventory`, undefined, {
                authorization: `Bearer ${Redacted.value(browserNamed.key)}`,
              })).status,
            ).toBe(200);
            expect(
              (yield* api.request(anonymous, "GET", `${prefix}/inventory`, undefined, {
                authorization: `Bearer ${Redacted.value(ownerNamed.key)}`,
              })).status,
            ).toBe(200);
          }),
        );

        yield* evidence.step(
          "API keys check current membership and roles",
          Effect.gen(function* () {
            const email = `key-${randomUUID()}@example.test`;
            const invitation = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", "/api/auth/organization/invite-member", {
                email,
                role: "member",
                organizationId: actors.organization.id,
              }),
            );
            const member = yield* api.session();
            const registered = yield* api.request(member, "POST", "/api/auth/self-host/register", {
              invitation: invitation.id,
              email,
              password,
              name: "Key test member",
            });
            expect(registered.status).toBe(200);
            const key = yield* ensure(member);
            const memberNamed = yield* named(member);
            expect(Redacted.value(key.key) === Redacted.value(owner.key)).toBe(false);
            const memberHeaders = { authorization: `Bearer ${Redacted.value(key.key)}` };
            expect(
              (yield* api.request(
                anonymous,
                "GET",
                `${prefix}/inventory`,
                undefined,
                memberHeaders,
              )).status,
            ).toBe(200);
            expect(
              (yield* api.request(
                anonymous,
                "POST",
                `${prefix}/apps/deploy`,
                { name: "Denied", files: [{ path: "index.ts", content: "" }] },
                memberHeaders,
              )).status,
            ).toBe(403);
            expect(
              (yield* api.request(actors.owner, "POST", "/api/auth/organization/remove-member", {
                organizationId: actors.organization.id,
                memberIdOrEmail: email,
              })).status,
            ).toBe(200);
            expect(
              (yield* api.request(
                anonymous,
                "GET",
                `${prefix}/inventory`,
                undefined,
                memberHeaders,
              )).status,
            ).toBe(403);
            expect(
              (yield* api.request(anonymous, "GET", `${prefix}/inventory`, undefined, {
                authorization: `Bearer ${Redacted.value(memberNamed.key)}`,
              })).status,
            ).toBe(403);
          }),
        );
      }),
    ),
  );
});
