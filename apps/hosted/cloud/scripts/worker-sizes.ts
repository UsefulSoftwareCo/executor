/**
 * Build every budgeted Worker the way `alchemy deploy` does, report what each uploads, and hold
 * a pull request to what it adds.
 *
 * The deploy enforces each Worker's upload budget inside its Rolldown build
 * (`src/infrastructure/worker-build.ts`). This runs that same build (`worker-builds.ts`) in the
 * check job, without credentials or a deploy, so a pull request learns its sizes in minutes
 * instead of when its preview or the production deploy fails. It builds production, and with
 * `--preview` the pull request's preview stage too.
 *
 *   bun run hosted:cloud:worker-sizes [--preview <pull request number>] [--base <directory>]
 *     [--description <file>] [--uploads <directory>]
 *
 * With `--base`, each Worker is compared with main's uploads, and the packages and files that
 * grew are named. A budget is a backstop with room under it, so the comparison is what keeps a
 * Worker from growing unnoticed: with `--description`, the pull request's description, a Worker
 * that adds more than `growthLimit` fails unless the description allows it in a block like
 *
 *   ```worker-growth
 *   api +120,000: the SAML sign-in library, which every enterprise sign-in loads
 *   ```
 *
 * Each line names a Worker, the most bytes it may add, and why that is worth the cold-start time.
 * Without `--description`, as on a push to main, growth is only reported. A Worker main does not
 * have yet is held to its budget alone.
 *
 * With `--uploads`, nothing is built: the report and the checks read uploads a build already
 * wrote, such as the `worker-uploads` artifact of a CI run.
 *
 * It also fails when a deployed build contains a local test hook (`localTestModules` in
 * `worker-build.ts`): only `alchemy dev` may bundle one, so no binding or request can turn it on
 * in a deployed Worker. Each uploaded file is searched for the hook's text, and each Worker's
 * sources for the hook's file.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, FileSystem, Option, Path, Schema } from "effect";
import { localTestModules } from "../src/infrastructure/worker-build.ts";
import {
  packageOf,
  workerUploadDirectory,
  type WorkerUpload,
} from "../src/infrastructure/worker-upload.ts";
import type { Target } from "./worker-builds.ts";

class WorkerSizesFailed extends Schema.TaggedError<WorkerSizesFailed>()("WorkerSizesFailed", {
  message: Schema.String,
}) {}

/**
 * Below this share of its budget left, a Worker is flagged, so the budget is looked at again
 * before a change runs into it.
 */
const lowHeadroom = 0.05;

/**
 * Bytes a pull request may add to one Worker's upload before its description has to allow it:
 * about 2 ms on each of that Worker's cold starts.
 */
const growthLimit = 50_000;

/** Milliseconds a cold start spends compiling this many uploaded bytes; see `worker-build.ts`. */
const compileMs = (size: number) => Math.round((size / 1_000_000) * 40);

/** The most bytes a pull request's description lets one Worker add, and why. */
interface Allowance {
  readonly bytes: number;
  readonly reason: string;
}

/**
 * The allowances in a description's `worker-growth` blocks, one line for each Worker, and the
 * lines that do not read as one.
 */
const allowancesIn = (description: string) => {
  const allowances = new Map<string, Allowance>();
  const unread: Array<string> = [];
  for (const [, block = ""] of description.matchAll(
    /^```worker-growth[ \t]*\r?\n([\s\S]*?)^```/gmu,
  ))
    for (const line of block.split("\n").map((line) => line.trim())) {
      if (line === "") continue;
      const [, worker, size, reason] = /^([a-z-]+) \+?([0-9][0-9,]*): *(\S.*)$/u.exec(line) ?? [];
      if (worker === undefined || size === undefined || reason === undefined) unread.push(line);
      else allowances.set(worker, { bytes: Number(size.replaceAll(",", "")), reason });
    }
  return { allowances, unread };
};

const WorkerUploadSchema = Schema.Struct({
  worker: Schema.String,
  bytes: Schema.Number,
  budget: Schema.Number,
  sources: Schema.Record(Schema.String, Schema.Number),
});

const readUploads = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(directory))) return new Map<string, WorkerUpload>();
    const uploads = new Map<string, WorkerUpload>();
    for (const file of (yield* fs.readDirectory(directory)).toSorted()) {
      if (!file.endsWith(".json")) continue;
      const upload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WorkerUploadSchema))(
        yield* fs.readFileString(path.join(directory, file)),
      );
      uploads.set(upload.worker, upload);
    }
    return uploads;
  });

/**
 * Name a file the same way in every build: Bun installs packages under
 * `node_modules/.bun/<name>@<version>/`, and the site build adds a content hash to each asset.
 */
