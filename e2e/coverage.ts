/**
 * Product line coverage of the E2E suite, per scenario.
 *
 * `E2E_COVERAGE=1` makes the runner profile each self-host and local product process (see
 * `support/managed-server.ts`): Bun writes lcov, Node writes V8 coverage. The product's workerd
 * logs which functions its isolates ran (see `support/workerd-coverage.ts`); the host bundle's and
 * the app framework's source maps map them to their sources. Each scenario
 * starts its own product, so each report belongs to one scenario. Chromium records every scenario's
 * page scripts, on Cloud too (see `support/browser.ts`), which the dashboards' source maps map to
 * their sources. Cloud's Worker serves all scenarios at once and is not profiled.
 *
 * - `collect <out> <directory...>` reduces the raw reports under each run directory to one compact
 *   file: the lines each scenario covered, and each target's executable lines.
 * - `report <file...>` prints coverage by target and package, and each scenario's unique lines: a
 *   scenario no other covers a line of adds no line coverage.
 * - `cover <out> <file...>` writes a small set of scenarios that covers every line, and the rest.
 * - `check <baseline> <file...>` fails when a target covers fewer lines than the baseline records,
 *   beyond the run-to-run noise in `tolerance`.
 * - `baseline <baseline> <file...>` writes the baseline from collected runs.
 *
 * A target's covered lines differ a little between runs of the same tree: timing decides some
 * paths, such as retries and cache races. Two full runs of one tree differed by under 0.2%. The
 * baseline therefore records totals, not lines, and allows 0.4%.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { scenarios } from "./test-plan.ts";

class CoverageFailed extends Schema.TaggedError<CoverageFailed>()("CoverageFailed", {
  message: Schema.String,
}) {}

/** Line numbers as sorted ranges, such as `1-4,9,12-30`. */
const LineRanges = Schema.String;
const Collected = Schema.Struct({
  version: Schema.Literal(1),
  targets: Schema.Record(
    Schema.String,
    Schema.Struct({
      /** Lines any profiled process could have run, by repository path. */
      executable: Schema.Record(Schema.String, LineRanges),
      scenarios: Schema.Array(
        Schema.Struct({
          title: Schema.String,
          file: Schema.optional(Schema.String),
          covered: Schema.Record(Schema.String, LineRanges),
        }),
      ),
    }),
  ),
});
type Collected = typeof Collected.Type;
const Baseline = Schema.Struct({
  /** Fraction of a target's covered lines a run may lose to timing before the check fails. */
  tolerance: Schema.Number,
  targets: Schema.Record(Schema.String, Schema.Struct({ covered: Schema.Number })),
});

const encodeLines = (lines: Iterable<number>) => {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length;) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end++;
    parts.push(index === end ? `${sorted[index]}` : `${sorted[index]}-${sorted[end]}`);
    index = end + 1;
  }
  return parts.join(",");
};
const decodeLines = (ranges: string) =>
  ranges === ""
    ? []
    : ranges.split(",").flatMap((part) => {
        const [start, end = start] = part.split("-").map(Number);
        return Array.from({ length: end! - start! + 1 }, (_, offset) => start! + offset);
      });

/** Product source files; the harness's own preloads and launchers are not product. */
const isProduct = (file: string) =>
  !file.startsWith("e2e/") &&
  !file.includes("node_modules/") &&
  // Built bundles, such as the dashboard a server renders, duplicate their sources line for line.
  !file.includes("/dist/") &&
  !file.startsWith("apps/hosted/self-host/scripts/") &&
  /\.[cm]?[jt]sx?$/.test(file);

type FileLines = Map<string, { executable: Set<number>; covered: Set<number> }>;
const lines = (into: FileLines, file: string) => {
  let entry = into.get(file);
  if (entry === undefined) into.set(file, (entry = { executable: new Set(), covered: new Set() }));
  return entry;
};

/** Bun's lcov: `SF:` opens a file, `DA:<line>,<hits>` reports one executable line. */
const readLcov = (text: string, into: FileLines) => {
  let file: string | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) file = isProduct(line.slice(3)) ? line.slice(3) : undefined;
    else if (file !== undefined && line.startsWith("DA:")) {
      const [number, hits] = line.slice(3).split(",").map(Number);
      const entry = lines(into, file);
      entry.executable.add(number!);
      if (hits! > 0) entry.covered.add(number!);
    }
  }
};

