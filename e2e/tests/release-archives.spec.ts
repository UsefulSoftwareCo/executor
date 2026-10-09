/**
 * The release workflow's `archives` job runs `scripts/releases/archive-digests.ts` before
 * `publish`, so that the archive the installed CLI suite tested is the archive the release
 * publishes. These cases run the metadata job's `scripts/releases/workflow.ts` for its matrices,
 * record digests with the script as the `local` and `cli` jobs do, lay them out as
 * actions/download-artifact does, one directory per artifact, and run the comparison as a process.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createHash } from "node:crypto";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const script = "scripts/releases/archive-digests.ts";

const Target = Schema.Struct({
  platform: Schema.String,
  arch: Schema.String,
  archive: Schema.String,
  cliWorkers: Schema.Number,
});
type Target = typeof Target.Type;
const Matrix = Schema.fromJsonString(Schema.Struct({ include: Schema.Array(Target) }));

/** Run `node` with `args` and `env`, and return its exit code and combined output. */
const node = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(ChildProcess.make("node", args, { env, extendEnv: true }));
    // The runtime logs a failure to stdout, so the cases read both streams together.
    const [log, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { exitCode, log };
  }).pipe(Effect.scoped);

/** The metadata job's `matrix` and `cli_matrix` outputs for a build run started by `event`. */
const metadata = (event: "pull_request" | "workflow_dispatch") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-release-metadata-" });
    const output = path.join(directory, "output");
    yield* fs.writeFileString(output, "");
    const run = yield* node(["scripts/releases/workflow.ts"], {
      GITHUB_OUTPUT: output,
      GITHUB_EVENT_NAME: event,
      RELEASE_CHANNEL: "build",
    });
    expect(run.exitCode, run.log).toBe(0);
    const values = new Map(
      (yield* fs.readFileString(output))
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    const release = values.get("matrix")!;
    const cli = values.get("cli_matrix")!;
    return {
      release,
      cli,
      tested: (yield* Schema.decodeUnknownEffect(Matrix)(cli)).include,
      targets: (yield* Schema.decodeUnknownEffect(Matrix)(release)).include,
    };
  });

const name = (target: Target) => `${target.platform}-${target.arch}`;

/** Artifact directories by name, each holding files by name. */
type Layout = Record<string, Record<string, string>>;

/** The layout of a run whose `local` and `cli` jobs recorded `digest(target)` for every target. */
const layout = (tested: ReadonlyArray<Target>, digest: (target: Target) => string): Layout =>
  Object.fromEntries(
    tested.flatMap((target) => [
      [`archive-digest-local-${name(target)}`, { "local.txt": digest(target) }],
      [`archive-digest-cli-${name(target)}`, { "cli.txt": digest(target) }],
    ]),
  );

/** Compare `artifacts` laid out in a fresh directory against the given matrices. */
const compare = (artifacts: Layout, matrices: { readonly release: string; readonly cli: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-archive-digests-" });
    for (const [artifact, files] of Object.entries(artifacts)) {
      yield* fs.makeDirectory(path.join(directory, artifact));
      for (const [file, text] of Object.entries(files))
        yield* fs.writeFileString(path.join(directory, artifact, file), text);
    }
    return yield* node([script, "compare", directory], {
      RELEASE_MATRIX: matrices.release,
      CLI_MATRIX: matrices.cli,
    });
  }).pipe(Effect.scoped);

/** Record each target's archive with the script, as the release jobs do, and read the digest. */
const recorded = (tested: ReadonlyArray<Target>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-archives-" });
    const digests = new Map<string, string>();
    for (const target of tested) {
      const archive = path.join(directory, `${name(target)}.tgz`);
      const bytes = new TextEncoder().encode(`archive of ${name(target)}`);
      yield* fs.writeFile(archive, bytes);
      const file = path.join(directory, "digests", name(target), "local.txt");
      const run = yield* node([script, "record", archive, file]);
      expect(run.exitCode, run.log).toBe(0);
      const digest = yield* fs.readFileString(file);
      expect(digest).toBe(createHash("sha256").update(bytes).digest("hex"));
      digests.set(name(target), digest);
    }
    return (target: Target) => digests.get(name(target))!;
  });

const sha = (seed: string) => createHash("sha256").update(seed).digest("hex");

