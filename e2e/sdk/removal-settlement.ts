import { Cause, Clock, Console, Effect, Exit, FileSystem, Path, Schema } from "effect";
import { FixtureFailed, fixtureRequest, type FixtureControl } from "./fixtures.ts";

export const removalSettlementFile = "removals.json";

export const removalDeadlineMs = (70 + 2 * 930 + 5 * 75 + 6 * 60) * 1000;
export const settleRequestTimeout = "30 seconds";
const askAgainAfter = "2 seconds";
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
export const RemovalSettlement = Schema.Struct({
  within: Schema.Number,
  startedAt: Schema.String,
  endedAt: Schema.String,
  durationMs: Schema.Number,
  waitingOnProductMs: Schema.Number,
  requests: Schema.Number,
  dropped: Schema.Number,
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

export const removalDuration = (removal: typeof Finished.Type) =>
  removal.startedAt === null || removal.finishedAt === null
    ? null
    : Date.parse(removal.finishedAt) - Date.parse(removal.startedAt);

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

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