/** V8's function coverage: each function's nested ranges with their run counts. */
const V8Functions = Schema.Array(
  Schema.Struct({
    ranges: Schema.Array(
      Schema.Struct({ startOffset: Schema.Number, endOffset: Schema.Number, count: Schema.Number }),
    ),
  }),
);
const V8Coverage = Schema.Struct({
  result: Schema.Array(Schema.Struct({ url: Schema.String, functions: V8Functions })),
});

/** Each offset's run count, or -1 outside every function. */
const paint = (functions: typeof V8Functions.Type, length: number) => {
  const counts = new Int32Array(length).fill(-1);
  // V8 nests ranges, so painting outer ranges before inner ones leaves each offset's innermost count.
  const ranges = functions
    .flatMap((fn) => fn.ranges)
    .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const range of ranges)
    counts.fill(range.count, range.startOffset, Math.min(range.endOffset, length));
  return counts;
};

/**
 * Node's V8 coverage gives each function's ranges and their counts, nested and in source offsets.
 * Node strips TypeScript types to whitespace, so offsets index the source file itself. A line runs
 * when its first character runs; blank and comment-only lines are not executable.
 */
const readV8 = (
  coverage: typeof V8Coverage.Type,
  root: string,
  source: (file: string) => string | undefined,
  into: FileLines,
) => {
  for (const script of coverage.result) {
    if (!script.url.startsWith(`file://${root}/`)) continue;
    const file = decodeURIComponent(script.url.slice(`file://${root}/`.length));
    if (!isProduct(file)) continue;
    const text = source(file);
    if (text === undefined) continue;
    const counts = paint(script.functions, text.length);
    const entry = lines(into, file);
    let offset = 0;
    text.split("\n").forEach((line, index) => {
      const start = line.search(/\S/);
      const trimmed = line.trimStart();
      if (
        start >= 0 &&
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("/*") &&
        !trimmed.startsWith("*") &&
        counts[offset + start]! >= 0
      ) {
        entry.executable.add(index + 1);
        if (counts[offset + start]! > 0) entry.covered.add(index + 1);
      }
      offset += line.length + 1;
    });
  }
};

/** Chromium's coverage of a page's scripts, as `support/browser.ts` saves it. */
const BrowserCoverage = Schema.Array(
  Schema.Struct({
    url: Schema.String,
    functions: V8Functions,
  }),
);
const SourceMap = Schema.Struct({
  sourceRoot: Schema.optional(Schema.String),
  sources: Schema.Array(Schema.NullOr(Schema.String)),
  mappings: Schema.String,
});
type Bundle = {
  readonly text: string;
  readonly map: typeof SourceMap.Type;
  readonly directory: string;
};

const base64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** A source map's segments: generated line and column, source index, source line. */
const segments = function* (mappings: string) {
  let source = 0,
    sourceLine = 0;
  const lines = mappings.split(";");
  for (let line = 0; line < lines.length; line++) {
    let column = 0;
    for (const segment of lines[line]!.split(",")) {
      if (segment === "") continue;
      const fields: number[] = [];
      let value = 0,
        shift = 0;
      for (const character of segment) {
        const digit = base64.indexOf(character);
        value += (digit & 31) << shift;
        if (digit & 32) shift += 5;
        else {
          fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = shift = 0;
        }
      }
      column += fields[0]!;
      if (fields.length < 4) continue;
      source += fields[1]!;
      sourceLine += fields[2]!;
      yield { line, column, source, sourceLine };
    }
  }
};

/**
 * The browser runs the dashboards' built bundles. Each bundle's source map names the source line
 * every generated position came from; a source line runs when a position mapped to it runs.
 */
const readBrowser = (
  coverage: typeof BrowserCoverage.Type,
  root: string,
  bundleOf: (url: string) => Bundle | undefined,
  relative: (from: string, to: string) => string,
  into: FileLines,
) => {
  for (const script of coverage) {
    const bundle = bundleOf(script.url);
    if (bundle === undefined) continue;
    const counts = paint(script.functions, bundle.text.length);
    const starts = [0];
    for (let index = 0; index < bundle.text.length; index++)
      if (bundle.text.charCodeAt(index) === 10) starts.push(index + 1);
    const files = bundle.map.sources.map((source) =>
      source === null
        ? undefined
        : relative(root, `${bundle.directory}/${bundle.map.sourceRoot ?? ""}${source}`),
    );
    for (const { line, column, source, sourceLine } of segments(bundle.map.mappings)) {
      const file = files[source];
      const count = counts[(starts[line] ?? Infinity) + column];
      if (file === undefined || count === undefined || count < 0 || !isProduct(file)) continue;
      const entry = lines(into, file);
      entry.executable.add(sourceLine + 1);
      if (count > 0) entry.covered.add(sourceLine + 1);
    }
  }
};

