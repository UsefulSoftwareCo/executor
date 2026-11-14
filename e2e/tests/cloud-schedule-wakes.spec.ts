/**
 * Every write in every organization wakes Cloud's schedule coordinator after its response, and the
 * coordinator has one alarm. A wake must never move that alarm later: while wakes keep arriving
 * less than a second apart, due schedules and requested webhook source setup still run.
 *
 * Each wake's `schedule.wake` span records the coordinator's clock, the alarm it found and the
 * alarm it left. The scenario reads those spans from its own writes' traces, so whether a
 * wake postponed a pending alarm does not depend on how far apart the writes arrived.
 */
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

/**
 * `tick` is next due an hour after it is enabled; `load` stays paused and only takes writes.
 * Linking an account registers its webhook source in the background. The requirement accepts any
 * number of accounts, so `tick` runs the same before and after one is linked.
 */
const source = `import { defineApp, defineProvider, secrets, mutation, userInterval, object, string, router } from "apps";
const service = defineProvider({ name: "Wake fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
const incoming = { account: { user: "service" }, config: object({}), state: object({}),
  register: async () => ({}), unregister: async () => {}, handle: async () => new Response(null, { status: 204 }) };
const tick = mutation({ input: object({}) }, async () => ({ done: true }));
export default defineApp({ user: { accounts: { service: service.many() } } }, async () => ({ tools: router({ tick }), webhooks: { incoming }, schedules: { tick: userInterval({ minutes: 60 }, tick, {}), load: userInterval({ minutes: 60 }, tick, {}) } }));`;

const Runs = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.String, status: Schema.String }),
);

/** Writes that each wake the coordinator once. CI stages saw about 14 a second. */
const wakeEvery = "200 millis";
/**
 * Run Now and the linked account's webhook source setup must both finish this long after they are
 * sent, requests included.
 */
const deadlineMs = 20_000;
/** A wake brings the coordinator's alarm in to a second away, never further. */
const pollMs = 1_000;

/** What one wake did to the coordinator's alarm, from its span. */
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
          const loadPath = `${path}/schedules/load`;
          // Enabling the hourly schedule leaves the coordinator's next planned wake an hour away.
          expect(
            (yield* api.request(actors.owner, "PATCH", `${path}/schedules/tick`, {
              enabled: true,
              approvalMode: "automatic",
            })).status,
          ).toBe(200);

          // Each write is sent on time whether or not the one before has answered, so the wakes
          // keep arriving less than a second apart however long a request takes.
          // Each write has a trace of its own, which its wake's span joins.
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
          // Kept when an assertion fails and when it passes, so every run shows the stream it ran under.
          // CI keeps evidence files only for failed jobs; the test's metadata reaches results.json.
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

          // Both must finish while the writes go on: a coordinator whose alarm each wake moved a
          // second out runs neither until they stop. The deadline covers the requests and the polls.
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
          // Connecting an account from the app links it, which requests its webhook source setup.
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
          // Every write answered before the window closed woke the coordinator once. Its span
          // records what that wake did to the alarm, on the coordinator's own clock.
          const waking = answered().filter(
            ({ status, answeredAt }) => status === 200 && answeredAt! <= ended,
          );
          const isWake = (span: DeliveredSpan) =>
            span.operationName === "schedule.wake" &&
            span.tags["executor.schedule.wake.at"] !== undefined;
          // Read from the writes' own traces, once each has its wake's span.
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
          // A wake that found the alarm due within the next second is one a wake that moved the
          // alarm a second out would have postponed.
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
