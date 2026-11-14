/**
 * Crashes of managed local Cloud's Workers runtimes, read from `alchemy dev`'s output, and the
 * line each failed scenario near one carries. On local Cloud one workerd process serves every app
 * supervisor of the run (`AppData`), so when it runs out of memory, the scenarios in flight fail
 * for a reason none of them caused: an install that "could not be built", provisioning that never
 * finished. The note names the crash instead.
 */
import { Schema } from "effect";

/** One runtime's crash: what it died of, when it did, and when `alchemy dev` replaced it. */
export const RuntimeCrash = Schema.Struct({
  /** The runtime's short name, such as `appdata` for `executor-next-hosted-appdata-<hash>`. */
  runtime: Schema.String,
  cause: Schema.String,
  crashedAt: Schema.Number,
  replacedAt: Schema.optional(Schema.Number),
});
export type RuntimeCrash = typeof RuntimeCrash.Type;
export const RuntimeCrashes = Schema.Array(RuntimeCrash);

/** The run's crashes, written beside `cloud.log` whenever one is seen or replaced. */
export const runtimeCrashesFile = "runtime-crashes.json";

/**
 * How long after a crash its runtime's lines still belong to it. `alchemy dev` prints the dead
 * process's last output again, unprefixed, once it has started the replacement.
 */
const echoMs = 30_000;
/** How far either side of a crash window a failed scenario is counted as caught in it. */
export const crashMarginMs = 5_000;

const shortName = (name: string) =>
  name
    .toLowerCase()
    .replace(/^executor-next-hosted-/, "")
    .replace(/-[a-z0-9]{20,}$/, "");

/**
 * What a line of `alchemy dev`'s output says about a runtime crash: V8 giving up, such as
 * `[AppData] workerd/jsg/setup.c++:38: fatal: V8 fatal error; location = Scavenger: semi-space
 * copy; message = : allocation failed: JavaScript heap out of memory`, or the runtime's exit,
 * `[17:54:50.664] WARN (#1044): The Workers runtime for "executor-next-hosted-appdata-<hash>"
 * exited unexpectedly (exit code null, signal SIGABRT); starting a replacement on the same ports.`
 */
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

/**
 * The crashes `line`, read at `at`, adds to or changes in `crashes`. A fatal error opens a crash,
 * the runtime's exit closes it as replaced, and an exit with no fatal error before it is a crash
 * of its own.
 */
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
    // The same crash told twice, or again after the replacement started.
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

/** The line a failed scenario carries for a crash it ran into. */
export const runtimeCrashNote = (crash: RuntimeCrash) =>
  `Local Cloud's ${crash.runtime} runtime crashed while this case ran: ${crash.cause} at ${time(crash.crashedAt)} UTC${
    crash.replacedAt === undefined
      ? ", not replaced before the run ended"
      : `, replaced at ${time(crash.replacedAt)} UTC`
  }. Requests to it failed in between.`;

/** A case as the crash notes read it: whether it failed, when it started and how long it ran. */
export interface CrashCase {
  readonly status: string;
  readonly startedAt?: number | undefined;
  readonly duration: number;
}

/**
 * The crash notes for a case: one for each crash whose window, widened by `crashMarginMs` either
 * side, overlaps the case's run, if the case failed. A passed case, or one with no start time,
 * gets none.
 */
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