/**
 * workerd's coverage, as `support/workerd-coverage.ts` saves it from its isolates' function logs:
 * each script's functions, counted 1 when they ran and 0 when not, so it counts functions rather
 * than blocks. `bundle` is the host bundle the product loaded.
 */
const WorkerdCoverage = Schema.Struct({ bundle: Schema.String, scripts: BrowserCoverage });
/** Modules by name with their source maps, as `writeWorkerdHostBundle` and `apps:build` write them. */
const BundleModules = Schema.Array(Schema.Struct({ name: Schema.String, content: Schema.Unknown }));
const FrameworkModules = Schema.Struct({ server: Schema.Record(Schema.String, Schema.String) });
const SourceMaps = Schema.Record(Schema.String, SourceMap);
/** How long the script a coverage report describes is: its outermost function spans all of it. */
const scriptLength = (functions: typeof V8Functions.Type) =>
  Math.max(
    0,
    ...functions.flatMap(({ ranges }) =>
      ranges[0]?.startOffset === 0 ? [ranges[0].endOffset] : [],
    ),
  );

const collect = (out: string, directories: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(".");
    const sources = new Map<string, string | undefined>();
    const source = (file: string) => sources.get(file);
    const fileOf = new Map(Object.values(scenarios).map(({ title, file }) => [title, file]));
    const targets = new Map<
      string,
      { executable: Map<string, Set<number>>; scenarios: Map<string, FileLines> }
    >();
    // The dashboards' built bundles, by file name, which their content hash makes unique.
    const bundleFiles = new Map<string, string>();
    const findBundles = (directory: string, built: boolean): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        for (const name of yield* fs.readDirectory(directory)) {
          if (name === "node_modules") continue;
          const child = path.join(directory, name);
          if ((yield* fs.stat(child)).type === "Directory")
            yield* findBundles(
              child,
              built || (name === "dist" && path.basename(directory) === "web"),
            );
          else if (built && name.endsWith(".js") && (yield* fs.exists(`${child}.map`)))
            bundleFiles.set(name, child);
        }
      });
    yield* findBundles(path.join(root, "apps"), false);
    const bundles = new Map<string, Bundle | undefined>();
    const bundleOf = (url: string) => bundles.get(path.basename(new URL(url).pathname));
    // Inside workerd, the host bundle's modules are `file:///bundle/<name>`, and app Workers link
    // the app framework's modules as `node_modules/apps/<name>`, as the staged package's
    // `runtime.json` holds them.
    const workerdBundles = new Map<string, Bundle | undefined>();
    const loadModules = (
      key: string,
      modules: Effect.Effect<ReadonlyMap<string, string>, unknown>,
      mapsFile: string,
    ) =>
      Effect.gen(function* () {
        if (workerdBundles.has(`${key}\0`)) return;
        workerdBundles.set(`${key}\0`, undefined);
        const texts = yield* modules;
        const maps = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SourceMaps))(
          yield* fs.readFileString(mapsFile),
        );
        for (const [name, map] of Object.entries(maps)) {
          const text = texts.get(name);
          if (text !== undefined)
            workerdBundles.set(`${key}\0${name}`, { text, map, directory: path.dirname(mapsFile) });
        }
      }).pipe(Effect.ignore);
    const framework = path.join(root, "packages/apps/dist/runtime.json");
    const workerdBundleOf = (bundle: string) => (url: string) =>
      url.startsWith("file:///bundle/")
        ? workerdBundles.get(`${bundle}\0${url.slice("file:///bundle/".length)}`)
        : workerdBundles.get(`${framework}\0${url}`);
    const scenarioDirectories: string[] = [];
    const walk = (directory: string): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        for (const name of yield* fs.readDirectory(directory)) {
          const child = path.join(directory, name);
          if ((yield* fs.stat(child)).type !== "Directory") continue;
          if (
            path.basename(directory) === "coverage" &&
            (yield* fs.exists(path.join(child, "scenario.json")))
          )
            scenarioDirectories.push(child);
          else yield* walk(child);
        }
      });
    for (const directory of directories) yield* walk(path.resolve(directory));
    for (const directory of scenarioDirectories) {
      const { target, title } = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ target: Schema.String, title: Schema.String })),
      )(yield* fs.readFileString(path.join(directory, "scenario.json")));
      const found: FileLines = new Map();
      for (const generation of yield* fs.readDirectory(directory)) {
        const reports = path.join(directory, generation);
        if ((yield* fs.stat(reports)).type !== "Directory") continue;
        for (const report of yield* fs.readDirectory(reports)) {
          const text = yield* fs.readFileString(path.join(reports, report));
          if (report === "lcov.info") readLcov(text, found);
          else if (report.startsWith("browser-")) {
            const coverage = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(BrowserCoverage),
            )(text);
            for (const { url } of coverage) {
              const name = path.basename(new URL(url).pathname);
              const file = bundleFiles.get(name);
              if (file === undefined || bundles.has(name)) continue;
              bundles.set(name, {
                text: yield* fs.readFileString(file),
                map: yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SourceMap))(
                  yield* fs.readFileString(`${file}.map`),
                ),
                directory: path.dirname(file),
              });
            }
            readBrowser(
              coverage,
              root,
              bundleOf,
              (from, to) => path.relative(from, path.resolve(to)),
              found,
            );
          } else if (report.startsWith("workerd-")) {
            const coverage = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(WorkerdCoverage),
            )(text);
            yield* loadModules(
              coverage.bundle,
              fs.readFileString(coverage.bundle).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(BundleModules))),
                Effect.map(
                  (modules) =>
                    new Map(
                      modules.flatMap(({ name, content }) =>
                        typeof content === "string" ? [[name, content] as const] : [],
                      ),
                    ),
                ),
              ),
              `${coverage.bundle}.map`,
            );
            yield* loadModules(
              framework,
              fs.readFileString(framework).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FrameworkModules))),
                Effect.map(({ server }) => new Map(Object.entries(server))),
              ),
              `${framework}.map`,
            );
            const bundleOf = workerdBundleOf(coverage.bundle);
            readBrowser(
              // A module rebuilt since the run no longer matches its coverage's offsets.
              coverage.scripts.filter(
                ({ url, functions }) => bundleOf(url)?.text.length === scriptLength(functions),
              ),
              root,
              bundleOf,
              (from, to) => path.relative(from, path.resolve(to)),
              found,
            );
          } else if (report.endsWith(".json")) {
            const coverage = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(V8Coverage))(
              text,
            );
            for (const { url } of coverage.result) {
              if (!url.startsWith(`file://${root}/`)) continue;
              const file = decodeURIComponent(url.slice(`file://${root}/`.length));
              if (isProduct(file) && !sources.has(file))
                sources.set(
                  file,
                  yield* fs
                    .readFileString(path.join(root, file))
                    .pipe(Effect.orElseSucceed(() => undefined)),
                );
            }
            readV8(coverage, root, source, found);
          }
        }
      }
      let entry = targets.get(target);
      if (entry === undefined)
        targets.set(target, (entry = { executable: new Map(), scenarios: new Map() }));
      const scenario = entry.scenarios.get(title) ?? new Map();
      entry.scenarios.set(title, scenario);
      for (const [file, { executable, covered }] of found) {
        const all = entry.executable.get(file) ?? new Set();
        entry.executable.set(file, all);
        for (const line of executable) all.add(line);
        const into = lines(scenario, file);
        for (const line of covered) into.covered.add(line);
      }
    }
    const collected: Collected = {
      version: 1,
      targets: Object.fromEntries(
        [...targets].map(([target, { executable, scenarios: covered }]) => [
          target,
          {
            executable: Object.fromEntries(
              [...executable]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([file, set]) => [file, encodeLines(set)]),
            ),
            scenarios: [...covered]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([title, files]) => ({
                title,
                ...(fileOf.has(title) ? { file: fileOf.get(title)! } : {}),
                covered: Object.fromEntries(
                  [...files]
                    .filter(([, { covered }]) => covered.size > 0)
                    .map(([file, { covered }]) => [file, encodeLines(covered)]),
                ),
              })),
          },
        ]),
      ),
    };
    yield* fs.writeFileString(out, JSON.stringify(collected));
    yield* Console.log(
      `Collected ${scenarioDirectories.length} product processes' coverage into ${out}: ${Object.entries(
        collected.targets,
      )
        .map(([target, { scenarios }]) => `${target} ${scenarios.length} scenarios`)
        .join(", ")}.`,
    );
  });

