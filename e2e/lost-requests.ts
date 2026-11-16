/**
 * Stage requests lost before any response (`support/lost-connections.ts`), saved per scenario in
 * the run's `report/lost-requests/` and counted for a job's summary, zero included: how many were
 * sent again and answered, sent again and failed, or not sent again and why, with the time of
 * each. A burst then shows as a count with times, whether it reddened a scenario or not.
 */
import { Effect, FileSystem, Path, Schema } from "effect";

/** Where a run keeps its records, under the run's directory. */
export const lostRequestDirectory = "report/lost-requests";

export const LostRequestRecord = Schema.Struct({
  at: Schema.String,
  scenario: Schema.optional(Schema.String),
  method: Schema.String,
  path: Schema.String,
  code: Schema.optional(Schema.String),
  elapsedMs: Schema.Number,
  sent: Schema.Struct({
    connection: Schema.optional(Schema.Literals(["new", "reused"])),
    idleMs: Schema.optional(Schema.Number),
    written: Schema.Literals(["nothing", "headers", "whole request"]),
    responseStarted: Schema.Boolean,
  }),
  outcome: Schema.String,
  againCode: Schema.optional(Schema.String),
});
export type LostRequestRecord = typeof LostRequestRecord.Type;

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(LostRequestRecord)));

/** Save one scenario's lost requests in a run directory. A scenario with none writes nothing. */
export const saveLostRequests = (
  run: string,
  scenarioId: string,
  records: ReadonlyArray<LostRequestRecord>,
) =>
  Effect.gen(function* () {
    if (records.length === 0) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(run, lostRequestDirectory);
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(
      path.join(directory, `${scenarioId}.json`),
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

/** One summary paragraph: the total, each outcome's count, and when each happened. */
export const lostRequestLines = (records: ReadonlyArray<LostRequestRecord>) => {
  if (records.length === 0) return "Stage requests lost before any response: 0.";
  const outcomes = new Map<string, number>();
  for (const record of records)
    outcomes.set(record.outcome, (outcomes.get(record.outcome) ?? 0) + 1);
  return [
    `Stage requests lost before any response: ${records.length} (${[...outcomes]
      .map(([outcome, count]) => `${count} ${outcome}`)
      .join(", ")}).`,
    ...records.map(
      (record) =>
        `- ${record.at.slice(11, 19)} ${record.method} ${record.path.replace(/[A-Za-z0-9_-]{16,}/gu, ":id")} (${record.sent.connection ?? "unwritten"}${record.sent.idleMs === undefined ? "" : `, idle ${(record.sent.idleMs / 1000).toFixed(1)} s`}; ${record.outcome})`,
    ),
  ].join("\n");
};
