/**
 * Stage requests lost in transport (`support/lost-connections.ts`): before any response, or after
 * one began and before it was whole. Saved per scenario in
 * the run's `report/lost-requests/` and counted for a job's summary, zero included: where each was
 * lost (a new connection, a reused one, after a response began), with its time. Only a request of
 * which nothing was written to any connection is sent again; one answered so is kept as "sent
 * again: answered" with its repeats, and counted apart from the lost.
 */
import { Effect, FileSystem, Path, Schema } from "effect";

/** A path with its ids shortened to `:id`: a run of 16 or more id characters. */
export const shortPath = (path: string) => path.replace(/[A-Za-z0-9_-]{16,}/gu, ":id");

/** Where a run keeps its records, under the run's directory. */
export const lostRequestDirectory = "report/lost-requests";

export const LostRequestRecord = Schema.Struct({
  at: Schema.String,
  scenario: Schema.optional(Schema.String),
  file: Schema.optional(Schema.String),
  method: Schema.String,
  path: Schema.String,
  code: Schema.optional(Schema.String),
  elapsedMs: Schema.Number,
  sent: Schema.Struct({
    connection: Schema.optional(Schema.Literals(["new", "reused"])),
    earlierRequests: Schema.optional(Schema.Number),
    connectionAgeMs: Schema.optional(Schema.Number),
    idleMs: Schema.optional(Schema.Number),
    written: Schema.Literals(["nothing", "headers", "whole request"]),
    responseStarted: Schema.Boolean,
  }),
  outcome: Schema.String,
  /** The failed attempts of a request sent again because nothing of it was written. */
  repeats: Schema.optional(
    Schema.Array(
      Schema.Struct({
        at: Schema.String,
        code: Schema.optional(Schema.String),
        elapsedMs: Schema.Number,
      }),
    ),
  ),
  stopped: Schema.optional(Schema.String),
});
export type LostRequestRecord = typeof LostRequestRecord.Type;

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(LostRequestRecord)));

/**
 * Save lost requests in a run directory, under a name of the saver's: a scenario's id, a test
 * file's records made outside any scenario, or the suite's preparation. None writes nothing.
 */
export const saveLostRequests = (
  run: string,
  name: string,
  records: ReadonlyArray<LostRequestRecord>,
) =>
  Effect.gen(function* () {
    if (records.length === 0) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(run, lostRequestDirectory);
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(
      path.join(directory, `${name}.json`),
      JSON.stringify(records, null, 2),
      { mode: 0o600 },
    );
  });

/** Every record under the directories, at any depth, oldest first. A file that does not decode fails. */
export const readLostRequests = (directories: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files: Array<string> = [];
    for (const directory of directories)
      if (yield* fs.exists(directory))
        for (const file of yield* fs.readDirectory(directory, { recursive: true }))
          if (
            path.basename(path.dirname(file)) === path.basename(lostRequestDirectory) &&
            file.endsWith(".json")
          )
            files.push(path.join(directory, file));
    const records = yield* Effect.forEach(files, (file) =>
      fs.readFileString(file).pipe(Effect.flatMap(decode)),
    );
    return records.flat().toSorted((a, b) => a.at.localeCompare(b.at));
  });

/** The outcome of a request answered after being sent again. */
export const answeredAfterRepeats = "sent again: answered";

/** Requests answered only after being sent again: how many, their repeats, and their waits in all. */
export const repeatTotals = (records: ReadonlyArray<LostRequestRecord>) => {
  const answered = records.filter((record) => record.outcome === answeredAfterRepeats);
  return {
    requests: answered.length,
    // Each request's first attempt is not a repeat.
    repeats: answered.reduce((sum, record) => sum + (record.repeats?.length ?? 0), 0),
    waitedMs: answered.reduce((sum, record) => sum + record.elapsedMs, 0),
  };
};

const seconds = (milliseconds: number) => `${(milliseconds / 1000).toFixed(1)} s`;

/** A record's own repeats: `3 attempts over 3.2 s, not sent again: 5 repeats used`. */
const repeatText = (record: LostRequestRecord) =>
  record.repeats === undefined
    ? record.stopped === undefined
      ? ""
      : `, not sent again: ${record.stopped}`
    : `, ${record.outcome === answeredAfterRepeats ? record.repeats.length + 1 : record.repeats.length} attempts over ${seconds(record.elapsedMs)}${record.stopped === undefined ? "" : `, not sent again: ${record.stopped}`}`;

/**
 * One summary paragraph: the lost requests, each outcome's count, those outside any scenario, the
 * requests answered only after being sent again, and when each happened.
 */
export const lostRequestLines = (records: ReadonlyArray<LostRequestRecord>) => {
  const lost = records.filter((record) => record.outcome !== answeredAfterRepeats);
  const totals = repeatTotals(records);
  const repeated =
    totals.requests === 0
      ? []
      : [
          `Stage requests sent again because nothing of them was written to a connection, then answered: ${totals.requests}, after ${totals.repeats} ${totals.repeats === 1 ? "repeat" : "repeats"} and ${seconds(totals.waitedMs)} of waiting in all.`,
        ];
  if (records.length === 0) return "Stage requests lost in transport: 0.";
  const outcomes = new Map<string, number>();
  for (const record of lost) outcomes.set(record.outcome, (outcomes.get(record.outcome) ?? 0) + 1);
  const outside = lost.filter((record) => record.scenario === undefined).length;
  return [
    lost.length === 0
      ? "Stage requests lost in transport: 0."
      : `Stage requests lost in transport: ${lost.length} (${[...outcomes]
          .map(([outcome, count]) => `${count} ${outcome}`)
          .join(
            ", ",
          )})${outside === 0 ? "" : `; ${outside} outside any scenario (preparation, set-up or teardown)`}.`,
    ...repeated,
    ...records.map(
      (record) =>
        `- ${record.at.slice(11, 19)} ${record.method} ${shortPath(record.path)} (${record.sent.connection ?? "unwritten"}${record.sent.earlierRequests === undefined || record.sent.earlierRequests === 0 ? "" : `, ${record.sent.earlierRequests} earlier requests`}${record.sent.idleMs === undefined ? "" : `, idle ${(record.sent.idleMs / 1000).toFixed(1)} s`}; ${record.outcome}${repeatText(record)})`,
    ),
  ].join("\n");
};

/** What a job summary says when the records could not be read: never a count, never zero. */
export const lostRequestsUncounted =
  "Stage requests lost in transport: NOT COUNTED. The records could not be read, so this job's count is unknown, not zero.";
