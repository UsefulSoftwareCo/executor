/** Both hosted products run the same membership, browser review and creator-revocation scenario. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

const Settings = Schema.Struct({ actor: Schema.String });
const Runs = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    status: Schema.String,
    failure: Schema.NullOr(Schema.String),
  }),
);
class Pending extends Schema.TaggedError<Pending>()("Pending", {}) {}
const source = `import { defineApp, mutation, interval, object } from "apps";
import { always } from "apps/operations/approval";
const work = mutation({ input: object({}), approval: always() }, async () => ({ done: true }));
export default defineApp({ accounts: {} }, async () => ({  mutations: { work }, schedules: { review: interval({ minutes: 1 }, work, {}), creator: interval({ minutes: 1 }, work, {}) } }));`;
layer(HostedLive, { excludeTestServices: true })("Hosted schedules", (it) => {
  it.effect(scenarios.hostedSchedules.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const created = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Scheduled ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }],
        });
        expect(created.status).toBe(200);
        const app = yield* body(Schema.Struct({ id: Schema.String }), created);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const path = `${prefix}/apps/${app.id}/schedules`;
        expect(
          (yield* api.request(actors.member, "PATCH", `${path}/review`, {
            enabled: true,
            approvalMode: "automatic",
          })).status,
        ).toBe(403);
        expect(
          (yield* api.request(
            actors.member,
            "GET",
            `/api/organizations/foreign/apps/${app.id}/schedules`,
          )).status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/review`, {
            enabled: true,
            approvalMode: "browser",
          })).status,
        ).toBe(200);
        const runs = api
          .request(actors.owner, "GET", `${prefix}/scheduled-runs?app=${app.id}`)
          .pipe(Effect.flatMap((response) => body(Runs, response)));
        const waitFor = (name: string, status: string) =>
          runs.pipe(
            Effect.flatMap((rows) => {
              const found = rows.find((row) => row.name === name && row.status === status);
              return found ? Effect.succeed(found) : Effect.fail(new Pending());
            }),
            Effect.retry({
              while: (error) => error instanceof Pending,
              schedule: Schedule.spaced("100 millis"),
            }),
            Effect.timeout("20 seconds"),
          );
        expect((yield* api.request(actors.member, "POST", `${path}/review/run`)).status).toBe(403);
        expect((yield* api.request(actors.owner, "POST", `${path}/review/run`)).status).toBe(200);
        const pending = yield* waitFor("review", "awaiting-approval");
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/review`, { enabled: false })).status,
        ).toBe(200);
        const endpoint = `${prefix}/scheduled-runs/${pending.id}/approval`;
        expect((yield* api.request(actors.member, "GET", endpoint)).status).toBe(403);
        expect((yield* api.request(actors.owner, "GET", endpoint)).body).toMatchObject({
          status: "pending",
        });
        expect(
          (yield* api.request(actors.owner, "POST", endpoint, {
            response: { action: "accept", content: {} },
          })).body,
        ).toEqual({ status: "answered" });
        yield* waitFor("review", "succeeded");

        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/access`),
        );
        const shared = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          }),
        );
        const configured = yield* api.request(actors.admin, "PATCH", `${path}/creator`, {
          enabled: true,
          approvalMode: "automatic",
        });
        expect(configured.status).toBe(200);
        expect((yield* body(Settings, configured)).actor).toBeTruthy();
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/access`, {
            revision: shared.revision,
            audience: { kind: "private" },
          })).status,
        ).toBe(200);
        expect((yield* api.request(actors.owner, "POST", `${path}/creator/run`)).status).toBe(200);
        expect((yield* waitFor("creator", "failed")).failure).toBe("OrganizationForbidden");
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/creator`, { enabled: false })).status,
        ).toBe(200);
      }),
    ),
  );
});