/** Union several collected runs, such as CI shards, by target. */
const readCollected = (files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const targets = new Map<
      string,
      {
        executable: Map<string, Set<number>>;
        scenarios: Map<string, { file?: string; covered: Map<string, Set<number>> }>;
      }
    >();
    for (const file of files) {
      const collected = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Collected))(
        yield* fs.readFileString(file),
      );
      for (const [target, data] of Object.entries(collected.targets)) {
        let entry = targets.get(target);
        if (entry === undefined)
          targets.set(target, (entry = { executable: new Map(), scenarios: new Map() }));
        for (const [path, ranges] of Object.entries(data.executable)) {
          const set = entry.executable.get(path) ?? new Set();
          entry.executable.set(path, set);
          for (const line of decodeLines(ranges)) set.add(line);
        }
        for (const scenario of data.scenarios) {
          const into = entry.scenarios.get(scenario.title) ?? {
            ...(scenario.file === undefined ? {} : { file: scenario.file }),
            covered: new Map(),
          };
          entry.scenarios.set(scenario.title, into);
          for (const [path, ranges] of Object.entries(scenario.covered)) {
            const set = into.covered.get(path) ?? new Set();
            into.covered.set(path, set);
            for (const line of decodeLines(ranges)) set.add(line);
          }
        }
      }
    }
    return targets;
  });
