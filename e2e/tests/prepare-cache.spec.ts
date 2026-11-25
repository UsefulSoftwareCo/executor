import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const steps = [
  "apps:build",
  "collector:build",
  "viewer:build",
  "e2e:runtime",
  "e2e:apps",
  "hosted:self-host:web:build",
  "web:build",
  "e2e:npm",
] as const;

const uncached: ReadonlyArray<(typeof steps)[number]> = ["collector:build"];
const runs = (built: ReadonlyArray<string>) =>
  steps.filter((step) => built.includes(step) || uncached.includes(step));

const outputs: Record<(typeof steps)[number], string> = {
  "apps:build": "packages/apps/dist/index.js",
  "collector:build": "packages/telemetry/dist/collector/executor-collector",
  "viewer:build": "packages/telemetry/dist/viewer/index.html",
  "e2e:runtime": ".local/test-runtime/host.json",
  "e2e:apps": ".local/test-runtime/apps.tgz",
  "hosted:self-host:web:build": "apps/hosted/self-host/web/dist/index.html",
  "web:build": "apps/local/web/dist/index.html",
  "e2e:npm": ".local/test-runtime/npm/package.tgz",
};

const moreOutputs: Partial<Record<(typeof steps)[number], ReadonlyArray<string>>> = {
  "e2e:runtime": [".local/test-runtime/host.json.map"],
};

const build = `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [step, ...outputs] = process.argv.slice(2);
const state = process.env.FAKE_STATE;
if (process.env.FAKE_FAIL === step) process.exit(3);
if (process.env.FAKE_NOTE === step)
  appendFileSync(process.env.EXECUTOR_PREPARE_NOTES, "The shared store cannot be written (EACCES).\\n");
let ran = [];
try {
  ran = readFileSync(\`\${state}/ran\`, "utf8").split("\\n").filter(Boolean);
} catch {}
appendFileSync(\`\${state}/ran\`, \`\${step}\\n\`);
for (const output of outputs) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, \`\${step} build \${ran.length + 1}\\n\`);
}
`;

const workspace = (name: string, dependencies: ReadonlyArray<string> = []) =>
  JSON.stringify({
    name,
    dependencies: Object.fromEntries(dependencies.map((dependency) => [dependency, "workspace:*"])),
  });

