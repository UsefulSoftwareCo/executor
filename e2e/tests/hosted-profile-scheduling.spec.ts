import { expect, layer } from "@effect/vitest";
import { Clock, Effect } from "effect";
import { body } from "../support/api.ts";
import { Resource } from "../support/contracts.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Profile, sharedProfileFixture } from "../support/hosted-profile.ts";
import { scenarios } from "../test-plan.ts";
layer(HostedLive, { excludeTestServices: true })("Hosted profiles", (it) => {
  it.effect(scenarios.hostedProfileScheduling.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, path, alice, bob } = yield* sharedProfileFixture;
        for (const [actor, id] of [
          [actors.member, alice.id],
          [actors.admin, bob.id],
        ] as const) {
          const deadline = (yield* Clock.currentTimeMillis) + 30000;
          for (;;) {
            const response = yield* api.request(actor, "POST", `${path}/profiles/${id}/reconcile`);
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const ready = yield* body(Profile, response);
            if (ready.status === "ready") break;
            expect(ready.status, JSON.stringify(response.body)).toBe("pending");
            expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
            yield* Effect.sleep("200 millis");
          }
          expect(
            (yield* api.request(actor, "PATCH", `${path}/schedules/tick`, {
              profile: id,
              enabled: true,
            })).status,
          ).toBe(200);
        }
        expect(
          (yield* api.request(actors.member, "PATCH", `${path}/schedules/tick`, {
            profile: bob.id,
            enabled: false,
          })).status,
        ).toBe(403);
        const run = yield* Effect.acquireRelease(
          api
            .request(actors.admin, "POST", `${path}/workflow-runs`, {
              profile: bob.id,
              workflow: "capture",
              input: {},
              key: "shared-context",
            })
            .pipe(Effect.flatMap((response) => body(Resource, response))),
          // The forbidden termination below must leave the run untouched. Its
          // actual owner releases it before profiles, accounts and the app.
          (run) =>
            Effect.gen(function* () {
              const stopped = yield* api.request(
                actors.admin,
                "POST",
                `${path}/workflow-runs/${run.id}/terminate`,
              );
              expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
              expect(stopped.body).toMatchObject({ id: run.id });
            }).pipe(Effect.orDie),
        );
        expect(
          (yield* api.request(actors.member, "GET", `${path}/workflow-runs/${run.id}`)).status,
        ).toBe(403);
        expect(
          (yield* api.request(actors.member, "POST", `${path}/workflow-runs/${run.id}/terminate`))
            .status,
        ).toBe(403);
      }),
    ),
  );
});
