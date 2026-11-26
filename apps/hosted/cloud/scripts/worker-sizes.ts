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

const lowHeadroom = 0.05;

const growthLimit = 50_000;

const compileMs = (size: number) => Math.round((size / 1_000_000) * 40);

interface Allowance {
  readonly bytes: number;
  readonly reason: string;
}

const placeholder = "<why it is worth the cold-start time>";

const mergedAllowances = (
  merged: ReadonlyArray<{ readonly number: number; readonly body: string }>,
) => {
  const allowances = new Map<string, Allowance>();
  const unread: Array<string> = [];
  for (const pull of merged) {
    const own = allowancesIn(pull.body);
    unread.push(...own.unread.map((line) => `#${pull.number}: ${line}`));
    for (const [worker, allowance] of own.allowances) {
      const sum = allowances.get(worker);
      allowances.set(worker, {
        bytes: (sum?.bytes ?? 0) + allowance.bytes,
        reason: `${sum === undefined ? "" : `${sum.reason}; `}#${pull.number}: ${allowance.reason}`,
      });
    }
  }
  return { allowances, unread };
};

const allowancesIn = (description: string) => {
  const allowances = new Map<string, Allowance>();
  const unread: Array<string> = [];
  for (const [, block = ""] of description.matchAll(
    /^```worker-growth[ \t]*\r?\n([\s\S]*?)^```/gmu,
  ))
    for (const line of block.split("\n").map((line) => line.trim())) {
      if (line === "") continue;
      const [, worker, size, reason] = /^([a-z-]+) \+?([0-9][0-9,]*): *(\S.*)$/u.exec(line) ?? [];
      if (
        worker === undefined ||
        size === undefined ||
        reason === undefined ||
        reason === placeholder
      )
        unread.push(line);
      else allowances.set(worker, { bytes: Number(size.replaceAll(",", "")), reason });
    }
  return { allowances, unread };
};

