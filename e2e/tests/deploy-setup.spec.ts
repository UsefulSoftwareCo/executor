/**
 * A deploy moves every profile of its app to the new deployment and leaves them `pending` until
 * setup re-registers their schedules. Each deploy wakes profile setup (Cloud's schedule
 * coordinator, self-host's setup worker), so setup reaches the new deployment without a reconcile
 * and without waiting for polling. Member setup, which saves the default Executor profile and
 * redeploys the default Executor app, wakes setup from the background job it runs in.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, type SpanQuery } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { createProfile } from "../support/profiles.ts";
import { appsManifest } from "../support/apps-release.ts";

const source = (
  timing: string,
) => `import { defineApp, mutation, interval, cron, object, router } from "apps";
const tick = mutation({ input: object({}) }, async () => ({ done: true }));
export default defineApp({ accounts: {} }, async () => ({ tools: router({ tick }), schedules: { tick: ${timing} } }));`;
const hourly = "interval({ hours: 24 }, tick, {})";
const daily = 'cron({ expression: "0 9 * * *", timezone: "UTC" }, tick, {})';

const Deployed = Schema.Struct({ ...App.fields, activeDeployment: Schema.String });
const Redeployed = Schema.Struct({ app: Deployed });
const Setup = Schema.Struct({
  status: Schema.String,
  reconciledDeployment: Schema.NullOr(Schema.String),
});
const Schedules = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    enabled: Schema.Boolean,
    timing: Schema.Struct({ kind: Schema.String }),
  }),
);
/**
 * Setup must reach the new deployment this soon after its deploy answers. Without a wake Cloud
 * waits for the coordinator's minute heartbeat, which stalled a redeploy for over 20 s.
 */
const deadline = "15 seconds";

/** The trace holds a profile setup wake that a committed change asked for. */
const wakes = (trace: (typeof SpanQuery.Type)["data"]) =>
  trace.some(
    ({ span }) =>
      span.operationName === "schedule.wake" && span.tags["executor.schedule.wake"] === "change",
  );

layer(HostedLive, { excludeTestServices: true })("Deploy setup", (it) => {
  it.effect(
    scenarios.deploySetup.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            evidence = yield* Evidence,
            telemetry = yield* Telemetry;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Deploy setup ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source(hourly) }, appsManifest],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(Deployed, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          const path = `${prefix}/apps/${app.id}`;
          const profile = yield* createProfile(actors.owner, path);
          const readSetup = api
            .request(actors.owner, "GET", `${path}/profiles/${profile.id}`)
            .pipe(Effect.flatMap((response) => body(Setup, response)));
          const observed: Array<{ step: string; status: string; current: boolean }> = [];
          yield* Effect.addFinalizer(() => evidence.json("setup-observations.json", observed));
          /** Setup is ready for exactly this deployment, not still on the one before. */
          const setUp = (step: string, deployment: string) =>
            readSetup.pipe(
              Effect.tap((setup) =>
                Effect.sync(() =>
                  observed.push({
                    step,
                    status: setup.status,
                    current: setup.reconciledDeployment === deployment,
                  }),
                ),
              ),
              Effect.flatMap((setup) =>
                setup.status === "ready" && setup.reconciledDeployment === deployment
                  ? Effect.void
                  : Effect.fail(
                      new Error(`${step}: setup is ${setup.status} on the earlier deployment`),
                    ),
              ),
              Effect.retry({ schedule: Schedule.spaced("250 millis") }),
              Effect.timeout(deadline),
              Effect.catchTag("TimeoutError", () =>
                Effect.fail(
                  new Error(
                    `${step}: setup did not reach deployment ${deployment} within ${deadline}`,
                  ),
                ),
              ),
            );
          yield* setUp("create", app.activeDeployment);
          expect(
            (yield* api.request(actors.owner, "PATCH", `${path}/schedules/tick`, {
              profile: profile.id,
              enabled: true,
              approvalMode: "automatic",
            })).status,
          ).toBe(200);

          const redeploy = (step: string, timing: string) =>
            Effect.gen(function* () {
              // Files deploy straight to the app: local Cloud has no Git storage for commits.
              const response = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
                files: [{ path: "index.ts", content: source(timing) }, appsManifest],
              });
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              const { app: live } = yield* body(Redeployed, response);
              yield* setUp(step, live.activeDeployment);
              return live.activeDeployment;
            });
          const cron = yield* redeploy("interval to cron", daily);
          const schedules = yield* body(
            Schedules,
            yield* api.request(actors.owner, "GET", `${path}/schedules?profile=${profile.id}`),
          );
          // The setting saved for the interval schedule carries over to its cron timing.
          expect(schedules).toEqual([
            expect.objectContaining({ name: "tick", enabled: true, timing: { kind: "cron" } }),
          ]);
          const unchanged = yield* redeploy("unchanged source", daily);
          expect(unchanged).not.toBe(cron);

          // Each deploy's own request woke setup: setup above did not ride on a wake some other
          // write happened to send.
          const traces = (yield* evidence.requests)
            .filter((request) => request.method === "POST" && request.path === `${path}/deploy`)
            .map(({ traceId }) => traceId);
          expect(traces).toHaveLength(2);
          const woken = yield* Effect.forEach(traces, (traceId) =>
            telemetry.query(traceId).pipe(
              Effect.flatMap(({ data }) =>
                wakes(data) ? Effect.void : Effect.fail(new Error(`No setup wake in ${traceId}`)),
              ),
              Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
              Effect.as(traceId),
            ),
          );
          expect(woken).toEqual(traces);
        }),
      ),
    { timeout: 120_000 },
  );

  it.effect(
    scenarios.memberSetupWake.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const evidence = yield* Evidence,
            telemetry = yield* Telemetry;
          // Creating the organization queued its installation and its owner's member setup, which
          // saved the owner's default Executor profile in a background provisioning job.
          yield* Actors;
          const woken = yield* telemetry.search("hosted.provision", {}).pipe(
            Effect.flatMap(({ data }) =>
              Effect.forEach(
                [...new Set(data.map(({ traceId }) => traceId))],
                (traceId) =>
                  telemetry
                    .query(traceId)
                    .pipe(Effect.map(({ data: trace }) => (wakes(trace) ? [traceId] : []))),
                { concurrency: 4 },
              ),
            ),
            Effect.map((found) => found.flat()),
            Effect.flatMap((found) =>
              found.length > 0
                ? Effect.succeed(found)
                : Effect.fail(new Error("No provisioning job woke profile setup")),
            ),
            Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
          );
          yield* evidence.json("member-setup-wakes.json", woken);
        }),
      ),
    { timeout: 60_000 },
  );
});
