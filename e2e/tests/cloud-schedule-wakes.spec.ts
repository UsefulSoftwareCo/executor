/**
 * Every write in every organization wakes Cloud's schedule coordinator after its response, and the
 * coordinator has one alarm. A wake must never move that alarm later: while wakes keep arriving
 * less than a second apart, due schedules and requested profile setup still run.
 */
import { expect, layer } from "@effect/vitest";
import { Clock, Duration, Effect, Exit, Fiber, Option, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { createProfile } from "../support/profiles.ts";
import { appsManifest } from "../support/apps-release.ts";

/** `tick` is next due an hour after it is enabled; `load` stays paused and only takes writes. */
const source = `import { defineApp, mutation, interval, object, router } from "apps";
const tick = mutation({ input: object({}) }, async () => ({ done: true }));
export default defineApp({ accounts: {} }, async () => ({ tools: router({ tick }), schedules: { tick: interval({ minutes: 60 }, tick, {}), load: interval({ minutes: 60 }, tick, {}) } }));`;

const Runs = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.String, status: Schema.String }),
);
const SetupStatus = Schema.Struct({ status: Schema.String });

/** Writes that each wake the coordinator once. CI stages saw about 14 a second. */
const wakeEvery = "200 millis";
/** Run Now and profile setup must both finish this long after they are sent, requests included. */
const deadlineMs = 20_000;
/**
 * A wake arms the coordinator's alarm a second out. A pause this long between wakes lets that
 * alarm fire even where every wake postpones it, so the run no longer holds the trigger.
 */
const pauseMs = 1_000;

/** When a wake may have armed the alarm. Each write starts its wake once it has answered. */
interface Moment {
  readonly start: number;
  readonly end: number;
}
/**
 * The longest time from `from` to `to` in which no moment's alarm write is certain, from the last
 * moment finished before `from`. Moments are ordered by end; a pause between two can last at most
 * from the earlier one's start to the later one's end. `to` closes the last pause, and a moment
 * not finished by `to` counts for nothing.
 */
const pauses = (moments: ReadonlyArray<Moment>, from: number, to: number) => {
  const finished = moments.filter(({ end }) => end <= to).sort((a, b) => a.end - b.end);
  const before = finished.findLastIndex(({ end }) => end < from);
  if (before === -1) return null;
  const chain = [...finished.slice(before), { start: to, end: to }];
  const gaps = chain.slice(1).map(({ end }, index) => end - chain[index]!.start);
  return {
    longestMs: Math.max(...gaps),
    leadingMs: gaps[0]!,
    trailingMs: gaps.at(-1)!,
    overHalfSecondMs: gaps.filter((gap) => gap >= pauseMs / 2),
  };
};

layer(HostedLive, { excludeTestServices: true })("Cloud schedule wakes", (it) => {
  it.effect(
    scenarios.cloudScheduleWakeStream.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            evidence = yield* Evidence;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Wakes ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source }, appsManifest],
          });
          expect(deployed.status).toBe(200);
          const app = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          const path = `${prefix}/apps/${app.id}`;
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
          const writes: Array<{ sentAt: number; answeredAt?: number; status?: number }> = [];
          const write = Effect.gen(function* () {
            const entry: (typeof writes)[number] = { sentAt: yield* Clock.currentTimeMillis };
            writes.push(entry);
            const exit = yield* Effect.exit(
              api.request(actors.owner, "PATCH", loadPath, { enabled: false }),
            );
            entry.answeredAt = yield* Clock.currentTimeMillis;
            entry.status = Exit.isSuccess(exit) ? exit.value.status : 0;
          });
          const answered = () => writes.filter((entry) => entry.answeredAt !== undefined);
          const outcome: { requested?: number; ended?: number; ran?: number; setUp?: number } = {};
          const report: Record<string, unknown> = { wakeEvery, deadlineMs, pauseMs };
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
          const setUp = Effect.gen(function* () {
            const profile = yield* createProfile(actors.owner, path);
            let status = "pending";
            yield* until(
              api.request(actors.owner, "GET", `${path}/profiles/${profile.id}`).pipe(
                Effect.flatMap((response) => body(SetupStatus, response)),
                Effect.map((current) => {
                  status = current.status;
                  return status !== "pending";
                }),
              ),
              "Profile setup has not finished",
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

          const answers = answered().map(({ answeredAt }) => ({
            start: answeredAt!,
            end: answeredAt!,
          }));
          const failed = answered().filter(({ status }) => status !== 200).length;
          const outstanding = writes.filter(
            ({ sentAt, answeredAt }) =>
              sentAt <= ended && (answeredAt === undefined || answeredAt > ended),
          ).length;
          const answerPauses = pauses(answers, requested, ended);
          report.window = {
            endedBy: Option.isSome(finished) ? "outcomes" : "deadline",
            lengthMs: ended - requested,
            outstandingAtEnd: outstanding,
          };
          report.answers = answerPauses;

          // Any pause lets main's alarm fire, so a run with one cannot tell the two apart.
          const interruptions = [
            failed > 0 ? `${failed} waking writes failed` : null,
            answerPauses === null
              ? "no waking write had answered before Run Now"
              : answerPauses.longestMs >= pauseMs
                ? `waking writes paused ${answerPauses.longestMs} ms between answers`
                : null,
          ].filter((reason) => reason !== null);
          if (answerPauses === null || interruptions.length > 0) {
            report.verdict = "invalid load";
            return yield* Effect.fail(
              new Error(
                `Invalid load condition: ${interruptions.join("; ")} within ${ended - requested} ms of Run Now. The coordinator's alarm could fire in a pause, so this run cannot show whether wakes postpone it.`,
              ),
            );
          }
          if (Option.isNone(finished)) {
            report.verdict = "starved";
            const pending = [
              outcome.ran === undefined ? "The due schedule has not run" : null,
              outcome.setUp === undefined ? "profile setup has not finished" : null,
            ].filter((reason) => reason !== null);
            return yield* Effect.fail(
              new Error(
                `${pending.join(" and ")} within ${deadlineMs} ms while coordinator wakes kept arriving (longest pause ${answerPauses.longestMs} ms)`,
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