const WorkerUploadSchema = Schema.Struct({
  worker: Schema.String,
  bytes: Schema.Number,
  budget: Schema.Number,
  staticBytes: Schema.optionalKey(Schema.Number),
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

const sourceFile = (source: string) =>
  source
    .replace(/node_modules\/\.bun\/[^/]+\/node_modules\//, "node_modules/")
    .replace(/(\/dist\/server\/assets\/.+)-[\w-]{8}\.js$/, "$1.js");

const bytes = (value: number) => value.toLocaleString("en-US");
const signed = (value: number) => `${value > 0 ? "+" : ""}${bytes(value)}`;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

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

interface Measured {
  readonly worker: string;
  readonly budget: number;
  readonly bytes: number;
  readonly stages: ReadonlyArray<string>;
}

interface Growth {
  readonly worker: string;
  readonly added: number;
  readonly what: "upload" | "static imports";
  readonly allowance: Allowance | undefined;
}

interface Build {
  readonly stage: string;
  readonly uploads: ReadonlyMap<string, WorkerUpload>;
  readonly failures: ReadonlyArray<string>;
}

const report = (
  productionBuild: Build,
  previewBuild: Build | undefined,
  base: ReadonlyMap<string, WorkerUpload> | undefined,
  allowed:
    | {
        readonly allowances: ReadonlyMap<string, Allowance>;
        readonly unread: ReadonlyArray<string>;
      }
    | undefined,
  baseline: string,
) => {
  const uploads = productionBuild.uploads;
  const failures = [...(previewBuild?.failures ?? []), ...productionBuild.failures];
  const grown: Array<Growth> = [...uploads.values()].flatMap((upload) => {
    const before = base?.get(upload.worker);
    const uploaded = before === undefined ? 0 : upload.bytes - before.bytes;
    const imported =
      before?.staticBytes === undefined || upload.staticBytes === undefined
        ? 0
        : upload.staticBytes - before.staticBytes;
    const added = Math.max(uploaded, imported);
    return added > growthLimit
      ? [
          {
            worker: upload.worker,
            added,
            what: imported > uploaded ? ("static imports" as const) : ("upload" as const),
            allowance: allowed?.allowances.get(upload.worker),
          },
        ]
      : [];
  });
  const unallowed =
    allowed === undefined
      ? []
      : grown.filter(({ added, allowance }) => allowance === undefined || allowance.bytes < added);
  const unread = [
    ...(allowed?.unread ?? []).map(
      (line) =>
        `\`${line}\` is not a Worker, a size and a reason (write the real reason in place of ${placeholder})`,
    ),
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
        ? ` The sizes of ${baseline} were not available, so no change is shown and growth is not checked.`
        : ""),
    "",
    previewBuild === undefined
      ? `| Worker | \`${productionBuild.stage}\` | Change from ${baseline} | Budget | Headroom |`
      : `| Worker | \`${productionBuild.stage}\` | \`${previewBuild.stage}\` | Change from ${baseline} | Budget | Headroom |`,
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
    const budgetOnMain =
      before === undefined || before.budget === worker.budget
        ? ""
        : ` (${baseline}: ${bytes(before.budget)})`;
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
  lines.push(
    "### Static imports",
    "",
    "What each Worker's entry imports statically, which Cloudflare compiles and evaluates when an " +
      "isolate starts. A module only a dynamic `import()` loads is uploaded but waits for the " +
      "request that needs it.",
    "",
    `| Worker | Static imports | Change from ${baseline} |`,
    "|---|---:|---:|",
    ...[...uploads.values()].map((upload) => {
      const before = base?.get(upload.worker)?.staticBytes;
      return (
        `| ${upload.worker} | ${upload.staticBytes === undefined ? "n/a" : bytes(upload.staticBytes)} | ` +
        `${before === undefined || upload.staticBytes === undefined ? "n/a" : signed(upload.staticBytes - before)} |`
      );
    }),
    "",
  );
  if (grown.length > 0)
    lines.push(
      `### Growth past ${bytes(growthLimit)} bytes`,
      "",
      `A pull request may add ${bytes(growthLimit)} bytes to a Worker's upload, and as many to the ` +
        `modules its entry imports statically, about ${compileMs(growthLimit)} ms on each of its ` +
        "cold starts. More has to be allowed in its description, with the reason it is worth the time.",
      "",
      ...grown.map(
        ({ worker, added, what, allowance }) =>
          `- ${worker}: ${signed(added)} bytes${what === "upload" ? "" : ` of ${what}`}, about ${compileMs(added)} ms.` +
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
      "Cloudflare compiles and evaluates the modules a Worker's entry imports statically when an " +
        "isolate starts, on every cold request, and refuses an upload whose startup takes more than a " +
        "second of CPU. A dynamic `import()` keeps a module out of startup, but its chunk is still " +
        "uploaded and counts toward the budget. A budget is a backstop, not room to fill; one changes " +
        "only in a pull request of its own that says what the added cold-start time buys.",
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

const build = (previewNumber: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* path.fromFileUrl(workerUploadDirectory);
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
  const baseline = flag("--baseline") ?? "main";
  const base = baseDirectory === undefined ? undefined : yield* readUploads(baseDirectory);
  const descriptionFile = flag("--description");
  const mergedFile = flag("--merged");
  const merged =
    mergedFile === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Array(Schema.Struct({ number: Schema.Number, body: Schema.String })),
          ),
        )(yield* fs.readFileString(mergedFile));
  const { markdown, over, low, unallowed, unread, failures } = report(
    built.production,
    built.preview,
    base === undefined || base.size === 0 ? undefined : base,
    merged !== undefined
      ? mergedAllowances(merged)
      : descriptionFile === undefined
        ? undefined
        : allowancesIn(yield* fs.readFileString(descriptionFile)),
    baseline,
  );
  const pulls = (merged ?? []).map((pull) => `#${pull.number}`).join(", ");
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
  for (const { worker, added, what, allowance } of unallowed)
    yield* Console.log(
      merged !== undefined
        ? `::error title=${worker} Worker grew on main without an allowance::This push adds ${signed(added)} bytes${what === "upload" ? "" : ` of ${what}`} to ${worker} over ${baseline}, about ${compileMs(added)} ms on each cold start; ` +
            (merged.length === 0
              ? "it merges no pull request, so no description allows it."
              : allowance === undefined
                ? `the pull requests it merges (${pulls}) allow none.`
                : `the pull requests it merges (${pulls}) allow ${bytes(allowance.bytes)}.`) +
            ` Put the line \`${worker} ${signed(added)}: ${placeholder}\` in a worker-growth block of the merged pull request's description, with your reason, and run this failed job again, which reads the descriptions afresh; or shrink ${worker} in a new pull request. See the job summary for what grew.`
        : `::error title=${worker} Worker grew without an allowance::${signed(added)} bytes${what === "upload" ? "" : ` of ${what}`} over ${baseline}, about ${compileMs(added)} ms on each cold start; ` +
            (allowance === undefined
              ? `a pull request may add ${bytes(growthLimit)}.`
              : `the description allows ${bytes(allowance.bytes)}.`) +
            ` Trim it, or allow it: put the line \`${worker} ${signed(added)}: ${placeholder}\` in a worker-growth block of the pull request description, with your reason in place of ${placeholder}, then run this job again. See the job summary for what grew.`,
    );
  if (merged !== undefined)
    for (const problem of unread)
      yield* Console.log(
        `::notice title=Worker sizes::A merged pull request's allowance: ${problem}.`,
      );
  if (unallowed.length > 0)
    yield* Console.log(
      [
        "To allow this growth, add this block to the pull request description, with a reason after each colon, then run this job again:",
        "",
        "```worker-growth",
        ...unallowed.map(({ worker, added }) => `${worker} ${signed(added)}: ${placeholder}`),
        "```",
      ].join("\n"),
    );
  const problems = [
    ...(failures.length > 0 ? [`Worker builds failed: ${failures.join("; ")}`] : []),
    ...(over.length > 0 ? [`Over budget: ${over.map((worker) => worker.worker).join(", ")}`] : []),
    ...(unallowed.length > 0
      ? [
          `Grew without an allowance: ${unallowed.map((grew) => grew.worker).join(", ")}. Lines to add to a worker-growth block of the description, each with its reason: ${unallowed.map(({ worker, added }) => `${worker} ${signed(added)}: <reason>`).join("; ")}`,
        ]
      : []),
    ...(unread.length > 0 && merged === undefined
      ? [`Allowances this check cannot read: ${unread.join("; ")}`]
      : []),
  ];
  if (problems.length > 0) return yield* new WorkerSizesFailed({ message: problems.join(". ") });
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
