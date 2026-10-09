/**
 * `bun run typecheck` runs `node scripts/typecheck.ts`, which runs the TypeScript projects
 * concurrently. These cases copy that entry point into a temporary directory with a fake
 * framework build, put a fake `tsc-rs` first on PATH, and run it through `bun run typecheck` or
 * `node` directly. They read its piped output, exit code and the processes it leaves behind.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const lines = 10_000;
const projects = 9;

/**
 * The fakes append what ran to `$FAKE_STATE/ran`. `FAKE_MODE` picks the behavior:
 * - `long`: `apps/docs`, last in the queue, sleeps, prints `lines` lines and exits 2;
 * - `mixed`: every step writes 500 numbered lines to each stream, with stdout lines split
 *   across two writes around a stderr line;
 * - `hang`: records its pid in `$FAKE_STATE/pids` and runs until killed, ignoring SIGINT and
 *   SIGTERM as the real compiler and framework build do.
 */
const tsc = `#!/bin/sh
echo "$*" >> "$FAKE_STATE/ran"
project=$(echo "$*" | sed 's/.* -p //')
case "$FAKE_MODE" in
  long)
    case "$project" in
      apps/docs) sleep 1; i=1; while [ $i -le ${lines} ]; do echo "diagnostic $i"; i=$((i+1)); done; exit 2 ;;
    esac ;;
  mixed)
    i=1
    while [ $i -le 500 ]; do
      printf 'OUT:%s:' "$project"; printf 'ERR:%s:%d\\n' "$project" $i >&2; printf '%d\\n' $i
      i=$((i+1))
    done ;;
  hang) trap '' INT TERM; echo $$ >> "$FAKE_STATE/pids"; exec sleep 60 ;;
esac
`;

const frameworkBuild = `import { appendFileSync } from "node:fs";

const state = process.env.FAKE_STATE;
appendFileSync(\`\${state}/ran\`, "framework:build\\n");
if (process.env.FAKE_MODE === "mixed") {
  for (let i = 1; i <= 500; i++) {
    process.stdout.write("OUT:framework-build:");
    process.stderr.write(\`ERR:framework-build:\${i}\\n\`);
    process.stdout.write(\`\${i}\\n\`);
  }
}
if (process.env.FAKE_MODE === "hang") {
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  appendFileSync(\`\${state}/pids\`, \`\${process.pid}\\n\`);
  setInterval(() => {}, 60_000);
}
`;

/** A directory with the repository's `typecheck` script and runner, and the fakes. */
const fakes = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bin = yield* fs.makeTempDirectoryScoped({ prefix: "executor-typecheck-bin-" });
  yield* fs.writeFileString(path.join(bin, "tsc-rs"), tsc);
  yield* fs.chmod(path.join(bin, "tsc-rs"), 0o755);
  const repo = yield* fs.makeTempDirectoryScoped({ prefix: "executor-typecheck-repo-" });
  const manifest: { readonly scripts: { readonly typecheck: string } } = JSON.parse(
    yield* fs.readFileString("package.json"),
  );
  yield* fs.writeFileString(
    path.join(repo, "package.json"),
    JSON.stringify({ type: "module", scripts: { typecheck: manifest.scripts.typecheck } }),
  );
  yield* fs.makeDirectory(path.join(repo, "scripts"));
  yield* fs.copyFile("scripts/typecheck.ts", path.join(repo, "scripts/typecheck.ts"));
  yield* fs.makeDirectory(path.join(repo, "apps/hosted/cloud/scripts"), { recursive: true });
  yield* fs.writeFileString(
    path.join(repo, "apps/hosted/cloud/scripts/build-framework.ts"),
    frameworkBuild,
  );
  return { bin, repo };
});

type Fakes = Effect.Success<typeof fakes>;