layer(NodeServices.layer)("release archive digests", (it) => {
  it.effect(
    "every tested archive matching its published archive passes, for pull requests and manual runs",
    () =>
      Effect.gen(function* () {
        for (const event of ["pull_request", "workflow_dispatch"] as const) {
          const matrices = yield* metadata(event);
          expect(matrices.tested.length, event).toBeGreaterThan(0);
          const digest = yield* recorded(matrices.tested);
          const run = yield* compare(layout(matrices.tested, digest), matrices);
          expect(run.exitCode, run.log).toBe(0);
          for (const target of matrices.tested)
            expect(run.log).toContain(
              `${name(target)}: tested ${digest(target)}, published ${digest(target)}`,
            );
          expect(run.log).toContain("Every tested archive is the archive the release publishes.");
        }
      }).pipe(Effect.scoped),
  );

  it.effect("a tested archive whose bytes differ from the published one fails", () =>
    Effect.gen(function* () {
      const matrices = yield* metadata("pull_request");
      const [first] = matrices.tested;
      const artifacts = layout(matrices.tested, (target) => sha(name(target)));
      artifacts[`archive-digest-cli-${name(first!)}`] = { "cli.txt": sha("other bytes") };
      const run = yield* compare(artifacts, matrices);
      expect(run.exitCode).toBe(1);
      expect(run.log).toContain(
        `${name(first!)}: the tested archive is not the published archive.`,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a missing digest fails, whichever job did not record it", () =>
    Effect.gen(function* () {
      const matrices = yield* metadata("pull_request");
      const [first, second] = matrices.tested;
      const complete = layout(matrices.tested, (target) => sha(name(target)));
      const without = (...names: ReadonlyArray<string>) =>
        Object.fromEntries(
          Object.entries(complete).filter(([artifact]) => !names.includes(artifact)),
        );
      const cases: ReadonlyArray<[string, Layout, ReadonlyArray<string>]> = [
        [
          "a cli digest",
          without(`archive-digest-cli-${name(first!)}`),
          [`Missing archive-digest-cli-${name(first!)}`],
        ],
        [
          "a local digest",
          without(`archive-digest-local-${name(second!)}`),
          [`Missing archive-digest-local-${name(second!)}`],
        ],
        [
          "both digests of one architecture",
          without(`archive-digest-cli-${name(second!)}`, `archive-digest-local-${name(second!)}`),
          [
            `Missing archive-digest-cli-${name(second!)}`,
            `Missing archive-digest-local-${name(second!)}`,
          ],
        ],
        [
          "every digest",
          {},
          matrices.tested.flatMap((target) => [
            `Missing archive-digest-local-${name(target)}`,
            `Missing archive-digest-cli-${name(target)}`,
          ]),
        ],
        [
          "the digest file in its artifact",
          { ...complete, [`archive-digest-local-${name(first!)}`]: {} },
          [`archive-digest-local-${name(first!)} must hold only local.txt; it holds nothing.`],
        ],
      ];
      const runs = yield* Effect.forEach(cases, ([, artifacts]) => compare(artifacts, matrices), {
        concurrency: "unbounded",
      });
      cases.forEach(([label, , messages], index) => {
        expect(runs[index]!.exitCode, label).toBe(1);
        for (const message of messages) expect(runs[index]!.log, label).toContain(message);
      });
    }).pipe(Effect.scoped),
  );

  it.effect("digest files that are not exactly one SHA-256 fail even when both sides match", () =>
    Effect.gen(function* () {
      const matrices = yield* metadata("pull_request");
      const [first] = matrices.tested;
      const digest = sha("archive");
      const contents: ReadonlyArray<[string, string]> = [
        ["empty files", ""],
        ["the same invalid text", "not a digest"],
        ["a digest listed twice", `${digest}\n${digest}`],
        ["a digest and a newline", `${digest}\n`],
        ["an uppercase digest", digest.toUpperCase()],
        ["a truncated digest", digest.slice(1)],
      ];
      const runs = yield* Effect.forEach(
        contents,
        ([, text]) =>
          compare(
            {
              ...layout(matrices.tested, (target) => sha(name(target))),
              [`archive-digest-local-${name(first!)}`]: { "local.txt": text },
              [`archive-digest-cli-${name(first!)}`]: { "cli.txt": text },
            },
            matrices,
          ),
        { concurrency: "unbounded" },
      );
      contents.forEach(([label], index) => {
        expect(runs[index]!.exitCode, label).toBe(1);
        for (const side of ["local", "cli"])
          expect(runs[index]!.log, label).toContain(
            `archive-digest-${side}-${name(first!)}/${side}.txt is not exactly one SHA-256 digest.`,
          );
      });
    }).pipe(Effect.scoped),
  );

  it.effect("an artifact or file the release does not test fails", () =>
    Effect.gen(function* () {
      const matrices = yield* metadata("workflow_dispatch");
      const [first] = matrices.tested;
      const untested = matrices.targets.find((target) => target.cliWorkers === 0)!;
      const complete = layout(matrices.tested, (target) => sha(name(target)));
      const cases: ReadonlyArray<[string, Layout, string]> = [
        [
          "a local digest of a target without a CLI suite",
          { ...complete, [`archive-digest-local-${name(untested)}`]: { "local.txt": sha("x") } },
          `Unexpected artifact archive-digest-local-${name(untested)}.`,
        ],
        [
          "a matching pair for a target without a CLI suite",
          {
            ...complete,
            [`archive-digest-local-${name(untested)}`]: { "local.txt": sha("x") },
            [`archive-digest-cli-${name(untested)}`]: { "cli.txt": sha("x") },
          },
          `Unexpected artifact archive-digest-cli-${name(untested)}.`,
        ],
        [
          "a pair for an architecture the release does not build",
          {
            ...complete,
            "archive-digest-local-linux-riscv64": { "local.txt": sha("x") },
            "archive-digest-cli-linux-riscv64": { "cli.txt": sha("x") },
          },
          "Unexpected artifact archive-digest-cli-linux-riscv64.",
        ],
        [
          "a second file beside a digest",
          {
            ...complete,
            [`archive-digest-cli-${name(first!)}`]: {
              "cli.txt": sha(name(first!)),
              "local.txt": sha(name(first!)),
            },
          },
          `archive-digest-cli-${name(first!)} must hold only cli.txt; it holds cli.txt, local.txt.`,
        ],
      ];
      const runs = yield* Effect.forEach(cases, ([, artifacts]) => compare(artifacts, matrices), {
        concurrency: "unbounded",
      });
      cases.forEach(([label, , message], index) => {
        expect(runs[index]!.exitCode, label).toBe(1);
        expect(runs[index]!.log, label).toContain(message);
      });
    }).pipe(Effect.scoped),
  );

  it.effect("a cli matrix that is not the release's tested targets fails", () =>
    Effect.gen(function* () {
      const matrices = yield* metadata("pull_request");
      const [first, ...rest] = matrices.tested;
      const untested = matrices.targets.find((target) => target.cliWorkers === 0)!;
      const artifacts = layout(matrices.tested, (target) => sha(name(target)));
      const cli = (include: ReadonlyArray<Target>) => JSON.stringify({ include });
      const cases: ReadonlyArray<[string, { release: string; cli: string }, string]> = [
        [
          "a tested target without a cli job",
          { release: matrices.release, cli: cli(rest) },
          `${name(first!)} runs the CLI suite but CLI_MATRIX has no job for it.`,
        ],
        [
          "a cli job for a target without a CLI suite",
          {
            release: matrices.release,
            cli: cli([...matrices.tested, { ...untested, cliWorkers: 4 }]),
          },
          `CLI_MATRIX tests ${name(untested)}, which no release target with a CLI suite builds.`,
        ],
        [
          "a cli job building another archive path",
          {
            release: matrices.release,
            cli: cli([{ ...first!, archive: `${first!.archive}.other` }, ...rest]),
          },
          `${name(first!)}'s cli job differs from its release target`,
        ],
        [
          "a target listed twice",
          { release: matrices.release, cli: cli([...matrices.tested, first!]) },
          `CLI_MATRIX lists ${name(first!)} more than once.`,
        ],
        [
          "no target with a CLI suite",
          {
            release: cli(matrices.targets.map((target) => ({ ...target, cliWorkers: 0 }))),
            cli: cli([]),
          },
          "No release target runs the installed CLI suite, so no archive is tested.",
        ],
        [
          "a cli matrix that is not JSON",
          { release: matrices.release, cli: "not a matrix" },
          "CLI_MATRIX is not a release matrix.",
        ],
      ];
      const runs = yield* Effect.forEach(cases, ([, given]) => compare(artifacts, given), {
        concurrency: "unbounded",
      });
      cases.forEach(([label, , message], index) => {
        expect(runs[index]!.exitCode, label).toBe(1);
        expect(runs[index]!.log, label).toContain(message);
      });
    }).pipe(Effect.scoped),
  );
});
