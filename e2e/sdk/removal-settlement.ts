/**
 * The end-of-run check of a Cloud run's organization removals. Each scenario's clean-up returns
 * once the product has accepted its organization's removal and the organization refuses its owner
 * (`/remove` in apps/hosted/testing/scenario-server.ts). The erasure runs on in the product's
 * removal Workflow, so this check runs once, after the scenarios and before the stage or local
 * Cloud is torn down, until every accepted removal has finished (no organization row, the removal
 * `done`, the scenario's users deleted) or `removalDeadlineMs` has passed.
 *
 * It asks the fixture server for one look at a time (`/settle`), each answered within about 10 s,
 * and asks again 2 s after each answer. A request that fails or takes longer than
 * `settleRequestTimeout` is counted as dropped and asked again; it is never taken as the answer.
 *
 * When the check returns or fails, it writes `report/removals.json` from the last answer it got
 * (not when the runner is killed mid-check: then nothing is written),
 * appends a line per removal still unfinished to `removal-stalls.jsonl` (a deployed runner then
 * saves its Workflow instance and the Worker's logs before destroying the stage,
 * `removal-evidence.ts`), prints how long the check took and how much of it was spent waiting for
 * the product, and fails naming each removal not finished, each scenario whose removal was never
 * accepted, or the server that never answered.
 */
import { Cause, Clock, Console, Effect, Exit, FileSystem, Path, Schema } from "effect";
import { FixtureFailed, fixtureRequest, type FixtureControl } from "./fixtures.ts";

export const removalSettlementFile = "removals.json";

/**
 * How long the check waits, from its start, for removals still running: the longest an
 * organization removal that still finishes takes by the product's own schedule, if every step fails
 * and is retried until its last attempt succeeds. Cloudflare Workflows waits
 * `delay * 2^(n-1)` after the n-th failed attempt for exponential backoff and `delay * n` for
 * linear (workflows-shared/lib/retries.ts in @alchemy.run/cloudflare-runtime, the engine
 * `alchemy dev` runs).
 *
 * - Start: the accepting request dispatches the Workflow for up to 10 s, then the recovery alarm
 *   tries again at most 60 s apart (`dispatchAcceptedRemoval` in organization-removal-workflow.ts,
 *   `retryDelay` in organization-removal-recovery.ts). One more alarm after the request: 70 s.
 * - `unregister-webhooks` and `cancel-billing` (`providerRetries` in organization-removal.ts:
 *   5 retries from 30 s, exponential): 30 + 60 + 120 + 240 + 480 = 930 s each, 1,860 s.
 * - `purge-owner-store`, `delete-auth-records`, `resweep-owner-store`, `release-icon` and
 *   `finish` (`storeRetries`: 5 retries from 5 s, linear): 5 + 10 + 15 + 20 + 25 = 75 s each, 375 s.
 * - Each of `unregister-webhooks`' 6 attempts waits for a webhook lease another worker holds,
 *   `defaultWebhookLifecycleLimits.leaseMs` (60 s): every lease held when the attempt starts has
 *   expired 60 s later. 360 s.
 *
 * 70 + 1,860 + 375 + 360 = 2,665 s, 44 min 25 s. It leaves out the time attempts themselves run:
 * the product bounds none (a statement waits for its reply without a deadline; Workflows ends an
 * attempt only after 10 minutes), so an attempt that runs for minutes is itself what the check
 * reports. In a run the check starts after the scenarios, so most removals are long done by then.
 * The deployed job's 120-minute limit holds this beside the deploy, the suite and the teardown.
 */
export const removalDeadlineMs = (70 + 2 * 930 + 5 * 75 + 6 * 60) * 1000;
/** One look takes at most 10 s and 2 s per status read; past this the request counts as dropped. */
export const settleRequestTimeout = "30 seconds";
const askAgainAfter = "2 seconds";
/**
 * Consecutive requests refused at connect (`ECONNREFUSED`) after which the check stops asking. The
 * fixture server listens on loopback and nothing restarts it, so a refused connection means its
 * process has exited and will not answer again; 5 in a row, about 10 s, only rules out a single
 * stray refusal. A server that answers slowly, drops a request or resets one is still listening:
 * none of those counts here, and they keep the full deadline.
 */
