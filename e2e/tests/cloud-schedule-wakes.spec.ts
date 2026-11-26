import { expect, layer } from "@effect/vitest";
import { Clock, Duration, Effect, Exit, Fiber, Option, Schedule, Schema } from "effect";
import { randomBytes, randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { type DeliveredSpan, Evidence, Telemetry } from "../support/evidence.ts";
import { appsManifest } from "../support/apps-release.ts";
import { removeAppWhenStopped, webhookSources } from "../support/webhook-sources.ts";
import { connectionsPath, unlinkAccount } from "../support/app-accounts.ts";

const source = `import { defineApp, defineProvider, secrets, mutation, userInterval, object, string, router } from "apps";
const service = defineProvider({ name: "Wake fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
const incoming = { account: { user: "service" }, config: object({}), state: object({}),
  register: async () => ({}), unregister: async () => {}, handle: async () => new Response(null, { status: 204 }) };
const tick = mutation({ input: object({}) }, async () => ({ done: true }));
export default defineApp({ user: { accounts: { service: service.many() } } }, async () => ({ tools: router({ tick }), webhooks: { incoming }, schedules: { tick: userInterval({ minutes: 60 }, tick, {}), load: userInterval({ minutes: 60 }, tick, {}) } }));`;

const Runs = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.String, status: Schema.String }),
);

const wakeEvery = "200 millis";
const deadlineMs = 20_000;
const pollMs = 1_000;

interface Wake {
  readonly span: string;
  readonly at: number;
  readonly armed: number;
  readonly pending: number | null;
}

