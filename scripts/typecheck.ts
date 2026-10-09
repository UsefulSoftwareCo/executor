/**
 * Typechecks the TypeScript projects concurrently. Each `tsc-rs` already checks a project on
 * several threads, so the script runs one project per four cores: two on a 4-core CI runner, at
 * most four.
 *
 * Every project runs to completion. Its output is printed in one block when it finishes, and the
 * script exits non-zero when any project fails. A signal stops every running project.
 * `e2e/tests/typecheck-runner.spec.ts` checks this.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { availableParallelism, constants } from "node:os";

type Step = {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
};
// `needs` runs first, in the project's slot. Root is first in the queue: it is the longest
// project, and only it imports the Cloud framework snapshot that `framework:build` writes.
type Project = { readonly path: string; readonly needs?: Step };

// The `framework:build` script, without `bun run` in between. The build only stops on SIGINT or
// SIGTERM once its compiler call returns, and killing a `bun` in front of it would leave it running.
const frameworkBuild: Step = {
  name: "framework:build",
  command: process.execPath,
  args: ["apps/hosted/cloud/scripts/build-framework.ts"],
};

const projects: ReadonlyArray<Project> = [
  { path: ".", needs: frameworkBuild },
  { path: "e2e" },
  { path: "apps/hosted/cloud/web" },
  { path: "apps/hosted/self-host/web" },
  { path: "apps/hosted/web" },
  { path: "apps/local/web" },
  { path: "apps/marketing" },
  { path: "scripts/releases" },
  { path: "apps/docs" },
];

const override = process.env.TYPECHECK_CONCURRENCY;
if (override !== undefined && !/^[1-9][0-9]*$/.test(override)) {
  console.error(
    `TYPECHECK_CONCURRENCY must be a positive integer, got ${JSON.stringify(override)}.`,
  );
  process.exit(1);
}
const concurrency =
  override === undefined
    ? Math.min(4, Math.max(2, Math.ceil(availableParallelism() / 4)))
    : Number(override);

type Result = { readonly name: string; readonly code: number };

// The steps stay in this process group, so a signal or kill sent to the group (Ctrl-C in a
// terminal, an agent harness's kill) reaches them directly. A signal sent only to this process,
// as `bun run` forwards it, is passed on to the steps. `tsc-rs` ignores SIGINT and SIGTERM, so a
// step that is still running a second later is killed.
const running = new Set<ChildProcess>();
let stoppedBy: NodeJS.Signals | undefined;
const killAll = (signal: NodeJS.Signals) => {
  for (const child of running) child.kill(signal);
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    stoppedBy ??= signal;
    killAll(signal);
    setTimeout(() => killAll("SIGKILL"), 1_000).unref();
  });
}
// An uncaught error or `process.exit` must not leave compilers running.
process.on("exit", () => killAll("SIGKILL"));

const run = (step: Step): Promise<Result> =>
  new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(step.command, [...step.args], { stdio: ["ignore", "pipe", "pipe"] });
    running.add(child);
    // Kept apart so a chunk on one stream cannot split a line on the other.
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    // A process that fails to start emits `error` and then `close` with a negative code.
    child.on("error", (error) => stderr.push(Buffer.from(`${error.message}\n`)));
    child.on("close", (exit, signal) => {
      running.delete(child);
      const code = exit === 0 ? 0 : 1;
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const status = code === 0 ? "ok" : `failed (${signal ?? `exit ${exit}`})`;
      process.stdout.write(`\n── ${step.name}: ${status} in ${seconds}s\n`);
      process.stdout.write(Buffer.concat(stdout));
      process.stdout.write(Buffer.concat(stderr));
      resolve({ name: step.name, code });
    });
  });

const typecheck = async (project: Project): Promise<Result> => {
  const name = `tsc-rs -p ${project.path}`;
  if (project.needs) {
    const before = await run(project.needs);
    if (before.code !== 0) return { name, code: before.code };
    if (stoppedBy) return { name, code: 1 };
  }
  return run({ name, command: "tsc-rs", args: ["--noEmit", "-p", project.path] });
};

const started = performance.now();
const queue = [...projects];
const results: Array<Result> = [];
await Promise.all(
  Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let project = queue.shift(); project && !stoppedBy; project = queue.shift()) {
      results.push(await typecheck(project));
    }
  }),
);

const failed = results.filter((result) => result.code !== 0);
const total = ((performance.now() - started) / 1000).toFixed(1);
console.log(
  `\nTypechecked ${results.length} of ${projects.length} projects in ${total}s, ${concurrency} at a time.` +
    (failed.length ? ` Failed: ${failed.map((result) => result.name).join(", ")}.` : "") +
    (stoppedBy ? ` Stopped by ${stoppedBy}.` : ""),
);
// No `process.exit`: it would drop stdout that a pipe has not drained yet.
process.exitCode = stoppedBy
  ? 128 + constants.signals[stoppedBy]
  : failed.length || results.length !== projects.length
    ? 1
    : 0;