const typecheck = (input: {
  readonly fakes: Fakes;
  readonly mode: "long" | "mixed" | "hang";
  readonly concurrency: string | undefined;
  /** `bun run typecheck`, or the runner without `bun` in front of it. */
  readonly entry?: "bun" | "node";
  /** Runs once the process has started, with its pid and state directory. */
  readonly whileRunning?: (
    pid: number,
    state: string,
  ) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const state = yield* fs.makeTempDirectoryScoped({ prefix: "executor-typecheck-state-" });
    const env: Record<string, string> = {
      PATH: `${input.fakes.bin}:${process.env.PATH ?? ""}`,
      FAKE_MODE: input.mode,
      FAKE_STATE: state,
    };
    if (input.concurrency !== undefined) env.TYPECHECK_CONCURRENCY = input.concurrency;
    // The process leads its own process group, as a terminal job or an agent's command does.
    const child = yield* processes.spawn(
      input.entry === "node"
        ? ChildProcess.make("node", ["scripts/typecheck.ts"], {
            cwd: input.fakes.repo,
            env,
            extendEnv: true,
          })
        : ChildProcess.make("bun", ["run", "typecheck"], {
            cwd: input.fakes.repo,
            env,
            extendEnv: true,
          }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        // `undefined` when a signal killed the process.
        child.exitCode.pipe(Effect.orElseSucceed(() => undefined)),
        input.whileRunning ? input.whileRunning(child.pid, state) : Effect.void,
      ],
      { concurrency: "unbounded" },
    );
    const ran = yield* fs
      .readFileString(path.join(state, "ran"))
      .pipe(Effect.orElseSucceed(() => ""));
    return { stdout, stderr, exitCode, ran: ran.split("\n").filter(Boolean) };
  }).pipe(Effect.scoped);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Polls `done` every 50 ms for up to `seconds`, and returns whether it became true. */
const within = <R>(seconds: number, done: () => Effect.Effect<boolean, never, R>) =>
  Effect.gen(function* () {
    for (let tries = seconds * 20; tries > 0; tries--) {
      if (yield* done()) return true;
      yield* Effect.sleep("50 millis");
    }
    return yield* done();
  });

const signals = { SIGTERM: 15, SIGINT: 2, SIGHUP: 1 } as const;

/**
 * Starts a hanging typecheck at concurrency 4, waits until framework:build and three projects
 * run, stops it with `stop`, and checks that none of those four processes is left.
 */
const stopped = (input: {
  readonly entry: "bun" | "node";
  readonly stop: (pid: number) => Effect.Effect<void>;
  /** The signal the runner reports, or none when it is killed. */
  readonly reports: keyof typeof signals | undefined;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pids: Array<number> = [];
    // Processes this case started are killed even when an assertion fails.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
      }),
    );
    const run = yield* typecheck({
      fakes: yield* fakes,
      mode: "hang",
      concurrency: "4",
      entry: input.entry,
      whileRunning: (pid, state) =>
        Effect.gen(function* () {
          const recorded = () =>
            fs.readFileString(path.join(state, "pids")).pipe(
              Effect.map((text) => text.split(/\s+/).filter(Boolean).map(Number)),
              Effect.orElseSucceed(() => []),
            );
          const started = yield* within(10, () =>
            recorded().pipe(Effect.map((found) => found.length === 4)),
          );
          pids.push(...(yield* recorded()));
          expect(started).toBe(true);
          yield* input.stop(pid);
        }),
    });
    expect(run.ran).toHaveLength(4);
    if (input.reports) {
      expect(run.exitCode).toBe(128 + signals[input.reports]);
      expect(run.stdout).toContain(`Typechecked 4 of ${projects} projects`);
      expect(run.stdout).toContain(`Stopped by ${input.reports}.`);
    }
    // Killed processes are reaped by init after their parents exit.
    const gone = yield* within(5, () => Effect.succeed(!pids.some(alive)));
    expect(pids.filter(alive)).toEqual([]);
    expect(gone).toBe(true);
  }).pipe(Effect.scoped);

const signal = (pid: number, name: NodeJS.Signals) => Effect.sync(() => process.kill(pid, name));