export const refusedInARow = 5;

const Finished = Schema.Struct({
  scenario: Schema.String,
  label: Schema.String,
  organization: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  readyAt: Schema.String,
  usersDeletedAt: Schema.String,
  deletionMs: Schema.Number,
});
const Unfinished = Schema.Struct({
  scenario: Schema.String,
  label: Schema.String,
  organization: Schema.NullOr(Schema.String),
  phase: Schema.Literals(["wait-for-organization", "wait-for-removal", "remove-users"]),
  since: Schema.String,
  acceptedAt: Schema.String,
  status: Schema.NullOr(Schema.Literals(["running", "done"])),
  instance: Schema.NullOr(Schema.String),
  checking: Schema.Boolean,
  cause: Schema.optional(Schema.String),
});
/** One `/settle` look. */
export const SettleLook = Schema.Struct({
  finished: Schema.Array(Finished),
  unfinished: Schema.Array(Unfinished),
  neverAccepted: Schema.Array(Schema.Struct({ scenario: Schema.String, label: Schema.String })),
  lookMs: Schema.Number,
  checksRunning: Schema.Number,
  deletions: Schema.Number,
  deletionMs: Schema.Number,
});
export type SettleLook = typeof SettleLook.Type;
/** What `report/removals.json` holds: the last answer and how the check went. */
export const RemovalSettlement = Schema.Struct({
  within: Schema.Number,
  startedAt: Schema.String,
  endedAt: Schema.String,
  durationMs: Schema.Number,
  /** Time from the check's start until the product finished its last removal. */
  waitingOnProductMs: Schema.Number,
  requests: Schema.Number,
  dropped: Schema.Number,
  /** The check stopped asking: the fixture refused `refusedInARow` connections in a row. */
  fixtureGone: Schema.Boolean,
  lastDrop: Schema.optional(Schema.String),
  answeredAt: Schema.NullOr(Schema.String),
  last: Schema.NullOr(SettleLook),
});
export type RemovalSettlement = typeof RemovalSettlement.Type;

export class RemovalsUnfinished extends Schema.TaggedError<RemovalsUnfinished>()(
  "RemovalsUnfinished",
  { message: Schema.String },
) {}

/** How long the product took to finish a removal, by its own record; null without one. */
export const removalDuration = (removal: typeof Finished.Type) =>
  removal.startedAt === null || removal.finishedAt === null
    ? null
    : Date.parse(removal.finishedAt) - Date.parse(removal.startedAt);

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * Wait for every removal the run's fixture server accepted, record them, and fail naming those
 * that have not finished. `ids` and `within` are for the scenario that proves this check.
 */
