/**
 * `bun run e2e:prepare` runs `node scripts/e2e-prepare.ts`, which caches each build step's outputs
 * under a hash of its inputs. These cases copy the script into a temporary git repository with the
 * same layout and fake build scripts, and read which steps ran and what they left behind.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const steps = [
  "apps:build",
  "telemetry:build",
  "e2e:runtime",
  "e2e:apps",
  "hosted:self-host:web:build",
  "web:build",
] as const;

const outputs: Record<(typeof steps)[number], string> = {
  "apps:build": "packages/apps/dist/index.js",
  "telemetry:build": "packages/telemetry/dist/motel/index.js",
  "e2e:runtime": ".local/test-runtime/host.json",
  "e2e:apps": ".local/test-runtime/apps.tgz",
  "hosted:self-host:web:build": "apps/hosted/self-host/web/dist/index.html",
  "web:build": "apps/local/web/dist/index.html",
};

/**
 * Appends the step to `$FAKE_STATE/ran` and writes its output with a build number, so a restored
 * output shows which build made it. `FAKE_FAIL` names a step that exits 3 without output.
 */
const build = `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [step, output] = process.argv.slice(2);
const state = process.env.FAKE_STATE;
if (process.env.FAKE_FAIL === step) process.exit(3);
let ran = [];
try {
  ran = readFileSync(\`\${state}/ran\`, "utf8").split("\\n").filter(Boolean);
} catch {}
appendFileSync(\`\${state}/ran\`, \`\${step}\\n\`);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, \`\${step} build \${ran.length + 1}\\n\`);
`;

const workspace = (name: string, dependencies: ReadonlyArray<string> = []) =>
  JSON.stringify({
    name,
    dependencies: Object.fromEntries(dependencies.map((dependency) => [dependency, "workspace:*"])),
  });

/**
 * The layout the script reads: `@fake/utils` <- `apps` <- `@fake/sdk` <- local web, and
 * `@fake/ui` <- both dashboards.
 */
const files: Record<string, string> = {
  "package.json": JSON.stringify({
    type: "module",
    workspaces: ["packages/*", "apps/local/web", "apps/hosted/self-host/web"],
    scripts: {
      "e2e:prepare": "node scripts/e2e-prepare.ts",
      ...Object.fromEntries(steps.map((step) => [step, `node build.mjs ${step} ${outputs[step]}`])),
    },
  }),
  "bun.lock": "{}\n",
  "tsconfig.json": "{}\n",
  ".gitignore": "dist/\n.local/\n",
  "build.mjs": build,
  "patches/fake.patch": "\n",
  "packages/utils/package.json": workspace("@fake/utils"),
  "packages/utils/index.ts": "export const utils = 1;\n",
  "packages/apps/package.json": workspace("apps", ["@fake/utils"]),
  "packages/apps/index.ts": "export const apps = 1;\n",
  "packages/sdk/package.json": workspace("@fake/sdk", ["apps"]),
  "packages/sdk/index.ts": "export const sdk = 1;\n",
  "packages/ui/package.json": workspace("@fake/ui"),
  "packages/ui/index.ts": "export const ui = 1;\n",
  "packages/telemetry/package.json": workspace("@fake/telemetry"),
  "packages/telemetry/motel/source.json": "{}\n",
  "packages/telemetry/scripts/build-motel.ts": "\n",
  "playground/demo-apps/live-inbox/index.ts": "\n",
  "scripts/build-test-runtime.ts": "\n",
  "scripts/pack-test-apps.ts": "\n",
  "apps/hosted/self-host/package.json": workspace("@fake/self-host"),
  "apps/hosted/self-host/web/package.json": workspace("@fake/self-host-web", ["@fake/ui"]),
  "apps/hosted/self-host/web/index.ts": "\n",
  "apps/local/web/package.json": workspace("@fake/local-web", ["@fake/sdk", "@fake/ui"]),
  "apps/local/web/index.ts": "\n",
  "e2e/README.md": "\n",
};

/** A git repository with the script and the fakes, and an empty cache directory. */
const repository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const repo = yield* fs.makeTempDirectoryScoped({ prefix: "executor-prepare-repo-" });
  for (const [file, text] of Object.entries(files)) {
    yield* fs.makeDirectory(path.dirname(path.join(repo, file)), { recursive: true });
    yield* fs.writeFileString(path.join(repo, file), text);
  }
  yield* fs.makeDirectory(path.join(repo, "scripts"), { recursive: true });
  yield* fs.copyFile("scripts/e2e-prepare.ts", path.join(repo, "scripts/e2e-prepare.ts"));
  // Untracked files count as inputs, so the repository needs no commit.
  yield* processes.exitCode(ChildProcess.make("git", ["init", "--quiet"], { cwd: repo }));
  const cache = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "executor-prepare-" }), "c");
  return { repo, cache };
});

type Repository = Effect.Success<typeof repository>;