// Live clock: the signal cases poll for the fake processes.
layer(NodeServices.layer, { excludeTestServices: true })("Parallel typecheck runner", (it) => {
  it.effect("an invalid TYPECHECK_CONCURRENCY fails before any project runs", () =>
    Effect.gen(function* () {
      const files = yield* fakes;
      const values = ["", "0", "-1", "0.5", "1.5", "2x", "abc", "1e1", " 2"];
      const runs = yield* Effect.forEach(
        values,
        (concurrency) => typecheck({ fakes: files, mode: "long", concurrency }),
        { concurrency: "unbounded" },
      );
      for (const [index, run] of runs.entries()) {
        const label = JSON.stringify(values[index]);
        expect(run.exitCode, label).toBe(1);
        expect(run.stderr, label).toContain("TYPECHECK_CONCURRENCY must be a positive integer");
        expect(run.ran, label).toEqual([]);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("every line of a long failing project and the summary reach a pipe", () =>
    Effect.gen(function* () {
      const files = yield* fakes;
      const values = [undefined, "1", "2", "9", "20"];
      const runs = yield* Effect.forEach(
        values,
        (concurrency) => typecheck({ fakes: files, mode: "long", concurrency }),
        { concurrency: "unbounded" },
      );
      for (const [index, run] of runs.entries()) {
        const label = `TYPECHECK_CONCURRENCY=${values[index] ?? "(unset)"}`;
        const diagnostics = run.stdout.split("\n").filter((line) => line.startsWith("diagnostic "));
        expect(run.exitCode, label).toBe(1);
        expect(run.ran, label).toHaveLength(projects + 1);
        expect(diagnostics, label).toHaveLength(lines);
        expect(diagnostics.at(-1), label).toBe(`diagnostic ${lines}`);
        expect(run.stdout, label).toMatch(/^── tsc-rs -p apps\/docs: failed \(exit 2\) in /m);
        expect(run.stdout, label).toMatch(
          new RegExp(
            `^Typechecked ${projects} of ${projects} projects .* Failed: tsc-rs -p apps/docs\\.$`,
            "m",
          ),
        );
      }
    }).pipe(Effect.scoped),
  );

  it.effect("output on stdout and stderr keeps every line whole", () =>
    Effect.gen(function* () {
      const run = yield* typecheck({ fakes: yield* fakes, mode: "mixed", concurrency: "4" });
      expect(run.exitCode).toBe(0);
      const output = run.stdout
        .split("\n")
        .filter((line) => line.startsWith("OUT:") || line.startsWith("ERR:"));
      const broken = output.filter((line) => !/^(OUT|ERR):[\w./-]+:\d+$/.test(line));
      expect(broken).toEqual([]);
      // The nine projects and framework:build.
      expect(new Set(output).size).toBe((projects + 1) * 2 * 500);
    }).pipe(Effect.scoped),
  );

  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    it.effect(`${name} to the runner alone stops every project`, () =>
      stopped({ entry: "node", stop: (pid) => signal(pid, name), reports: name }),
    );
    it.effect(`${name} to \`bun run typecheck\` alone stops every project`, () =>
      stopped({ entry: "bun", stop: (pid) => signal(pid, name), reports: name }),
    );
  }

  it.effect("Ctrl-C in a terminal, SIGINT to the process group, stops every project", () =>
    stopped({ entry: "bun", stop: (pid) => signal(-pid, "SIGINT"), reports: "SIGINT" }),
  );

  it.effect("an agent's stop, SIGTERM then SIGKILL 50 ms later to the group, leaves nothing", () =>
    stopped({
      entry: "bun",
      stop: (pid) =>
        signal(-pid, "SIGTERM").pipe(
          Effect.andThen(Effect.sleep("50 millis")),
          Effect.andThen(signal(-pid, "SIGKILL")),
        ),
      reports: undefined,
    }),
  );

  it.effect("SIGKILL to the process group leaves nothing", () =>
    stopped({ entry: "bun", stop: (pid) => signal(-pid, "SIGKILL"), reports: undefined }),
  );
});