export const settleRemovals = (
  control: typeof FixtureControl.Type,
  files: { readonly report: string; readonly stalls: string },
  options: { readonly ids?: ReadonlyArray<string>; readonly within?: number } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const within = options.within ?? removalDeadlineMs;
    const started = yield* Clock.currentTimeMillis;
    let last: SettleLook | null = null;
    let answeredAt: number | null = null;
    let requests = 0;
    let dropped = 0;
    let lastDrop: string | undefined;
    let refused = 0;
    let gone = false;
    while (true) {
      requests += 1;
      const answer = yield* fixtureRequest(
        control,
        "/settle",
        options.ids === undefined ? {} : { ids: options.ids },
        settleRequestTimeout,
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(SettleLook)), Effect.exit);
      const now = yield* Clock.currentTimeMillis;
      if (Exit.isSuccess(answer)) {
        refused = 0;
        last = answer.value;
        answeredAt = now;
        if (last.unfinished.length === 0) break;
      } else {
        dropped += 1;
        const error = Cause.squash(answer.cause);
        refused =
          Schema.is(FixtureFailed)(error) && error.code === "ECONNREFUSED" ? refused + 1 : 0;
        if (refused >= refusedInARow) gone = true;
        const failure = Cause.squash(answer.cause);
        lastDrop = (failure instanceof Error ? failure.message : String(failure)).slice(0, 300);
      }
      if (gone || now - started >= within) break;
      yield* Effect.sleep(askAgainAfter);
    }
    const ended = yield* Clock.currentTimeMillis;
    const productDone = Math.max(
      started,
      ...(last?.finished ?? []).flatMap((removal) =>
        removal.finishedAt === null ? [] : [Date.parse(removal.finishedAt)],
      ),
    );
    const report: RemovalSettlement = {
      within,
      startedAt: new Date(started).toISOString(),
      endedAt: new Date(ended).toISOString(),
      durationMs: ended - started,
      waitingOnProductMs: Math.min(productDone, ended) - started,
      requests,
      dropped,
      fixtureGone: gone,
      ...(lastDrop === undefined ? {} : { lastDrop }),
      answeredAt: answeredAt === null ? null : new Date(answeredAt).toISOString(),
      last,
    };
    yield* fs.makeDirectory(path.dirname(files.report), { recursive: true });
    yield* fs.writeFileString(files.report, JSON.stringify(report, null, 2), { mode: 0o600 });
    const unfinished = last?.unfinished ?? [];
    for (const removal of unfinished)
      if (removal.organization !== null)
        yield* fs.writeFileString(
          files.stalls,
          `${JSON.stringify({
            scenario: removal.scenario,
            label: removal.label,
            organization: removal.organization,
            instance: removal.instance,
            status: removal.status,
            phase: removal.phase,
            since: removal.since,
            at: report.endedAt,
          })}\n`,
          { flag: "a", mode: 0o600 },
        );
    const durations = (last?.finished ?? []).flatMap((removal) => {
      const duration = removalDuration(removal);
      return duration === null ? [] : [{ removal, duration }];
    });
    const slowest = durations.reduce<(typeof durations)[number] | undefined>(
      (longest, entry) =>
        longest === undefined || entry.duration > longest.duration ? entry : longest,
      undefined,
    );
    yield* Console.log(
      `Organization removals: ${last?.finished.length ?? 0} finished, ${unfinished.length} not finished, ${last?.neverAccepted.length ?? 0} never accepted; check took ${seconds(report.durationMs)} (waiting on the product ${seconds(report.waitingOnProductMs)}, the fixture's checks and user deletions the rest; ${last?.deletions ?? 0} deletions took ${seconds(last?.deletionMs ?? 0)} in all, ${requests} requests, ${dropped} dropped)${
        slowest === undefined
          ? ""
          : `; slowest removal ${seconds(slowest.duration)} (${slowest.removal.label}, scenario ${slowest.removal.scenario})`
      }`,
    );
    const problems = [
      ...(gone
        ? [
            `The fixture server refused ${refusedInARow} connections in a row and was given up on after ${seconds(report.durationMs)}; what follows is from its last answer${answeredAt === null ? " (it never answered)" : ` at ${report.answeredAt}`}`,
          ]
        : []),
      ...(last === null
        ? [
            `The fixture server never answered the check (${requests} requests): ${lastDrop ?? "no error"}`,
          ]
        : []),
      ...unfinished.map(
        (removal) =>
          `Organization removal for "${removal.label}" (scenario ${removal.scenario}, organization ${removal.organization ?? "unknown"}) has not finished: ${removal.phase} since ${removal.since}, accepted ${removal.acceptedAt}, removal ${removal.status ?? "not recorded"}${removal.cause === undefined ? "" : `, last check failed with ${removal.cause}`}`,
      ),
      ...(last?.neverAccepted ?? []).map(
        (scenario) =>
          `Organization removal for "${scenario.label}" (scenario ${scenario.scenario}) was never accepted: its clean-up did not run or failed before the product accepted it`,
      ),
    ];
    for (const problem of problems) yield* Console.error(problem);
    if (problems.length > 0)
      return yield* new RemovalsUnfinished({
        message: `${problems.length} organization removal problem${problems.length === 1 ? "" : "s"} within ${seconds(within)}; see ${removalSettlementFile}. ${problems.join(" ")}`,
      });
    return report;
  });
