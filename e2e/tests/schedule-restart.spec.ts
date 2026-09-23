/** A stopped real local process must coalesce missed intervals and retain browser approvals. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { Api, body } from "../support/api.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const Runs = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.String, status: Schema.String }),
);
class Pending extends Schema.TaggedError<Pending>()("Pending", {}) {}
const source = `import { defineApp, mutation, interval, object } from "apps";
import { always } from "apps/operations/approval";
const tick = mutation({ input: object({}) }, async () => ({ done: true }));
const review = mutation({ input: object({}), approval: always() }, async () => ({ done: true }));
export default defineApp({ accounts: {} }, async () => ({  mutations: { tick, review }, schedules: { tick: interval({ minutes: 1 }, tick, {}), review: interval({ minutes: 1 }, review, {}) } }));`;
layer(TestLive, { excludeTestServices: true })("Schedule persistence", (it) => {
  it.effect(scenarios.scheduleRestart.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const created = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: "Restart fixture",
            files: [{ path: "index.ts", content: source }],
          },
          headers,
        );
        expect(created.status).toBe(200);
        const { app } = yield* body(
          Schema.Struct({ app: Schema.Struct({ id: Schema.String }) }),
          created,
        );
        yield* Effect.addFinalizer(() =>
          serverControl("start").pipe(
            Effect.andThen(session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers)),
            Effect.orDie,
          ),
        );
        const configure = (
          name: string,
          enabled: boolean,
          approvalMode: "automatic" | "browser" = "automatic",
        ) =>
          Effect.gen(function* () {
            expect(
              (yield* session.send(
                "PATCH",
                `/v1/apps/${app.id}/schedules/${name}`,
                { actor: "local", enabled, approvalMode },
                headers,
              )).status,
            ).toBe(200);
          });
        const runs = session
          .send("GET", `/v1/scheduled-runs?app=${app.id}`, undefined, headers)
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
            Effect.timeout("15 seconds"),
          );
        yield* configure("tick", true);
        yield* serverControl("stop");
        // Deliberate downtime outlasts the schedule's whole interval, so its one due tick is
        // missed entirely. Intervals are floored at one minute, so this wait is a real minute.
        yield* Effect.sleep("100 seconds");
        yield* serverControl("start");
        yield* waitFor("tick", "succeeded");
        yield* configure("tick", false);
        expect((yield* runs).filter((run) => run.name === "tick")).toHaveLength(1);

        yield* configure("review", true, "browser");
        expect(
          (yield* session.send("POST", `/v1/apps/${app.id}/schedules/review/run`, {}, headers))
            .status,
        ).toBe(200);
        const pending = yield* waitFor("review", "awaiting-approval");
        yield* configure("review", false, "browser");
        yield* serverControl("restart");
        expect((yield* runs).find((run) => run.id === pending.id)?.status).toBe(
          "awaiting-approval",
        );
        const paired = yield* api.session();
        const link = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* paired.send("POST", "/auth/pair", undefined, headers),
        );
        expect(
          (yield* api.request(paired, "POST", "/auth/exchange", {
            token: new URL(link.url).hash.slice("#pair=".length),
          })).status,
        ).toBe(200);
        const endpoint = `/dashboard/api/scheduled-runs/${pending.id}/approval`;
        expect((yield* api.request(paired, "GET", endpoint)).body).toMatchObject({
          status: "pending",
        });
        expect(
          (yield* api.request(paired, "POST", endpoint, {
            response: { action: "accept", content: {} },
          })).body,
        ).toEqual({ status: "answered" });
        yield* waitFor("review", "succeeded");
        expect((yield* runs).filter((run) => run.name === "review")).toHaveLength(1);
      }),
    ),
  );
});