const prepare = (
  input: Repository,
  options: { readonly env?: Record<string, string>; readonly args?: ReadonlyArray<string> } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const state = yield* fs.makeTempDirectoryScoped({ prefix: "executor-prepare-state-" });
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["scripts/e2e-prepare.ts", ...(options.args ?? [])], {
        cwd: input.repo,
        // CI is set on the runners; an empty value leaves the cache on.
        env: { CI: "", EXECUTOR_E2E_CACHE: input.cache, FAKE_STATE: state, ...options.env },
        extendEnv: true,
      }),
    );
    const [stdout, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
        child.stderr.pipe(Stream.runDrain),
      ],
      { concurrency: "unbounded" },
    );
    const ran = yield* fs
      .readFileString(path.join(state, "ran"))
      .pipe(Effect.orElseSucceed(() => ""));
    return { stdout, exitCode, ran: ran.split("\n").filter(Boolean) };
  }).pipe(Effect.scoped);

const read = (input: Repository, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.join(input.repo, file));
  });

const append = (input: Repository, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(input.repo, file);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    const before = yield* fs.readFileString(target).pipe(Effect.orElseSucceed(() => ""));
    yield* fs.writeFileString(target, `${before}// changed\n`);
  });

layer(NodeServices.layer, { excludeTestServices: true })("Cached e2e:prepare", (it) => {
  it.effect("a second run restores every step without building", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* repository;
      const first = yield* prepare(input);
      expect(first.exitCode).toBe(0);
      expect(first.ran).toEqual(steps);
      for (const step of steps) expect(first.stdout).toContain(`${step}: built`);
      // Outputs from the build are removed or replaced by stale files, then restored.
      yield* fs.remove(path.join(input.repo, outputs["apps:build"]));
      yield* fs.writeFileString(path.join(input.repo, outputs["web:build"]), "stale\n");
      yield* fs.writeFileString(path.join(input.repo, "apps/local/web/dist/extra.js"), "stale\n");
      const second = yield* prepare(input);
      expect(second.exitCode).toBe(0);
      expect(second.ran).toEqual([]);
      for (const step of steps) expect(second.stdout).toContain(`${step}: cached`);
      for (const step of steps)
        expect(yield* read(input, outputs[step])).toBe(
          `${step} build ${steps.indexOf(step) + 1}\n`,
        );
      expect(yield* fs.exists(path.join(input.repo, "apps/local/web/dist/extra.js"))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("a change rebuilds the steps whose packages depend on it, and only those", () =>
    Effect.gen(function* () {
      const input = yield* repository;
      expect((yield* prepare(input)).ran).toEqual(steps);
      const changes: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
        ["packages/ui/index.ts", ["hosted:self-host:web:build", "web:build"]],
        // apps <- sdk <- local web; e2e:apps packs the apps build.
        ["packages/utils/index.ts", ["apps:build", "e2e:runtime", "e2e:apps", "web:build"]],
        ["packages/telemetry/motel/source.json", ["telemetry:build"]],
        ["playground/demo-apps/live-inbox/index.ts", ["apps:build", "e2e:apps"]],
        ["apps/hosted/self-host/package.json", ["hosted:self-host:web:build"]],
        ["scripts/pack-test-apps.ts", ["e2e:apps"]],
        // A new untracked file in a package is an input.
        ["packages/sdk/new.ts", ["e2e:runtime", "web:build"]],
        ["bun.lock", steps],
        ["e2e/README.md", []],
        // Ignored files are not inputs.
        ["packages/ui/dist/ignored.js", []],
      ];
      for (const [file, rebuilt] of changes) {
        yield* append(input, file);
        expect((yield* prepare(input)).ran, file).toEqual(rebuilt);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("reverting a change restores the earlier outputs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* repository;
      yield* prepare(input);
      const file = path.join(input.repo, "packages/ui/index.ts");
      const original = yield* fs.readFileString(file);
      yield* append(input, "packages/ui/index.ts");
      expect((yield* prepare(input)).ran).toEqual(["hosted:self-host:web:build", "web:build"]);
      yield* fs.writeFileString(file, original);
      const reverted = yield* prepare(input);
      expect(reverted.ran).toEqual([]);
      expect(yield* read(input, outputs["web:build"])).toBe("web:build build 6\n");
    }).pipe(Effect.scoped),
  );

  it.effect("CI and --no-cache build every step and leave the cache alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const input = yield* repository;
      for (const options of [{ env: { CI: "true" } }, { args: ["--no-cache"] }]) {
        const run = yield* prepare(input, options);
        expect(run.exitCode).toBe(0);
        expect(run.ran).toEqual(steps);
        expect(run.stdout).toContain("without the cache");
      }
      expect(yield* fs.exists(input.cache)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("a failing step stops the run and stores nothing for it", () =>
    Effect.gen(function* () {
      const input = yield* repository;
      const failed = yield* prepare(input, { env: { FAKE_FAIL: "e2e:runtime" } });
      expect(failed.exitCode).toBe(3);
      expect(failed.ran).toEqual(["apps:build", "telemetry:build"]);
      const next = yield* prepare(input);
      expect(next.exitCode).toBe(0);
      expect(next.ran).toEqual([
        "e2e:runtime",
        "e2e:apps",
        "hosted:self-host:web:build",
        "web:build",
      ]);
    }).pipe(Effect.scoped),
  );
});
