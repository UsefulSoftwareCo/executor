/** Read the summary line each finished data step pass writes to the product's log. */
import { Effect, FileSystem, Option, Schedule, Schema } from "effect";

const prefix = "Data step pass finished: ";

export const DataStepSummary = Schema.Struct({
  step: Schema.String,
  mode: Schema.Literals(["report", "apply"]),
  run: Schema.String,
  pass: Schema.Number,
  status: Schema.Literals(["complete", "retrying"]),
  retryAt: Schema.optionalKey(Schema.String),
  outcomes: Schema.Record(Schema.String, Schema.Number),
  owners: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Number)),
});
export type DataStepSummary = typeof DataStepSummary.Type;

const LogRecord = Schema.fromJsonString(
  Schema.Struct({
    message: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
    timestamp: Schema.optional(Schema.String),
  }),
);
const Summary = Schema.fromJsonString(DataStepSummary);

/** A finished pass, and when the host logged it when its log records carry a time. */
export interface DataStepPass {
  readonly summary: DataStepSummary;
  readonly loggedAt: number | undefined;
}

/** Hosts write JSON log records; the message holds the prefix and the summary's JSON. */
const passOf = (line: string): Option.Option<DataStepPass> => {
  const record = Schema.decodeUnknownOption(LogRecord)(line.slice(line.indexOf("{")));
  const messages = Option.match(record, {
    onNone: () => [line],
    onSome: ({ message }) => (typeof message === "string" ? [message] : message),
  });
  const timestamp = Option.getOrUndefined(record)?.timestamp;
  for (const message of messages) {
    if (typeof message !== "string") continue;
    const at = message.indexOf(prefix);
    if (at < 0) continue;
    const summary = Schema.decodeUnknownOption(Summary)(message.slice(at + prefix.length));
    if (Option.isSome(summary))
      return Option.some({
        summary: summary.value,
        loggedAt: timestamp === undefined ? undefined : Date.parse(timestamp),
      });
  }
  return Option.none();
};

/** Every message in the host's log: each JSON record's text parts, or a plain line itself. */
export const logMessages = (log: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = (yield* fs.exists(log)) ? yield* fs.readFileString(log) : "";
    return text.split("\n").flatMap((line) =>
      Option.match(Schema.decodeUnknownOption(LogRecord)(line.slice(line.indexOf("{"))), {
        onNone: () => [line],
        onSome: ({ message }) =>
          typeof message === "string"
            ? [message]
            : message.filter((part): part is string => typeof part === "string"),
      }),
    );
  });

/** Every finished pass in the log for one step, oldest first. */
export const dataStepPasses = (log: string, step: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = (yield* fs.exists(log)) ? yield* fs.readFileString(log) : "";
    return text
      .split("\n")
      .flatMap((line) => Option.toArray(passOf(line)))
      .filter((pass) => pass.summary.step === step);
  });

/** Every summary in the log for one step, oldest first. */
export const dataStepSummaries = (log: string, step: string) =>
  dataStepPasses(log, step).pipe(Effect.map((passes) => passes.map((pass) => pass.summary)));

class SummaryPending extends Schema.TaggedError<SummaryPending>()("SummaryPending", {
  step: Schema.String,
}) {}

/** Wait for the log to hold more than `seen` summaries for the step, and return the newest. */
export const nextDataStepSummary = (log: string, step: string, seen: number) =>
  dataStepSummaries(log, step).pipe(
    Effect.flatMap((summaries) => {
      const newest = summaries.at(-1);
      return summaries.length > seen && newest !== undefined
        ? Effect.succeed(newest)
        : Effect.fail(new SummaryPending({ step }));
    }),
    Effect.retry({
      while: (error) => Schema.is(SummaryPending)(error),
      schedule: Schedule.spaced("250 millis"),
      times: 120,
    }),
  );