const files: Record<string, string> = {
  "package.json": JSON.stringify({
    type: "module",
    workspaces: [
      "packages/*",
      "packages/telemetry/viewer",
      "apps/local/web",
      "apps/hosted/self-host/web",
    ],
    scripts: {
      "e2e:prepare": "node scripts/e2e-prepare.ts",
      ...Object.fromEntries(
        steps.map((step) => [
          step,
          ["node build.mjs", step, outputs[step], ...(moreOutputs[step] ?? [])].join(" "),
        ]),
      ),
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
  "packages/sdk/package.json": workspace("@fake/sdk", ["apps", "@fake/telemetry"]),
  "packages/sdk/index.ts": "export const sdk = 1;\n",
  "packages/ui/package.json": workspace("@fake/ui"),
  "packages/ui/index.ts": "export const ui = 1;\n",
  "packages/telemetry/package.json": workspace("@fake/telemetry"),
  "packages/telemetry/src/index.ts": "export const telemetry = 1;\n",
  "packages/telemetry/collector/Cargo.toml": "\n",
  "packages/telemetry/collector/src/main.rs": "\n",
  "packages/telemetry/scripts/build-collector.ts": "\n",
  "packages/telemetry/viewer/package.json": workspace("@fake/telemetry-viewer"),
  "packages/telemetry/viewer/index.ts": "\n",
  "playground/demo-apps/live-inbox/index.ts": "\n",
  "scripts/build-test-runtime.ts": "\n",
  "scripts/pack-test-apps.ts": "\n",
  "scripts/e2e-npm-packages.ts": "\n",
  "e2e/npm-packages.json": "{}\n",
  "apps/hosted/self-host/package.json": workspace("@fake/self-host"),
  "apps/hosted/self-host/web/package.json": workspace("@fake/self-host-web", ["@fake/ui"]),
  "apps/hosted/self-host/web/index.ts": "\n",
  "apps/local/web/package.json": workspace("@fake/local-web", ["@fake/sdk", "@fake/ui"]),
  "apps/local/web/index.ts": "\n",
  "e2e/README.md": "\n",
};

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
      yield* fs.remove(path.join(input.repo, outputs["apps:build"]));
      yield* fs.writeFileString(path.join(input.repo, outputs["web:build"]), "stale\n");
      yield* fs.writeFileString(path.join(input.repo, "apps/local/web/dist/extra.js"), "stale\n");
      const second = yield* prepare(input);
      expect(second.exitCode).toBe(0);
      expect(second.ran).toEqual(uncached);
      for (const step of steps)
        expect(second.stdout).toContain(`${step}: ${uncached.includes(step) ? "built" : "cached"}`);
      for (const step of steps.filter((step) => !uncached.includes(step)))
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
        ["packages/utils/index.ts", ["apps:build", "e2e:runtime", "e2e:apps", "web:build"]],
        ["packages/telemetry/src/index.ts", ["e2e:runtime", "web:build"]],
        ["packages/telemetry/collector/src/main.rs", ["collector:build"]],
        ["packages/telemetry/collector/README.md", ["collector:build"]],
        ["packages/telemetry/scripts/build-collector.ts", ["collector:build"]],
        ["packages/telemetry/viewer/index.ts", ["viewer:build"]],
        ["playground/demo-apps/live-inbox/index.ts", ["apps:build", "e2e:apps"]],
        ["apps/hosted/self-host/package.json", ["hosted:self-host:web:build"]],
        ["scripts/pack-test-apps.ts", ["e2e:apps"]],
        ["e2e/npm-packages.json", ["e2e:npm"]],
        ["packages/sdk/new.ts", ["e2e:runtime", "web:build"]],
        ["bun.lock", steps],
        ["e2e/README.md", []],
        ["packages/ui/dist/ignored.js", []],
      ];
      for (const [file, rebuilt] of changes) {
        yield* append(input, file);
        expect((yield* prepare(input)).ran, file).toEqual(runs(rebuilt));
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
      expect((yield* prepare(input)).ran).toEqual(
        runs(["hosted:self-host:web:build", "web:build"]),
      );
      yield* fs.writeFileString(file, original);
      const reverted = yield* prepare(input);
      expect(reverted.ran).toEqual(runs([]));
      expect(yield* read(input, outputs["web:build"])).toBe(
        `web:build build ${steps.indexOf("web:build") + 1}\n`,
      );
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

  it.effect("a skipped step neither runs nor touches its outputs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* repository;
      const before = yield* prepare(input, { args: ["--skip", "collector:build"] });
      expect(before.exitCode, before.stdout).toBe(0);
      expect(before.ran).toEqual(steps.filter((step) => step !== "collector:build"));
      expect(before.stdout).toContain("collector:build: skipped, provided elsewhere");
      const fetched = path.join(input.repo, outputs["collector:build"]);
      expect(yield* fs.exists(fetched), "nothing wrote the skipped step's output").toBe(false);
      yield* fs.makeDirectory(path.dirname(fetched), { recursive: true });
      yield* fs.writeFileString(fetched, "fetched\n");
      const after = yield* prepare(input, { args: ["--skip", "collector:build"] });
      expect(after.exitCode, after.stdout).toBe(0);
      expect(after.ran).not.toContain("collector:build");
      expect(yield* read(input, outputs["collector:build"])).toBe("fetched\n");
      const unknown = yield* prepare(input, { args: ["--skip", "collector"] });
      expect(unknown.exitCode).toBe(2);
      expect(unknown.ran).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("what a step notes is repeated in the summary", () =>
    Effect.gen(function* () {
      const input = yield* repository;
      const run = yield* prepare(input, { env: { FAKE_NOTE: "collector:build" } });
      expect(run.exitCode, run.stdout).toBe(0);
      expect(run.stdout).toMatch(
        /collector:build: built in [\d.]+s\n  collector:build: The shared store cannot be written \(EACCES\)\.\n/u,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a failing step stops the run and stores nothing for it", () =>
    Effect.gen(function* () {
      const input = yield* repository;
      const failed = yield* prepare(input, { env: { FAKE_FAIL: "e2e:runtime" } });
      expect(failed.exitCode).toBe(3);
      expect(failed.ran).toEqual(["apps:build", "collector:build", "viewer:build"]);
      const next = yield* prepare(input);
      expect(next.exitCode).toBe(0);
      expect(next.ran).toEqual(
        runs(["e2e:runtime", "e2e:apps", "hosted:self-host:web:build", "web:build", "e2e:npm"]),
      );
    }).pipe(Effect.scoped),
  );
});