type Targets = Effect.Success<ReturnType<typeof readCollected>>;

const covered = (target: Targets extends Map<string, infer T> ? T : never) => {
  const union = new Map<string, Set<number>>();
  for (const { covered } of target.scenarios.values())
    for (const [file, lines] of covered) {
      const set = union.get(file) ?? new Set();
      union.set(file, set);
      for (const line of lines) set.add(line);
    }
  return union;
};
const count = (files: Map<string, Set<number>>) =>
  [...files.values()].reduce((total, lines) => total + lines.size, 0);
const packageOf = (file: string) =>
  file
    .split("/")
    .slice(0, file.startsWith("apps/") ? 3 : 2)
    .join("/");
const percent = (part: number, whole: number) =>
  `${whole === 0 ? 0 : ((100 * part) / whole).toFixed(1)}%`;

const report = (files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const targets = yield* readCollected(files);
    for (const [target, data] of targets) {
      const union = covered(data);
      yield* Console.log(
        `\n${target}: ${count(union)} of ${count(data.executable)} executable lines covered (${percent(count(union), count(data.executable))}) by ${data.scenarios.size} scenarios`,
      );
      const packages = new Map<string, { executable: number; covered: number }>();
      for (const [file, lines] of data.executable) {
        const entry = packages.get(packageOf(file)) ?? { executable: 0, covered: 0 };
        packages.set(packageOf(file), entry);
        entry.executable += lines.size;
        entry.covered += union.get(file)?.size ?? 0;
      }
      for (const [name, { executable, covered }] of [...packages].sort(([a], [b]) =>
        a.localeCompare(b),
      ))
        yield* Console.log(`  ${name}: ${covered}/${executable} (${percent(covered, executable)})`);
      // How many scenarios cover each line; a scenario's unique lines are those only it covers.
      const owners = new Map<string, number>();
      for (const { covered } of data.scenarios.values())
        for (const [file, lines] of covered)
          for (const line of lines)
            owners.set(`${file}:${line}`, (owners.get(`${file}:${line}`) ?? 0) + 1);
      const unique = [...data.scenarios].map(([title, { file, covered }]) => {
        let only = 0;
        for (const [path, lines] of covered)
          for (const line of lines) if (owners.get(`${path}:${line}`) === 1) only++;
        return { title, file, only, total: count(covered) };
      });
      const redundant = unique.filter(({ only }) => only === 0);
      yield* Console.log(
        `  ${redundant.length} scenarios cover no line another scenario does not:`,
      );
      for (const { title, file, total } of redundant.sort((a, b) =>
        (a.file ?? "").localeCompare(b.file ?? ""),
      ))
        yield* Console.log(`    ${file ?? "(no plan entry)"} > ${title} (${total} lines)`);
    }
  });

/**
 * A small set of scenarios that together cover every line all of them cover, chosen greedily: each
 * pick covers the most lines the picks before it left uncovered. Lines are counted on every
 * profiled target, and a scenario is one title wherever it runs. The scenarios outside the set add
 * no line coverage together, not only one at a time. Writes them to `out` as JSON.
 */
