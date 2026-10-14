/**
 * A deploy leaves every webhook source of its app `pending` until setup registers its webhooks on
 * the new deployment. Each deploy wakes webhook source setup (Cloud's schedule coordinator,
 * self-host's setup worker), so setup reaches the new deployment without a reconcile and without
 * waiting for polling. A schedule keeps its saved setting when its timing changes. Member setup,
 * which links the default Executor app's managed key and redeploys that app, wakes setup from the
 * background job it runs in.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource, type SpanQuery } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { appsManifest } from "../support/apps-release.ts";
import { removeAppWhenStopped } from "../support/webhook-sources.ts";
import { connectionsPath, unlinkAccount } from "../support/app-accounts.ts";

/** A linked account's webhook source registers `incoming` on each deployment. */
const source = (
  timing: string,
) => `import { defineApp, defineProvider, secrets, mutation, userInterval, userCron, object, string, router } from "apps";
const service = defineProvider({ name: "Deploy setup fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
const incoming = { account: { user: "service" }, config: object({}), state: object({}),
  register: async () => ({}), unregister: async () => {}, handle: async () => new Response(null, { status: 204 }) };
const tick = mutation({ input: object({}) }, async () => ({ done: true }));
export default defineApp({ user: { accounts: { service } } }, async () => ({ tools: router({ tick }), webhooks: { incoming }, schedules: { tick: ${timing} } }));`;
const hourly = "userInterval({ hours: 24 }, tick, {})";
const daily = 'userCron({ expression: "0 9 * * *", timezone: "UTC" }, tick, {})';

const Deployed = Schema.Struct({ ...App.fields, activeDeployment: Schema.String });
const Redeployed = Schema.Struct({ app: Deployed });
/** A webhook source's setup state: the deployment its webhooks were last registered on. */
const Sources = Schema.Array(
  Schema.Struct({
    account: Schema.String,
    status: Schema.String,
    reconciledDeployment: Schema.NullOr(Schema.String),
  }),
);
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

/** The trace holds a setup wake that a committed change asked for. */
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
            evidence = yield* Evidence;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Deploy setup ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source(hourly) }, appsManifest],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(Deployed, deployed);
          const path = `${prefix}/apps/${app.id}`;
          const created: { account?: string } = {};
          // Unlinking removes the webhook source; the app is removable once its webhook stops.
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              if (created.account !== undefined)
                yield* unlinkAccount(actors.owner, path, "service", created.account);
              yield* removeAppWhenStopped(actors.owner, path);
              if (created.account !== undefined)
                yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${created.account}`);
            }).pipe(Effect.orDie),
          );
          // Connecting an account from the app links it, which makes it a webhook source.
          const connection = yield* api.request(
            actors.owner,
            "POST",
            connectionsPath(path, "user", "service"),
            {},
          );
          expect(connection.status, JSON.stringify(connection.body)).toBe(200);
          const saved = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${(yield* body(Resource, connection)).id}/submit`,
            { method: "key", label: "Deploy setup", fields: { token: "synthetic-deploy" } },
          );
          expect(saved.status, JSON.stringify(saved.body)).toBe(200);
          const account = (yield* body(Resource, saved)).id;
          created.account = account;
          const readSetup = api.request(actors.owner, "GET", `${path}/webhook-sources`).pipe(
            Effect.flatMap((response) => body(Sources, response)),
            Effect.map((sources) => {
              const source = sources.find((item) => item.account === account);
              return {
                status: source?.status ?? "missing",
                reconciledDeployment: source?.reconciledDeployment ?? null,
              };
            }),
          );
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
          yield* setUp("link", app.activeDeployment);
          expect(
            (yield* api.request(actors.owner, "PATCH", `${path}/schedules/tick`, {
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
            yield* api.request(actors.owner, "GET", `${path}/schedules`),
          );
          // The setting saved for the interval schedule carries over to its cron timing.
          expect(schedules).toEqual([
            expect.objectContaining({ name: "tick", enabled: true, timing: { kind: "cron" } }),
          ]);
          const unchanged = yield* redeploy("unchanged source", daily);
          expect(unchanged).not.toBe(cron);
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
          // linked the owner's default Executor key in a background provisioning job.
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
                : Effect.fail(new Error("No provisioning job woke webhook source setup")),
            ),
            Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
          );
          yield* evidence.json("member-setup-wakes.json", woken);
        }),
      ),
    { timeout: 60_000 },
  );
});
