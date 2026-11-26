import { Effect, FileSystem, Path, Schema } from "effect";

export const shortPath = (path: string) => path.replace(/[A-Za-z0-9_-]{16,}/gu, ":id");

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

export const answeredAfterRepeats = "sent again: answered";

export const repeatTotals = (records: ReadonlyArray<LostRequestRecord>) => {
  const answered = records.filter((record) => record.outcome === answeredAfterRepeats);
  return {
    requests: answered.length,
    repeats: answered.reduce((sum, record) => sum + (record.repeats?.length ?? 0), 0),
    waitedMs: answered.reduce((sum, record) => sum + record.elapsedMs, 0),
  };
};

const seconds = (milliseconds: number) => `${(milliseconds / 1000).toFixed(1)} s`;

const repeatText = (record: LostRequestRecord) =>
  record.repeats === undefined
    ? record.stopped === undefined
      ? ""
      : `, not sent again: ${record.stopped}`
    : `, ${record.outcome === answeredAfterRepeats ? record.repeats.length + 1 : record.repeats.length} attempts over ${seconds(record.elapsedMs)}${record.stopped === undefined ? "" : `, not sent again: ${record.stopped}`}`;

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

export const lostRequestsUncounted =
  "Stage requests lost in transport: NOT COUNTED. The records could not be read, so this job's count is unknown, not zero.";
