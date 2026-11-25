import { Schema } from "effect";

export const RuntimeCrash = Schema.Struct({
  runtime: Schema.String,
  cause: Schema.String,
  crashedAt: Schema.Number,
  replacedAt: Schema.optional(Schema.Number),
});
export type RuntimeCrash = typeof RuntimeCrash.Type;
export const RuntimeCrashes = Schema.Array(RuntimeCrash);

export const runtimeCrashesFile = "runtime-crashes.json";

const echoMs = 30_000;
export const crashMarginMs = 5_000;

const shortName = (name: string) =>
  name
    .toLowerCase()
    .replace(/^executor-next-hosted-/, "")
    .replace(/-[a-z0-9]{20,}$/, "");

export const runtimeCrashLine = (
  line: string,
):
  | { readonly kind: "fatal"; readonly runtime: string | undefined; readonly cause: string }
  | { readonly kind: "exited"; readonly runtime: string; readonly how: string }
  | undefined => {
  const fatal =
    /^(?:\[([^\]]+)\] )?\S+: fatal: V8 fatal error; location = ([^;]+); message = :? ?(.*)$/.exec(
      line,
    );
  if (fatal !== null)
    return {
      kind: "fatal",
      runtime: fatal[1] === undefined ? undefined : shortName(fatal[1]),
      cause: `${/out of memory/i.test(fatal[3] ?? "") ? "V8 heap out of memory" : `V8 fatal error: ${fatal[3]}`} (${fatal[2]!.trim()})`,
    };
  const exited = /The Workers runtime for "([^"]+)" exited unexpectedly \(([^)]*)\)/.exec(line);
  if (exited !== null) return { kind: "exited", runtime: shortName(exited[1]!), how: exited[2]! };
  return undefined;
};

export const trackRuntimeCrash = (
  crashes: ReadonlyArray<RuntimeCrash>,
  line: string,
  at: number,
): ReadonlyArray<RuntimeCrash> | undefined => {
  const seen = runtimeCrashLine(line);
  if (seen === undefined) return undefined;
  const recent = (crash: RuntimeCrash) =>
    at - (crash.replacedAt ?? crash.crashedAt) <= echoMs &&
    (seen.runtime === undefined || crash.runtime === seen.runtime);
  if (seen.kind === "fatal") {
    if (crashes.some(recent)) return undefined;
    return [...crashes, { runtime: seen.runtime ?? "unknown", cause: seen.cause, crashedAt: at }];
  }
  const open = crashes.findLastIndex(
    (crash) =>
      crash.replacedAt === undefined &&
      (crash.runtime === seen.runtime || crash.runtime === "unknown"),
  );
  if (open === -1)
    return [
      ...crashes,
      { runtime: seen.runtime, cause: `exited (${seen.how})`, crashedAt: at, replacedAt: at },
    ];
  return crashes.map((crash, index) =>
    index === open ? { ...crash, runtime: seen.runtime, replacedAt: at } : crash,
  );
};

const time = (ms: number) => new Date(ms).toISOString().slice(11, 23);

export const runtimeCrashNote = (crash: RuntimeCrash) =>
  `Local Cloud's ${crash.runtime} runtime crashed while this case ran: ${crash.cause} at ${time(crash.crashedAt)} UTC${
    crash.replacedAt === undefined
      ? ", not replaced before the run ended"
      : `, replaced at ${time(crash.replacedAt)} UTC`
  }. Requests to it failed in between.`;

export interface CrashCase {
  readonly status: string;
  readonly startedAt?: number | undefined;
  readonly duration: number;
}

export const runtimeCrashNotesFor = (
  entry: CrashCase,
  crashes: ReadonlyArray<RuntimeCrash>,
): ReadonlyArray<string> => {
  if (entry.status !== "failed" || entry.startedAt === undefined) return [];
  const started = entry.startedAt;
  const ended = started + entry.duration;
  return crashes
    .filter(
      (crash) =>
        started <= (crash.replacedAt ?? crash.crashedAt) + crashMarginMs &&
        ended >= crash.crashedAt - crashMarginMs,
    )
    .map(runtimeCrashNote);
};
