/**
 * The release workflow's `archives` job runs `scripts/releases/archive-digests.ts` before
 * `publish`, so that every archive a job tested is the archive the release publishes: the `checks`
 * job's and each part of the installed CLI suite's. These cases run the metadata job's
 * `scripts/releases/workflow.ts` for its matrices, record digests with the script as the jobs do,
 * lay them out as actions/download-artifact does, one directory per artifact, and run the
 * comparison as a process.
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
  packagedTests: Schema.optional(Schema.Boolean),
  part: Schema.optional(Schema.String),
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

/** The metadata job's release, checks and CLI matrices for a build run started by `event`. */
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
    const checks = values.get("checks_matrix")!;
    const cli = values.get("cli_matrix")!;
    const recovery = values.get("recovery_matrix")!;
    return {
      release,
      checks,
      cli,
      recovery,
      targets: (yield* Schema.decodeUnknownEffect(Matrix)(release)).include,
      parts: (yield* Schema.decodeUnknownEffect(Matrix)(cli)).include,
      recoveries: (yield* Schema.decodeUnknownEffect(Matrix)(recovery)).include,
    };
  });

const name = (target: Target) => `${target.platform}-${target.arch}`;
const local = (target: Target) => `archive-digest-local-${name(target)}`;
const checked = (target: Target) => `archive-digest-checks-${name(target)}`;
const part = (job: Target) => `archive-digest-cli-${job.part!.split("/")[0]}-${name(job)}`;
/** Linux and Windows recovery parts build the unpacked app; their digests must be local's. */
const unpacked = (target: Target) => target.platform !== "darwin";
/** A desktop app's digest, distinct from its archive's. */
const appDigest = (archive: string) => createHash("sha256").update(`app ${archive}`).digest("hex");
const localApp = (target: Target) => `app-digest-local-${name(target)}`;
const recoveryApp = (job: Target) => `app-digest-recovery-${job.part!.split("/")[0]}-${name(job)}`;

/** Artifact directories by name, each holding files by name. */
type Layout = Record<string, Record<string, string>>;

/** A run whose local, checks and cli jobs recorded `digest(target)` for each of their targets. */
const layout = (
  matrices: {
    readonly targets: ReadonlyArray<Target>;
    readonly parts: ReadonlyArray<Target>;
    readonly recoveries: ReadonlyArray<Target>;
  },
  digest: (target: Target) => string,
): Layout =>
  Object.fromEntries([
    ...matrices.targets.map((target) => [local(target), { "local.txt": digest(target) }]),
    ...matrices.targets.map((target) => [checked(target), { "checks.txt": digest(target) }]),
    ...matrices.parts.map((job) => [part(job), { "cli.txt": digest(job) }]),
    ...matrices.targets
      .filter((target) => target.packagedTests === true && unpacked(target))
      .map((target) => [localApp(target), { "local.txt": appDigest(digest(target)) }]),
    ...matrices.recoveries
      .filter(unpacked)
      .map((job) => [recoveryApp(job), { "recovery.txt": appDigest(digest(job)) }]),
  ]);

type Matrices = {
  readonly release: string;
  readonly checks: string;
  readonly cli: string;
  readonly recovery: string;
};

/** Compare `artifacts` laid out in a fresh directory against the given matrices. */
const compare = (artifacts: Layout, matrices: Matrices) =>
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
      CHECKS_MATRIX: matrices.checks,
      CLI_MATRIX: matrices.cli,
      RECOVERY_MATRIX: matrices.recovery,
    });
  }).pipe(Effect.scoped);