layer(HostedLive, { excludeTestServices: true })("Cloud schedule wakes", (it) => {
  it.effect(
    scenarios.cloudScheduleWakeStream.title,
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
            name: `Wakes ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source }, appsManifest],
          });
          expect(deployed.status).toBe(200);
          const app = yield* body(App, deployed);
          const path = `${prefix}/apps/${app.id}`;
          const created: { account?: string } = {};
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              if (created.account !== undefined)
                yield* unlinkAccount(actors.owner, path, "service", created.account);
              yield* removeAppWhenStopped(actors.owner, path);
              if (created.account !== undefined)
                yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${created.account}`);
            }).pipe(Effect.orDie),
          );
          const loadPath = `${path}/schedules/load`;
          expect(
            (yield* api.request(actors.owner, "PATCH", `${path}/schedules/tick`, {
              enabled: true,
              approvalMode: "automatic",
            })).status,
          ).toBe(200);

          const writes: Array<{
            trace: string;
            sentAt: number;
            answeredAt?: number;
            status?: number;
          }> = [];
          const write = Effect.gen(function* () {
            const entry: (typeof writes)[number] = {
              trace: randomBytes(16).toString("hex"),
              sentAt: yield* Clock.currentTimeMillis,
            };
            writes.push(entry);
            const exit = yield* Effect.exit(
              api.request(
                actors.owner,
                "PATCH",
                loadPath,
                { enabled: false },
                { traceparent: `00-${entry.trace}-${randomBytes(8).toString("hex")}-01` },
              ),
            );
            entry.answeredAt = yield* Clock.currentTimeMillis;
            entry.status = Exit.isSuccess(exit) ? exit.value.status : 0;
          });
          const answered = () => writes.filter((entry) => entry.answeredAt !== undefined);
          const outcome: { requested?: number; ended?: number; ran?: number; setUp?: number } = {};
          const report: Record<string, unknown> = { wakeEvery, deadlineMs, pollMs };
          yield* Effect.addFinalizer(() =>
            Effect.suspend(() => {
              const after = (at: number | undefined) =>
                at === undefined || outcome.requested === undefined ? null : at - outcome.requested;
              const stream = {
                ...report,
                writes: {
                  sent: writes.length,
                  answered: answered().length,
                  failed: answered().filter(({ status }) => status !== 200).length,
                },
                endedAfterMs: after(outcome.ended),
                ranAfterMs: after(outcome.ran),
                setUpAfterMs: after(outcome.setUp),
              };
              Object.assign(context.task.meta, { wakeStream: stream });
              return evidence.json("wake-stream.json", stream);
            }),
          );
          const stream = yield* Effect.forkChild(write).pipe(
            Effect.repeat(Schedule.spaced(wakeEvery)),
            Effect.forkScoped,
          );
          yield* Effect.suspend(() =>
            answered().length >= 5
              ? Effect.void
              : Effect.fail(new Error(`${answered().length} of 5 waking writes have answered`)),
          ).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }));

          const requested = yield* Clock.currentTimeMillis;
          outcome.requested = requested;
          const until = <E, R>(check: Effect.Effect<boolean, E, R>, pending: string) =>
            check.pipe(
              Effect.flatMap((done) => (done ? Effect.void : Effect.fail(new Error(pending)))),
              Effect.retry({ schedule: Schedule.spaced("250 millis") }),
            );
          const ran = Effect.gen(function* () {
            expect(
              (yield* api.request(actors.owner, "POST", `${path}/schedules/tick/run`)).status,
            ).toBe(200);
            yield* until(
              api.request(actors.owner, "GET", `${prefix}/scheduled-runs?app=${app.id}`).pipe(
                Effect.flatMap((response) => body(Runs, response)),
                Effect.map((runs) =>
                  runs.some((run) => run.name === "tick" && run.status === "succeeded"),
                ),
              ),
              "The due schedule has not run",
            );
            outcome.ran = yield* Clock.currentTimeMillis;
          });
          const setUp = Effect.gen(function* () {
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
              { method: "key", label: "Wake fixture", fields: { token: "synthetic-wake" } },
            );
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            const account = (yield* body(Resource, saved)).id;
            created.account = account;
            let status = "pending";
            yield* until(
              webhookSources(actors.owner, path).pipe(
                Effect.map((sources) => {
                  status =
                    sources.find((source) => source.account === account)?.status ?? "pending";
                  return status !== "pending";
                }),
              ),
              "Webhook source setup has not finished",
            );
            outcome.setUp = yield* Clock.currentTimeMillis;
            return status;
          });
          const finished = yield* Effect.all([ran, setUp], { concurrency: 2 }).pipe(
            Effect.timeoutOption(Duration.millis(deadlineMs)),
          );
          const ended = yield* Clock.currentTimeMillis;
          outcome.ended = ended;
          yield* Fiber.interrupt(stream);

          report.window = {
            endedBy: Option.isSome(finished) ? "outcomes" : "deadline",
            lengthMs: ended - requested,
          };
          const waking = answered().filter(
            ({ status, answeredAt }) => status === 200 && answeredAt! <= ended,
          );
          const isWake = (span: DeliveredSpan) =>
            span.operationName === "schedule.wake" &&
            span.tags["executor.schedule.wake.at"] !== undefined;
          const wakes = (yield* telemetry.settled(
            waking.map(({ trace }) => trace),
            (spans) => spans.filter(isWake).length >= waking.length,
          ))
            .filter(isWake)
            .map((span): Wake => {
              const read = (name: string) => span.tags[`executor.schedule.wake.${name}`];
              const pending = read("pending");
              return {
                span: span.spanId,
                at: Number(read("at")),
                armed: Number(read("armed")),
                pending: pending === undefined ? null : Number(pending),
              };
            })
            .sort((left, right) => left.at - right.at);
          const contested = wakes.filter(
            ({ at, pending }) => pending !== null && pending > at && pending <= at + pollMs,
          );
          const postponed = wakes.filter(
            ({ armed, pending }) => pending !== null && armed > pending,
          );
          report.wakes = {
            read: wakes.length,
            contested: contested.length,
            postponed: postponed.length,
          };
          yield* evidence.json("wakes.json", wakes);
          for (const wake of wakes) {
            expect(Number.isFinite(wake.at), `wake ${wake.span} records its clock`).toBe(true);
            expect(Number.isFinite(wake.armed), `wake ${wake.span} records its alarm`).toBe(true);
          }
          expect(postponed, "No wake may move a pending alarm later than the one it found").toEqual(
            [],
          );
          expect(
            contested.length,
            "At least one wake must arrive while the alarm is due within the second",
          ).toBeGreaterThan(0);
          if (Option.isNone(finished)) {
            report.verdict = "starved";
            const pending = [
              outcome.ran === undefined ? "The due schedule has not run" : null,
              outcome.setUp === undefined ? "webhook source setup has not finished" : null,
            ].filter((reason) => reason !== null);
            return yield* Effect.fail(
              new Error(
                `${pending.join(" and ")} within ${deadlineMs} ms while coordinator wakes kept arriving`,
              ),
            );
          }
          report.verdict = "finished";
          expect(finished.value[1]).toBe("ready");
        }),
      ),
    { timeout: 120_000 },
  );
});
