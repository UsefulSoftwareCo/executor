import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, FileSystem, Option, Path, Schema } from "effect";
import { createHash } from "node:crypto";
import { scenarios } from "./test-plan.ts";

class CoverageFailed extends Schema.TaggedError<CoverageFailed>()("CoverageFailed", {
  message: Schema.String,
}) {}

const LineRanges = Schema.String;
const Collected = Schema.Struct({
  version: Schema.Literal(1),
  targets: Schema.Record(
    Schema.String,
    Schema.Struct({
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
  targets: Schema.Record(
    Schema.String,
    Schema.Struct({
      covered: Schema.Number,
      tolerance: Schema.Number,
    }),
  ),
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

const isProduct = (file: string) =>
  !file.startsWith("e2e/") &&
  !file.includes("node_modules/") &&
  !file.includes("/dist/") &&
  !file.startsWith("apps/hosted/self-host/scripts/") &&
  /\.[cm]?[jt]sx?$/.test(file);

type FileLines = Map<string, { executable: Set<number>; covered: Set<number> }>;
const lines = (into: FileLines, file: string) => {
  let entry = into.get(file);
  if (entry === undefined) into.set(file, (entry = { executable: new Set(), covered: new Set() }));
  return entry;
};

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

const paint = (functions: typeof V8Functions.Type, length: number) => {
  const counts = new Int32Array(length).fill(-1);
  const ranges = functions
    .flatMap((fn) => fn.ranges)
    .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const range of ranges)
    counts.fill(range.count, range.startOffset, Math.min(range.endOffset, length));
  return counts;
};

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

const WorkerdCoverage = Schema.Struct({ bundle: Schema.String, scripts: BrowserCoverage });
const BundleModules = Schema.Array(Schema.Struct({ name: Schema.String, content: Schema.Unknown }));
const FrameworkModules = Schema.Struct({ server: Schema.Record(Schema.String, Schema.String) });
const SourceMaps = Schema.Record(Schema.String, SourceMap);
const scriptLength = (functions: typeof V8Functions.Type) =>
  Math.max(
    0,
    ...functions.flatMap(({ ranges }) =>
      ranges[0]?.startOffset === 0 ? [ranges[0].endOffset] : [],
    ),
  );

const excerptWindow = 64;
const excerptBytes = 4 * excerptWindow;
const messageLength = 240;
const pathBytes = 256;

const escapedBytes = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) =>
    byte === 0x5c
      ? "\\\\"
      : byte >= 0x20 && byte < 0x7f
        ? String.fromCharCode(byte)
        : `\\x${byte.toString(16).padStart(2, "0")}`,
  );
const escapeBytes = (bytes: Uint8Array) => escapedBytes(bytes).join("");

const escapeText = (text: string, limit: number) => {
  const escaped = escapeBytes(Buffer.from(text, "utf8"));
  return escaped.length <= limit ? escaped : `${escaped.slice(0, limit)}... (cut)`;
};

const escapePath = (file: string) => {
  const bytes = escapedBytes(Buffer.from(file, "utf8"));
  if (bytes.length <= pathBytes) return bytes.join("");
  const head = pathBytes / 4;
  return `${bytes.slice(0, head).join("")}...(cut)...${bytes.slice(bytes.length - (pathBytes - head)).join("")}`;
};

const decodeUtf8 = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const withoutQuotedInput = (message: string) =>
  message.replace(
    /^(Unexpected token '.*?'), (?:\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/su,
    "$1, not valid JSON",
  );

const firstInvalidByte = (bytes: Uint8Array): number | undefined => {
  const size = bytes.length;
  let at = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const isDigit = (byte: number | undefined) => byte !== undefined && byte >= 0x30 && byte <= 0x39;
  const skipSpace = () => {
    while (at < size) {
      const byte = bytes[at];
      if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return;
      at++;
    }
  };
  const string = () => {
    at++;
    while (at < size) {
      const byte = bytes[at]!;
      if (byte === 0x22) {
        at++;
        return true;
      }
      if (byte < 0x20) return false;
      if (byte === 0x5c) {
        const escape = bytes[at + 1];
        if (escape === undefined) {
          at = size;
          return false;
        }
        if (escape === 0x75) {
          at += 2;
          for (let digit = 0; digit < 4; digit++, at++) {
            const hex = bytes[at];
            if (hex === undefined) return false;
            const isHex =
              isDigit(hex) || (hex >= 0x41 && hex <= 0x46) || (hex >= 0x61 && hex <= 0x66);
            if (!isHex) return false;
          }
          continue;
        }
        if (![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(escape)) {
          at++;
          return false;
        }
        at += 2;
        continue;
      }
      at++;
    }
    return false;
  };
  const digits = () => {
    if (!isDigit(bytes[at])) return false;
    while (isDigit(bytes[at])) at++;
    return true;
  };
  const scalar = () => {
    const first = bytes[at];
    if (first === 0x2d || isDigit(first)) {
      if (first === 0x2d) at++;
      if (bytes[at] === 0x30) at++;
      else if (!digits()) return false;
      if (bytes[at] === 0x2e) {
        at++;
        if (!digits()) return false;
      }
      if (bytes[at] === 0x65 || bytes[at] === 0x45) {
        at++;
        if (bytes[at] === 0x2b || bytes[at] === 0x2d) at++;
        if (!digits()) return false;
      }
      return true;
    }
    for (const word of ["true", "false", "null"])
      if (first === word.charCodeAt(0)) {
        for (let index = 0; index < word.length; index++, at++)
          if (bytes[at] !== word.charCodeAt(index)) return false;
        return true;
      }
    return false;
  };
  const closers: Array<number> = [];
  let expecting: "value" | "first value" | "key" | "first key" | "after" = "value";
  while (true) {
    skipSpace();
    const next = bytes[at];
    const closer = closers.at(-1);
    if (expecting === "after") {
      if (closer === undefined) return at < size ? at : undefined;
      if (next === 0x2c) expecting = closer === 0x5d ? "value" : "key";
      else if (next === closer) closers.pop();
      else return at;
      at++;
    } else if (
      (expecting === "first value" && next === 0x5d) ||
      (expecting === "first key" && next === 0x7d)
    ) {
      closers.pop();
      at++;
      expecting = "after";
    } else if (expecting === "key" || expecting === "first key") {
      if (next !== 0x22 || !string()) return Math.min(at, size);
      skipSpace();
      if (bytes[at] !== 0x3a) return at;
      at++;
      expecting = "value";
    } else if (next === 0x5b || next === 0x7b) {
      closers.push(next === 0x5b ? 0x5d : 0x7d);
      at++;
      expecting = next === 0x5b ? "first value" : "first key";
    } else if (next === 0x22 ? string() : scalar()) expecting = "after";
    else return Math.min(at, size);
  }
};

const jsonFailureRecord = (failure: {
  readonly file: string;
  readonly bytes: Uint8Array;
  readonly modified: string | undefined;
  readonly parser: string | undefined;
  readonly schema: string | undefined;
}) => {
  const { bytes } = failure;
  const size = bytes.length;
  const found = failure.parser === undefined ? undefined : firstInvalidByte(bytes);
  const offset = found === undefined ? undefined : Math.min(found, size);
  const windows: Array<[number, number]> = [];
  if (size <= excerptBytes) windows.push([0, size]);
  else {
    windows.push([0, excerptWindow]);
    if (offset !== undefined)
      windows.push([Math.max(0, offset - excerptWindow), Math.min(size, offset + excerptWindow)]);
    windows.push([size - excerptWindow, size]);
  }
  const merged: Array<[number, number]> = [];
  for (const [start, end] of windows.sort(([a], [b]) => a - b)) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const error =
    failure.parser !== undefined
      ? `JSON.parse: ${escapeText(failure.parser, messageLength)}; at byte ${offset ?? "unknown"}`
      : `schema: ${escapeText(failure.schema ?? "", messageLength)}`;
  return [
    `${escapePath(failure.file)} could not be read as JSON (${error}).`,
    `  ${size} bytes, sha256 ${createHash("sha256").update(bytes).digest("hex")}, modified ${failure.modified ?? "unknown"}.`,
    `  Excerpt (the whole file up to ${excerptBytes} bytes, else at most ${excerptBytes} of them; other than printable ASCII escaped as \\xNN, a backslash as \\\\):`,
    ...merged.map(
      ([start, end]) => `  bytes ${start}-${end}: ${escapeBytes(bytes.subarray(start, end))}`,
    ),
  ].join("\n");
};

const collect = (out: string, directories: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(".");
    const decodeJson =
      <S extends Schema.Top>(schema: S, file: string) =>
      (bytes: Uint8Array) =>
        Effect.try({
          try: (): unknown => JSON.parse(decodeUtf8(bytes)),
          catch: (error) => (error instanceof Error ? error.message : String(error)),
        }).pipe(
          Effect.matchEffect({
            onFailure: (message) =>
              unreadableJson(file, bytes, { parser: withoutQuotedInput(message) }),
            onSuccess: (value) =>
              Schema.decodeUnknownEffect(schema)(value).pipe(
                Effect.catch((error) => unreadableJson(file, bytes, { schema: error.message })),
              ),
          }),
        );
    const unreadableJson = (
      file: string,
      bytes: Uint8Array,
      error: { readonly parser?: string; readonly schema?: string },
    ) =>
      Effect.gen(function* () {
        const info = yield* fs.stat(file).pipe(Effect.option);
        return yield* new CoverageFailed({
          message: jsonFailureRecord({
            file: path.relative(root, file),
            bytes,
            modified: Option.getOrUndefined(
              Option.flatMap(info, ({ mtime }) => mtime),
            )?.toISOString(),
            parser: error.parser,
            schema: error.schema,
          }),
        });
      });
    const readJson = <S extends Schema.Top>(schema: S, file: string) =>
      fs.readFile(file).pipe(Effect.flatMap(decodeJson(schema, file)));
    const sources = new Map<string, string | undefined>();
    const source = (file: string) => sources.get(file);
    const fileOf = new Map(Object.values(scenarios).map(({ title, file }) => [title, file]));
    const targets = new Map<
      string,
      { executable: Map<string, Set<number>>; scenarios: Map<string, FileLines> }
    >();
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
        const maps = yield* readJson(SourceMaps, mapsFile);
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
      const { target, title } = yield* readJson(
        Schema.Struct({ target: Schema.String, title: Schema.String }),
        path.join(directory, "scenario.json"),
      );
      const found: FileLines = new Map();
      for (const generation of yield* fs.readDirectory(directory)) {
        const reports = path.join(directory, generation);
        if ((yield* fs.stat(reports)).type !== "Directory") continue;
        for (const report of yield* fs.readDirectory(reports)) {
          const file = path.join(reports, report);
          const bytes = yield* fs.readFile(file);
          if (report === "lcov.info") readLcov(decodeUtf8(bytes), found);
          else if (report.startsWith("browser-")) {
            const coverage = yield* decodeJson(BrowserCoverage, file)(bytes);
            for (const { url } of coverage) {
              const name = path.basename(new URL(url).pathname);
              const bundle = bundleFiles.get(name);
              if (bundle === undefined || bundles.has(name)) continue;
              bundles.set(name, {
                text: yield* fs.readFileString(bundle),
                map: yield* readJson(SourceMap, `${bundle}.map`),
                directory: path.dirname(bundle),
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
            const coverage = yield* decodeJson(WorkerdCoverage, file)(bytes);
            yield* loadModules(
              coverage.bundle,
              readJson(BundleModules, coverage.bundle).pipe(
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
              readJson(FrameworkModules, framework).pipe(
                Effect.map(({ server }) => new Map(Object.entries(server))),
              ),
              `${framework}.map`,
            );
            const bundleOf = workerdBundleOf(coverage.bundle);
            readBrowser(
              coverage.scripts.filter(
                ({ url, functions }) => bundleOf(url)?.text.length === scriptLength(functions),
              ),
              root,
              bundleOf,
              (from, to) => path.relative(from, path.resolve(to)),
              found,
            );
          } else if (report.endsWith(".json")) {
            const coverage = yield* decodeJson(V8Coverage, file)(bytes);
            for (const { url } of coverage.result) {
              if (!url.startsWith(`file://${root}/`)) continue;
              const product = decodeURIComponent(url.slice(`file://${root}/`.length));
              if (isProduct(product) && !sources.has(product))
                sources.set(
                  product,
                  yield* fs
                    .readFileString(path.join(root, product))
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
    const rises: string[] = [];
    for (const [target, { covered: expected, tolerance }] of Object.entries(baseline.targets)) {
      const actual = measured[target]?.covered;
      if (actual === undefined) {
        problems.push(`${target}: no coverage was collected`);
        continue;
      }
      const floor = Math.floor(expected * (1 - tolerance));
      yield* Console.log(
        `${target}: ${actual} lines covered; baseline ${expected}, floor ${floor}.`,
      );
      if (actual < floor)
        problems.push(
          `${target}: ${actual} lines covered, below the baseline's ${expected} by more than the tolerance (floor ${floor})`,
        );
      else if (actual > expected * (1 + tolerance))
        rises.push(
          `${target}: ${actual} lines covered, above the baseline's ${expected} by more than ${tolerance * 100}%`,
        );
    }
    if (rises.length > 0) {
      const run = yield* Config.all([
        Config.String("GITHUB_RUN_ID"),
        Config.String("GITHUB_REPOSITORY"),
      ]).pipe(Config.option);
      const record = `node e2e/coverage.ts baseline ${baselineFile} .local/line-coverage/*/line-coverage.json`;
      const command = Option.match(run, {
        onNone: () => [record],
        onSome: ([id, repository]) => [
          `gh run download ${id} --repo ${repository} --pattern 'line-coverage-*' --dir .local/line-coverage`,
          record,
        ],
      });
      for (const rise of rises)
        yield* Console.log(
          `::warning title=Line coverage rose past the baseline::${rise}. Record it: ${command.join(" && ")}`,
        );
      const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.option);
      if (Option.isSome(summary))
        yield* fs.writeFileString(
          summary.value,
          `\n**Line coverage rose past the baseline.** ${rises.join("; ")}. Record this run as the baseline in a pull request:\n\n\`\`\`sh\n${command.join("\n")}\n\`\`\`\n`,
          { flag: "a" },
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
    const previous = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Baseline))(
      yield* fs.readFileString(baselineFile),
    );
    const measured = totals(yield* readCollected(files));
    const targets: Record<string, { covered: number; tolerance: number }> = {};
    for (const [target, { covered }] of Object.entries(measured)) {
      const known = previous.targets[target];
      if (known === undefined)
        return yield* new CoverageFailed({
          message: `${target} is not in ${baselineFile}. Add it with its tolerance, twice the spread of its covered lines over several full runs.`,
        });
      targets[target] = { covered, tolerance: known.tolerance };
    }
    yield* fs.writeFileString(baselineFile, `${JSON.stringify({ targets }, null, 2)}\n`);
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