const sourceFile = (source: string) =>
  source
    .replace(/node_modules\/\.bun\/[^/]+\/node_modules\//, "node_modules/")
    .replace(/(\/dist\/server\/assets\/.+)-[\w-]{8}\.js$/, "$1.js");

const bytes = (value: number) => value.toLocaleString("en-US");
const signed = (value: number) => `${value > 0 ? "+" : ""}${bytes(value)}`;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

/** The entries whose bytes changed most between two attributions, largest change first. */
const changes = (
  current: Readonly<Record<string, number>>,
  base: Readonly<Record<string, number>>,
  key: (source: string) => string,
) => {
  const totals = new Map<string, number>();
  for (const [source, size] of Object.entries(current))
    totals.set(key(source), (totals.get(key(source)) ?? 0) + size);
  for (const [source, size] of Object.entries(base))
    totals.set(key(source), (totals.get(key(source)) ?? 0) - size);
  return [...totals]
    .filter(([, delta]) => delta !== 0)
    .toSorted((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
};

const table = (
  heading: string,
  rows: ReadonlyArray<readonly [string, number]>,
  format: (size: number) => string = signed,
) =>
  rows.length === 0
    ? []
    : [
        `| ${heading} | Bytes |`,
        "|---|---:|",
        ...rows.map(([name, size]) => `| \`${name}\` | ${format(size)} |`),
        "",
      ];

/** Each Worker's larger build decides its headroom; a preview can fail where production passes. */
interface Measured {
  readonly worker: string;
  readonly budget: number;
  readonly bytes: number;
  readonly stages: ReadonlyArray<string>;
}

/** A Worker that added more than `growthLimit` to main's upload, and what the description allows it. */
interface Growth {
  readonly worker: string;
  readonly added: number;
  readonly allowance: Allowance | undefined;
}

/** One stage's uploads, and what failed while building or inspecting them. */
interface Build {
  readonly stage: string;
  readonly uploads: ReadonlyMap<string, WorkerUpload>;
  readonly failures: ReadonlyArray<string>;
}

const report = (
  productionBuild: Build,
  previewBuild: Build | undefined,
  base: ReadonlyMap<string, WorkerUpload> | undefined,
  description: string | undefined,
) => {
  const uploads = productionBuild.uploads;
  const failures = [...(previewBuild?.failures ?? []), ...productionBuild.failures];
  const allowed = description === undefined ? undefined : allowancesIn(description);
  const grown: Array<Growth> = [...uploads.values()].flatMap((upload) => {
    const before = base?.get(upload.worker);
    const added = before === undefined ? 0 : upload.bytes - before.bytes;
    return added > growthLimit
      ? [{ worker: upload.worker, added, allowance: allowed?.allowances.get(upload.worker) }]
      : [];
  });
  const unallowed =
    allowed === undefined
      ? []
      : grown.filter(({ added, allowance }) => allowance === undefined || allowance.bytes < added);
  const unread = [
    ...(allowed?.unread ?? []).map((line) => `\`${line}\` is not a Worker, a size and a reason`),
    ...[...(allowed?.allowances.keys() ?? [])]
      .filter((worker) => !uploads.has(worker))
      .map((worker) => `\`${worker}\` is not a Worker this check builds`),
  ];
  const measured: Array<Measured> = [...uploads.values()].map((upload) => {
    const previewBytes = previewBuild?.uploads.get(upload.worker)?.bytes ?? 0;
    const bytes = Math.max(upload.bytes, previewBytes);
    return {
      worker: upload.worker,
      budget: upload.budget,
      bytes,
      stages: [
        ...(upload.bytes === bytes ? [productionBuild.stage] : []),
        ...(previewBuild !== undefined && previewBytes === bytes ? [previewBuild.stage] : []),
      ],
    };
  });
  const over = measured.filter((worker) => worker.bytes > worker.budget);
  const low = measured.filter(
    (worker) =>
      worker.bytes <= worker.budget && worker.budget - worker.bytes < worker.budget * lowHeadroom,
  );
  const lines = [
    "## Worker upload sizes",
    "",
    "Built as `alchemy deploy` builds them, against the budgets in " +
      "`apps/hosted/cloud/src/infrastructure/worker-build.ts`. Headroom is for the larger build." +
      (base === undefined
        ? " Main's sizes for this base were not available, so no change is shown and growth is not checked."
        : ""),
    "",
    previewBuild === undefined
      ? `| Worker | \`${productionBuild.stage}\` | Change from main | Budget | Headroom |`
      : `| Worker | \`${productionBuild.stage}\` | \`${previewBuild.stage}\` | Change from main | Budget | Headroom |`,
    previewBuild === undefined ? "|---|---:|---:|---:|---:|" : "|---|---:|---:|---:|---:|---:|",
  ];
  for (const worker of measured) {
    const upload = uploads.get(worker.worker);
    const before = base?.get(worker.worker);
    const previewUpload = previewBuild?.uploads.get(worker.worker);
    const left = worker.budget - worker.bytes;
    const flag = left < 0 ? " **over budget**" : left < worker.budget * lowHeadroom ? " low" : "";
    const growth = unallowed.some((grew) => grew.worker === worker.worker)
      ? " **needs an allowance**"
      : "";
    // A budget is changed in a pull request of its own, so a change is shown where it is read.
    const budgetOnMain =
      before === undefined || before.budget === worker.budget
        ? ""
        : ` (main: ${bytes(before.budget)})`;
    lines.push(
      `| ${worker.worker} | ${upload === undefined ? "n/a" : bytes(upload.bytes)} | ` +
        (previewBuild === undefined
          ? ""
          : `${previewUpload === undefined ? "n/a" : bytes(previewUpload.bytes)} | `) +
        `${before === undefined || upload === undefined ? "n/a" : signed(upload.bytes - before.bytes)}${growth} | ` +
        `${bytes(worker.budget)}${budgetOnMain} | ${signed(left)} (${percent(left / worker.budget)})${flag} |`,
    );
  }
  lines.push("");
  for (const upload of uploads.values()) {
    const before = base?.get(upload.worker);
    if (before === undefined || before.bytes === upload.bytes) continue;
    lines.push(
      `### ${upload.worker}: ${signed(upload.bytes - before.bytes)} bytes`,
      "",
      ...table("Package", changes(upload.sources, before.sources, packageOf).slice(0, 10)),
      ...table("File", changes(upload.sources, before.sources, sourceFile).slice(0, 10)),
    );
  }
  if (grown.length > 0)
    lines.push(
      `### Growth past ${bytes(growthLimit)} bytes`,
      "",
      `A pull request may add ${bytes(growthLimit)} bytes to a Worker's upload, about ` +
        `${compileMs(growthLimit)} ms on each of its cold starts. More has to be allowed in its ` +
        "description, with the reason it is worth the time.",
      "",
      ...grown.map(
        ({ worker, added, allowance }) =>
          `- ${worker}: ${signed(added)} bytes, about ${compileMs(added)} ms.` +
          (allowance === undefined
            ? ""
            : allowance.bytes < added
              ? ` The description allows ${bytes(allowance.bytes)}.`
              : ` Allowed up to ${bytes(allowance.bytes)}: ${allowance.reason}`),
      ),
      "",
    );
  if (unallowed.length > 0)
    lines.push(
      "Trim what grew (see Making room), or put these lines in the pull request description with " +
        "a reason after each colon, then run this job again:",
      "",
      "````",
      "```worker-growth",
      ...unallowed.map(({ worker, added }) => `${worker} ${signed(added)}:`),
      "```",
      "````",
      "",
    );
  if (unread.length > 0)
    lines.push(
      "### Allowances this check cannot read",
      "",
      "A line of the description's `worker-growth` block reads `api +120,000: the reason`.",
      "",
      ...unread.map((problem) => `- ${problem}`),
      "",
    );
  if (over.length > 0 || low.length > 0 || unallowed.length > 0)
    lines.push(
      "### Making room",
      "",
      "Cloudflare compiles every uploaded module when an isolate starts, whether or not it runs: " +
        "about 40 ms for each megabyte, on every cold request. A dynamic `import()` does not help: " +
        "its chunk is still uploaded. A budget is a backstop, not room to fill; one changes only in " +
        "a pull request of its own that says what the added cold-start time buys.",
      "",
      "- Move rarely used code to another Worker behind a service binding, as `dashboard`, " +
        "`formatter`, `authoring` and `mcp-server` do for the API Worker.",
      "- Serve large text or data as static assets or from storage instead of bundling it as JavaScript.",
      "- Remove duplicate copies of a package and import narrower entry points.",
      "",
    );
  for (const upload of uploads.values())
    lines.push(
      `<details><summary>${upload.worker}: largest packages</summary>`,
      "",
      ...table("Package", changes(upload.sources, {}, packageOf).slice(0, 15), bytes),
      "</details>",
      "",
    );
  if (failures.length > 0)
    lines.push("### Build failures", "", ...failures.map((failure) => `- ${failure}`), "");
  return { markdown: lines.join("\n"), over, low, unallowed, unread, failures };
};

const flag = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

/** A stage's uploads with their failures, adding any local test hook among the sources. */
const inspected = (
  stage: string,
  uploads: ReadonlyMap<string, WorkerUpload>,
  failures: ReadonlyArray<string>,
): Build => ({
  stage,
  uploads,
  failures: [
    ...failures,
    ...[...uploads.values()].flatMap((upload) =>
      Object.keys(upload.sources)
        .filter((source) =>
          localTestModules.some(([, hook]) => source.endsWith(`/infrastructure/${hook}`)),
        )
        .map(
          (source) =>
            `${stage} ${upload.worker}: uploads the local test hook ${source}, ` +
            "which only an `alchemy dev` build may bundle",
        ),
    ),
  ],
});

/** Build the preview, when asked for, and then production. */
const build = (previewNumber: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* path.fromFileUrl(workerUploadDirectory);
    // Loaded only to build: it imports the whole stack, which needs the generated framework.
    const { buildWorkers, preview, production } = yield* Effect.promise(
      () => import("./worker-builds.ts"),
    );
    const measure = (target: Target) =>
      Effect.gen(function* () {
        yield* fs.remove(directory, { recursive: true, force: true });
        const failures = yield* buildWorkers(target);
        return inspected(target.stage, yield* readUploads(directory), failures);
      });
    const previewBuild =
      previewNumber === undefined ? undefined : yield* measure(preview(Number(previewNumber)));
    // Production builds last, so the uploads left in the directory are production's.
    return { preview: previewBuild, production: yield* measure(production) };
  });

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const previewNumber = flag("--preview");
  if (previewNumber !== undefined && !/^[1-9][0-9]*$/.test(previewNumber))
    return yield* new WorkerSizesFailed({ message: `--preview takes a pull request number` });
  const given = flag("--uploads");
  if (given !== undefined && previewNumber !== undefined)
    return yield* new WorkerSizesFailed({
      message: "--preview builds a stage, and --uploads reads uploads already built; give one",
    });
  const built =
    given === undefined
      ? yield* build(previewNumber)
      : { preview: undefined, production: inspected(given, yield* readUploads(given), []) };
  if (built.production.uploads.size === 0 && built.production.failures.length === 0)
    return yield* new WorkerSizesFailed({
      message: `No Worker uploads in ${given ?? "the build's output"}`,
    });
  const baseDirectory = flag("--base");
  const base = baseDirectory === undefined ? undefined : yield* readUploads(baseDirectory);
  const descriptionFile = flag("--description");
  const { markdown, over, low, unallowed, unread, failures } = report(
    built.production,
    built.preview,
    base === undefined || base.size === 0 ? undefined : base,
    descriptionFile === undefined ? undefined : yield* fs.readFileString(descriptionFile),
  );
  yield* Console.log(markdown);
  const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.option);
  if (Option.isSome(summary))
    yield* fs.writeFileString(summary.value, `${markdown}\n`, { flag: "a" });
  for (const worker of over)
    yield* Console.log(
      `::error title=${worker.worker} Worker over its upload budget::${bytes(worker.bytes)} bytes on ${worker.stages.join(" and ")}, budget ${bytes(worker.budget)}. See the job summary for what grew.`,
    );
  for (const worker of low)
    yield* Console.log(
      `::warning title=${worker.worker} Worker near its upload budget::${bytes(worker.budget - worker.bytes)} bytes left on ${worker.stages.join(" and ")} (${percent((worker.budget - worker.bytes) / worker.budget)}).`,
    );
  for (const { worker, added, allowance } of unallowed)
    yield* Console.log(
      `::error title=${worker} Worker grew without an allowance::${signed(added)} bytes over main, about ${compileMs(added)} ms on each cold start; ` +
        (allowance === undefined
          ? `a pull request may add ${bytes(growthLimit)}.`
          : `the description allows ${bytes(allowance.bytes)}.`) +
        " Trim it or allow it in the pull request description. See the job summary for what grew and the lines to add.",
    );
  const problems = [
    ...(failures.length > 0 ? [`Worker builds failed: ${failures.join("; ")}`] : []),
    ...(over.length > 0 ? [`Over budget: ${over.map((worker) => worker.worker).join(", ")}`] : []),
    ...(unallowed.length > 0
      ? [`Grew without an allowance: ${unallowed.map((grew) => grew.worker).join(", ")}`]
      : []),
    ...(unread.length > 0 ? [`Allowances this check cannot read: ${unread.join("; ")}`] : []),
  ];
  if (problems.length > 0) return yield* new WorkerSizesFailed({ message: problems.join(". ") });
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