/** Record each target's archive with the script, as the release jobs do, and read the digest. */
const recorded = (targets: ReadonlyArray<Target>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-archives-" });
    const digests = new Map<string, string>();
    for (const target of targets) {
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

const json = (include: ReadonlyArray<Target>) => JSON.stringify({ include });

layer(NodeServices.layer)("release archive digests", (it) => {
  it.effect(
    "every tested archive matching its published archive passes, for pull requests and manual runs",
    () =>
      Effect.gen(function* () {
        for (const event of ["pull_request", "workflow_dispatch"] as const) {
          const matrices = yield* metadata(event);
          expect(matrices.parts.length, event).toBeGreaterThan(1);
          const digest = yield* recorded(matrices.targets);
          const run = yield* compare(layout(matrices, digest), matrices);
          expect(run.exitCode, run.log).toBe(0);
          for (const target of matrices.targets)
            expect(run.log).toContain(
              `${checked(target)}: tested ${digest(target)}, published ${digest(target)}`,
            );
          for (const job of matrices.parts)
            expect(run.log).toContain(
              `${part(job)}: tested ${digest(job)}, published ${digest(job)}`,
            );
          expect(run.log).toContain("Every tested archive is the archive the release publishes.");
        }
      }).pipe(Effect.scoped),
  );

  it.effect("a tested archive whose bytes differ from the published one fails", () =>
    Effect.gen(function* () {
      const matrices = yield* metadata("pull_request");
      const [first, second] = matrices.parts;
      const target = matrices.targets[0]!;
      const cases: ReadonlyArray<[string, string]> = [
        [part(second!), "cli.txt"],
        [checked(target), "checks.txt"],
      ];
      const runs = yield* Effect.forEach(
        cases,
        ([artifact, file]) =>
          compare(
            {
              ...layout(matrices, (job) => sha(name(job))),
              [artifact]: { [file]: sha("other bytes") },
            },
            matrices,
          ),
        { concurrency: "unbounded" },
      );
      cases.forEach(([artifact], index) => {
        expect(runs[index]!.exitCode, artifact).toBe(1);
        expect(runs[index]!.log, artifact).toContain(
          `${artifact}: the tested archive is not the published archive.`,
        );
      });
      expect(runs[0]!.log).not.toContain(`${part(first!)}: the tested archive`);
    }).pipe(Effect.scoped),
  );

  it.effect("a missing digest fails, whichever job did not record it", () =>
    Effect.gen(function* () {
      const matrices = yield* metadata("pull_request");
      const [first] = matrices.parts;
      const target = matrices.targets[1]!;
      const complete = layout(matrices, (job) => sha(name(job)));
      const without = (...names: ReadonlyArray<string>) =>
        Object.fromEntries(
          Object.entries(complete).filter(([artifact]) => !names.includes(artifact)),
        );
      const cases: ReadonlyArray<[string, Layout, ReadonlyArray<string>]> = [
        ["a part's digest", without(part(first!)), [`Missing ${part(first!)}`]],
        ["a checks digest", without(checked(target)), [`Missing ${checked(target)}`]],
        ["a local digest", without(local(target)), [`Missing ${local(target)}`]],
        [
          "every digest",
          {},
          [
            ...matrices.targets.map((job) => `Missing ${local(job)}`),
            ...matrices.targets.map((job) => `Missing ${checked(job)}`),
            ...matrices.parts.map((job) => `Missing ${part(job)}`),
          ],
        ],
        [
          "the digest file in its artifact",
          { ...complete, [local(target)]: {} },
          [`${local(target)} must hold only local.txt; it holds nothing.`],
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

  it.effect("digest files that are not exactly one SHA-256 fail even when every side matches", () =>
    Effect.gen(function* () {
      const matrices = yield* metadata("pull_request");
      const [first] = matrices.parts;
      const target = matrices.targets.find((candidate) => name(candidate) === name(first!))!;
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
              ...layout(matrices, (job) => sha(name(job))),
              [local(target)]: { "local.txt": text },
              [checked(target)]: { "checks.txt": text },
              [part(first!)]: { "cli.txt": text },
            },
            matrices,
          ),
        { concurrency: "unbounded" },
      );
      contents.forEach(([label], index) => {
        expect(runs[index]!.exitCode, label).toBe(1);
        for (const [artifact, file] of [
          [local(target), "local.txt"],
          [checked(target), "checks.txt"],
          [part(first!), "cli.txt"],
        ])
          expect(runs[index]!.log, label).toContain(
            `${artifact}/${file} is not exactly one SHA-256 digest.`,
          );
      });
    }).pipe(Effect.scoped),
  );

  it.effect("an artifact or file the release does not test fails", () =>
    Effect.gen(function* () {
      const matrices = yield* metadata("workflow_dispatch");
      const [first] = matrices.parts;
      const untested = matrices.targets.find((target) => target.cliWorkers === 0)!;
      const complete = layout(matrices, (job) => sha(name(job)));
      const cases: ReadonlyArray<[string, Layout, string]> = [
        [
          "a CLI suite digest of a target without a CLI suite",
          { ...complete, [`archive-digest-cli-1-${name(untested)}`]: { "cli.txt": sha("x") } },
          `Unexpected artifact archive-digest-cli-1-${name(untested)}.`,
        ],
        [
          "a part the CLI suite does not have",
          { ...complete, [`archive-digest-cli-9-${name(first!)}`]: { "cli.txt": sha("x") } },
          `Unexpected artifact archive-digest-cli-9-${name(first!)}.`,
        ],
        [
          "digests for an architecture the release does not build",
          {
            ...complete,
            "archive-digest-local-linux-riscv64": { "local.txt": sha("x") },
            "archive-digest-checks-linux-riscv64": { "checks.txt": sha("x") },
          },
          "Unexpected artifact archive-digest-checks-linux-riscv64.",
        ],
        [
          "a second file beside a digest",
          {
            ...complete,
            [part(first!)]: { "cli.txt": sha(name(first!)), "local.txt": sha(name(first!)) },
          },
          `${part(first!)} must hold only cli.txt; it holds cli.txt, local.txt.`,
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

  it.effect("matrices that do not test what the release builds fail", () =>
    Effect.gen(function* () {
      const matrices = yield* metadata("pull_request");
      const [first, ...rest] = matrices.parts;
      const tested = matrices.targets.find((target) => name(target) === name(first!))!;
      const untested = matrices.targets.find((target) => target.cliWorkers === 0)!;
      const artifacts = layout(matrices, (job) => sha(name(job)));
      const withCli = (include: ReadonlyArray<Target>) => ({ ...matrices, cli: json(include) });
      const cases: ReadonlyArray<[string, Matrices, string]> = [
        [
          "a tested target without a cli job",
          withCli(matrices.parts.filter((job) => name(job) !== name(first!))),
          `${name(first!)} runs the CLI suite but CLI_MATRIX has no job for it.`,
        ],
        [
          "a cli job for a target without a CLI suite",
          withCli([...matrices.parts, { ...untested, cliWorkers: 8, part: "1/1" }]),
          `CLI_MATRIX runs ${name(untested)} with 8 workers, and its release target says 0.`,
        ],
        [
          "a cli job building another archive path",
          withCli([{ ...first!, archive: `${first!.archive}.other` }, ...rest]),
          `CLI_MATRIX's ${name(first!)} job builds ${first!.archive}.other, and local publishes ${tested.archive}.`,
        ],
        [
          "a part listed twice",
          withCli([...matrices.parts, first!]),
          `CLI_MATRIX lists ${name(first!)} part ${first!.part} more than once.`,
        ],
        [
          "a release target without a checks job",
          {
            ...matrices,
            checks: json(matrices.targets.filter((target) => name(target) !== name(tested))),
          },
          `${name(tested)} has no checks job in CHECKS_MATRIX.`,
        ],
        [
          "no target with a CLI suite",
          {
            ...matrices,
            release: json(matrices.targets.map((target) => ({ ...target, cliWorkers: 0 }))),
            cli: json([]),
          },
          "No release target runs the installed CLI suite, so no archive is tested.",
        ],
        [
          "a cli matrix that is not JSON",
          { ...matrices, cli: "not a matrix" },
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

  it.effect(
    "a macOS archive is recorded by what was signed, and a different signed payload fails",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-payload-" });
        const archive = path.join(directory, "executor.tgz");
        yield* fs.writeFileString(archive, "signed archive bytes");
        const recorded = path.join(directory, "digests", "local.txt");
        const payload = sha("unsigned files");

        // record-payload copies the digest packaging wrote beside the archive before signing.
        yield* fs.writeFileString(path.join(directory, "payload.sha256"), payload);
        const run = yield* node([script, "record-payload", archive, recorded]);
        expect(run.exitCode, run.log).toBe(0);
        expect(yield* fs.readFileString(recorded)).toBe(payload);

        // A payload file that is not one SHA-256 is not recorded.
        yield* fs.writeFileString(path.join(directory, "payload.sha256"), `${payload}\n`);
        const malformed = yield* node([script, "record-payload", archive, recorded]);
        expect(malformed.exitCode).toBe(1);
        expect(malformed.log).toContain("payload.sha256 is not exactly one SHA-256 digest.");

        // The checks job's payload must be local's: one signed from other files fails.
        const matrices = yield* metadata("workflow_dispatch");
        const mac = matrices.targets.find((target) => target.platform === "darwin")!;
        const mismatch = yield* compare(
          {
            ...layout(matrices, (job) => sha(name(job))),
            [checked(mac)]: { "checks.txt": sha("other unsigned files") },
          },
          matrices,
        );
        expect(mismatch.exitCode).toBe(1);
        expect(mismatch.log).toContain(
          `${checked(mac)}: the tested archive is not the published archive.`,
        );
      }).pipe(Effect.scoped),
  );

  it.effect("a recovery part's desktop app that is not the app local packaged fails", () =>
    Effect.gen(function* () {
      const matrices = yield* metadata("workflow_dispatch");
      const job = matrices.recoveries.find(unpacked)!;
      const complete = layout(matrices, (target) => sha(name(target)));
      const runs = yield* Effect.forEach(
        [
          { ...complete, [recoveryApp(job)]: { "recovery.txt": sha("another app") } },
          Object.fromEntries(
            Object.entries(complete).filter(([artifact]) => artifact !== recoveryApp(job)),
          ),
        ],
        (artifacts) => compare(artifacts, matrices),
        { concurrency: "unbounded" },
      );
      expect(runs[0]!.exitCode).toBe(1);
      expect(runs[0]!.log).toContain(
        `${recoveryApp(job)}: the tested desktop app is not the app local packaged.`,
      );
      expect(runs[1]!.exitCode).toBe(1);
      expect(runs[1]!.log).toContain(`Missing ${recoveryApp(job)}`);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "an unpacked app's digest leaves out only the build id and the installer-only files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        /** Write an unpacked app and return its digest as record-app gives it. */
        const app = (files: Record<string, string>) =>
          Effect.gen(function* () {
            const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-app-" });
            for (const [relative, text] of Object.entries(files)) {
              yield* fs.makeDirectory(path.dirname(path.join(directory, relative)), {
                recursive: true,
              });
              yield* fs.writeFileString(path.join(directory, relative), text);
            }
            const file = path.join(directory, "..", `${path.basename(directory)}.txt`);
            const run = yield* node([script, "record-app", path.join(directory, "app"), file]);
            expect(run.exitCode, run.log).toBe(0);
            return yield* fs.readFileString(file);
          });
        const manifest = (build: string) => JSON.stringify({ version: "1.0.0", build });
        const base = {
          app: "executable",
          "resources/app.asar": "code",
          "resources/runtime/desktop-runtime.json": manifest("aaaaaaaaaaaa"),
        };
        const packaged = yield* app({
          ...base,
          "resources/runtime/desktop-runtime.json": manifest("bbbbbbbbbbbb"),
          "resources/apparmor-profile": "profile",
          "resources/package-type": "deb",
        });
        // A --dir build: another random build id, and no installer-only files.
        expect(yield* app(base)).toBe(packaged);
        // Any other difference counts, the manifest's version included.
        expect(yield* app({ ...base, "resources/app.asar": "other code" })).not.toBe(packaged);
        expect(
          yield* app({
            ...base,
            "resources/runtime/desktop-runtime.json": JSON.stringify({
              version: "2.0.0",
              build: "aaaaaaaaaaaa",
            }),
          }),
        ).not.toBe(packaged);
        expect(yield* app({ ...base, "resources/extra": "x" })).not.toBe(packaged);
      }).pipe(Effect.scoped),
  );

  it.effect("an app mismatch names the files that differ, from both jobs' file lists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const matrices = yield* metadata("workflow_dispatch");
      const job = matrices.recoveries.find(unpacked)!;
      const target = matrices.targets.find((candidate) => name(candidate) === name(job))!;
      const lists = yield* fs.makeTempDirectoryScoped({ prefix: "executor-app-files-" });
      const write = (artifact: string, lines: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.join(lists, artifact));
          yield* fs.writeFileString(path.join(lists, artifact, "files.txt"), lines.join("\n"));
        });
      yield* write(`app-files-local-${name(target)}`, [
        `app.exe ${sha("exe")}`,
        `resources/elevate.exe ${sha("elevate")}`,
        `resources/app.asar ${sha("asar")}`,
      ]);
      yield* write(recoveryApp(job).replace("app-digest-", "app-files-"), [
        `app.exe ${sha("another exe")}`,
        `resources/app.asar ${sha("asar")}`,
      ]);
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-archive-digests-" });
      const artifacts = {
        ...layout(matrices, (candidate) => sha(name(candidate))),
        [recoveryApp(job)]: { "recovery.txt": sha("another app") },
      };
      for (const [artifact, files] of Object.entries(artifacts)) {
        yield* fs.makeDirectory(path.join(directory, artifact));
        for (const [file, text] of Object.entries(files))
          yield* fs.writeFileString(path.join(directory, artifact, file), text);
      }
      const run = yield* node([script, "compare", directory], {
        RELEASE_MATRIX: matrices.release,
        CHECKS_MATRIX: matrices.checks,
        CLI_MATRIX: matrices.cli,
        RECOVERY_MATRIX: matrices.recovery,
        APP_FILES: lists,
      });
      expect(run.exitCode).toBe(1);
      expect(run.log).toContain(
        `${recoveryApp(job)}: the tested desktop app is not the app local packaged.`,
      );
      expect(run.log).toContain("app.exe: different bytes");
      expect(run.log).toContain("resources/elevate.exe: only in local's app");
      expect(run.log).not.toContain("resources/app.asar");
    }).pipe(Effect.scoped),
  );
});
