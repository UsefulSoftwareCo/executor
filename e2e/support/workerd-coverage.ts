/**
 * Coverage of the code a product process runs inside workerd, for `E2E_COVERAGE=1`; see
 * `e2e/coverage.ts`.
 *
 * workerd's isolates log their function events to files (`workerdCoverageFlags`, V8's
 * `--log-function-events`, passed through `ALCHEMY_WORKERD_V8_FLAGS`). Nothing connects to the
 * product: workerd's inspector is never opened. With it open, workerd registers each isolate by
 * name and refuses a second isolate under a name it has not yet forgotten, so an app Worker the
 * runtime unloaded and loads again fails ("inserted row already exists in table").
 *
 * A function ran when V8 compiled it lazily, which a call does, or logged its first execution; the
 * functions that enclose it ran too. Every other function V8 parsed counts as not run. Like V8's
 * best-effort coverage this counts functions, not blocks: a branch a function skipped counts as
 * run. Functions V8 compiled eagerly and ran without logging a first execution count as not run.
 *
 * V8 names each isolate's file after the isolate's address, and opens it truncated, so an isolate
 * at the address of an unloaded one would overwrite its log. The recorder renames each new file
 * within 100 milliseconds; V8 keeps writing to the renamed file. Only an isolate that started and
 * was replaced within that window loses its log.
 */
import { Effect, FileSystem, Path, Schedule, Semaphore } from "effect";

/** The file name V8 gives each isolate's log, from `--logfile=<directory>/workerd.log`. */
const live = /^isolate-0x[0-9a-f]+-\d+-workerd\.log$/;
const renamed = /^v8-\d+\.log$/;

/** V8 flags that make workerd's isolates log their function events to `directory`. */
export const workerdCoverageFlags = (directory: string) => {
  // The runtime splits `ALCHEMY_WORKERD_V8_FLAGS` on whitespace.
  if (/\s/.test(directory)) throw new Error(`Coverage directory has whitespace: ${directory}`);
  return `--log-function-events --logfile=${directory}/workerd.log`;
};

type Range = { start: number; end: number; ran: boolean };

/**
 * One isolate's log as V8 coverage of each product script: its parsed functions, counted 1 when
 * they ran and 0 when not. Only modules `e2e/coverage.ts` can map: the host bundle's, and the app
 * framework's. An app's own bundle, workerd's built-in modules and Alchemy's Workers are not
 * product code.
 */
const readLog = (text: string) => {
  const urls = new Map<string, string>();
  const lengths = new Map<string, number>();
  const functions = new Map<string, Map<string, Range>>();
  for (const line of text.split("\n")) {
    if (line.startsWith("script-details,")) {
      const [, id, url] = line.split(",", 3);
      if (id !== undefined && url !== undefined && url !== "") urls.set(id, url);
      continue;
    }
    if (!line.startsWith("function,")) continue;
    const [, event, id, startText, endText] = line.split(",", 5);
    if (event === undefined || id === undefined) continue;
    const start = Number(startText);
    const end = Number(endText);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) continue;
    if (event === "parse-script" && start === 0)
      lengths.set(id, Math.max(lengths.get(id) ?? 0, end));
    let script = functions.get(id);
    if (script === undefined) functions.set(id, (script = new Map()));
    const key = `${start}:${end}`;
    let range = script.get(key);
    if (range === undefined) script.set(key, (range = { start, end, ran: false }));
    if (event === "parse-function" || event.startsWith("first-execution")) range.ran = true;
  }
  return [...functions].flatMap(([id, script]) => {
    const url = urls.get(id);
    const length = lengths.get(id);
    if (url === undefined || length === undefined) return [];
    if (!url.startsWith("file:///bundle/") && !url.startsWith("node_modules/apps/")) return [];
    // A module that was parsed was evaluated, so its top level ran.
    const top = script.get(`0:${length}`) ?? { start: 0, end: length, ran: true };
    top.ran = true;
    script.set(`0:${length}`, top);
    const ranges = [...script.values()].sort((a, b) => a.start - b.start || b.end - a.end);
    // A function can run only after the function that encloses it ran.
    const open: Range[] = [];
    for (const range of ranges) {
      while (open.length > 0 && open[open.length - 1]!.end < range.end) open.pop();
      if (range.ran)
        for (let index = open.length - 1; index >= 0 && !open[index]!.ran; index--)
          open[index]!.ran = true;
      open.push(range);
    }
    return [{ url, length, ranges }];
  });
};

/**
 * Keep the function logs of the workerd that logs to `directory` (see `workerdCoverageFlags`)
 * while the scope is open. `save` reads the logs, once workerd has stopped, and writes their
 * coverage as `workerd-<n>.json`; the host bundle it names maps the host Worker's coverage to its
 * sources. The scope's end saves too.
 */
export const recordWorkerdCoverage = (options: {
  readonly directory: string;
  readonly bundle: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lock = yield* Semaphore.make(1);
    let logs = 0;
    let saved = 0;
    const keep = lock.withPermits(1)(
      Effect.gen(function* () {
        for (const name of yield* fs.readDirectory(options.directory))
          if (live.test(name))
            yield* fs.rename(
              path.join(options.directory, name),
              path.join(options.directory, `v8-${logs++}.log`),
            );
      }).pipe(Effect.ignore),
    );
    yield* keep.pipe(Effect.repeat(Schedule.spaced("100 millis")), Effect.forkScoped);
    /** Each script's functions, by script and position, run if any isolate ran them. */
    const save = Effect.gen(function* () {
      yield* keep;
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const scripts = new Map<string, { url: string; functions: Map<string, Range> }>();
          for (const name of yield* fs.readDirectory(options.directory)) {
            if (!renamed.test(name)) continue;
            const file = path.join(options.directory, name);
            // The same module text in several isolates, such as the app framework in each app
            // Worker, or in an isolate that replaced an unloaded one, is one script.
            for (const { url, length, ranges } of readLog(yield* fs.readFileString(file))) {
              const key = `${url}#${length}`;
              let entry = scripts.get(key);
              if (entry === undefined) scripts.set(key, (entry = { url, functions: new Map() }));
              for (const range of ranges) {
                const position = `${range.start}:${range.end}`;
                const known = entry.functions.get(position);
                if (known === undefined) entry.functions.set(position, { ...range });
                else known.ran ||= range.ran;
              }
            }
            yield* fs.remove(file);
          }
          if (scripts.size === 0) return;
          const report = [...scripts.values()].map(({ url, functions }) => ({
            url,
            functions: [...functions.values()].map(({ start, end, ran }) => ({
              ranges: [{ startOffset: start, endOffset: end, count: ran ? 1 : 0 }],
            })),
          }));
          yield* fs.writeFileString(
            path.join(options.directory, `workerd-${saved++}.json`),
            JSON.stringify({ bundle: options.bundle, scripts: report }),
          );
        }),
      );
    }).pipe(Effect.ignore);
    yield* Effect.addFinalizer(() => save);
    return { save };
  });