const cover = (out: string, files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const targets = yield* readCollected(files);
    const byTitle = new Map<string, { file?: string; lines: Set<string> }>();
    for (const [target, data] of targets)
      for (const [title, { file, covered }] of data.scenarios) {
        const entry = byTitle.get(title) ?? {
          ...(file === undefined ? {} : { file }),
          lines: new Set(),
        };
        byTitle.set(title, entry);
        for (const [path, lines] of covered)
          for (const line of lines) entry.lines.add(`${target}:${path}:${line}`);
      }
    const left = new Map(byTitle);
    const uncovered = new Set([...byTitle.values()].flatMap(({ lines }) => [...lines]));
    const kept: string[] = [];
    while (uncovered.size > 0) {
      let best: [string, number] | undefined;
      for (const [title, { lines }] of left) {
        let gain = 0;
        for (const line of lines) if (uncovered.has(line)) gain++;
        if (best === undefined || gain > best[1]) best = [title, gain];
      }
      if (best === undefined || best[1] === 0) break;
      kept.push(best[0]);
      for (const line of left.get(best[0])!.lines) uncovered.delete(line);
      left.delete(best[0]);
    }
    const unneeded = [...left].map(([title, { file }]) => ({ title, file }));
    yield* fs.writeFileString(out, `${JSON.stringify({ kept, unneeded }, null, 2)}\n`);
    yield* Console.log(
      `${kept.length} of ${byTitle.size} scenarios cover every line; the other ${unneeded.length} add none. Wrote ${out}.`,
    );
  });

const totals = (targets: Targets) =>
  Object.fromEntries(
    [...targets].map(([target, data]) => [target, { covered: count(covered(data)) }]),
  );

const check = (baselineFile: string, files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseline = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Baseline))(
      yield* fs.readFileString(baselineFile),
    );
    const measured = totals(yield* readCollected(files));
    const problems: string[] = [];
    for (const [target, { covered: expected }] of Object.entries(baseline.targets)) {
      const actual = measured[target]?.covered;
      if (actual === undefined) {
        problems.push(`${target}: no coverage was collected`);
        continue;
      }
      const floor = Math.floor(expected * (1 - baseline.tolerance));
      yield* Console.log(
        `${target}: ${actual} lines covered; baseline ${expected}, floor ${floor}.`,
      );
      if (actual < floor)
        problems.push(
          `${target}: ${actual} lines covered, below the baseline's ${expected} by more than the tolerance (floor ${floor})`,
        );
      else if (actual > expected * (1 + baseline.tolerance))
        yield* Console.log(
          `${target}: coverage rose past the tolerance; raise the baseline with \`node e2e/coverage.ts baseline\`.`,
        );
    }
    if (problems.length > 0)
      return yield* new CoverageFailed({
        message: `${problems.join("\n")}\nRestore the scenarios that covered those lines. If the change removed product code, record the new baseline with \`node e2e/coverage.ts baseline ${baselineFile} <collected files>\`.`,
      });
  });

const baseline = (baselineFile: string, files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const previous = yield* fs.readFileString(baselineFile).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Baseline))),
      Effect.map(({ tolerance }) => tolerance),
      Effect.orElseSucceed(() => 0.004),
    );
    const targets = totals(yield* readCollected(files));
    yield* fs.writeFileString(
      baselineFile,
      `${JSON.stringify({ tolerance: previous, targets }, null, 2)}\n`,
    );
    yield* Console.log(`Wrote ${baselineFile}: ${JSON.stringify(targets)}`);
  });

NodeRuntime.runMain(
  Effect.gen(function* () {
    const [command, first, ...rest] = process.argv.slice(2);
    if (command === "collect" && first !== undefined && rest.length > 0)
      return yield* collect(first, rest);
    if (command === "report" && first !== undefined) return yield* report([first, ...rest]);
    if (command === "cover" && first !== undefined && rest.length > 0)
      return yield* cover(first, rest);
    if (command === "check" && first !== undefined && rest.length > 0)
      return yield* check(first, rest);
    if (command === "baseline" && first !== undefined && rest.length > 0)
      return yield* baseline(first, rest);
    return yield* new CoverageFailed({
      message:
        "Usage: node e2e/coverage.ts collect <out> <run directory...> | report <collected...> | cover <out> <collected...> | check <baseline> <collected...> | baseline <baseline> <collected...>",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
