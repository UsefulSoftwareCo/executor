import { spawn, type ChildProcess } from "node:child_process";
import { availableParallelism, constants } from "node:os";

type Step = {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
};
type Project = { readonly path: string; readonly needs?: Step };

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

const warningsMode = process.env.TYPECHECK_WARNINGS;
if (warningsMode !== undefined && warningsMode !== "all" && warningsMode !== "summary") {
  console.error(
    `TYPECHECK_WARNINGS must be "all" or "summary", got ${JSON.stringify(warningsMode)}.`,
  );
  process.exit(1);
}
const allWarnings = warningsMode === "all" || process.argv.slice(2).includes("--all-warnings");

type Result = { readonly name: string; readonly code: number };

const diagnosticStart = /^(?:(.+?)\(\d+,\d+\): )?(error|warning) TS(\d+): /;
type Warning = { readonly rule: string; readonly file: string };
const warnings: Array<Warning> = [];

const splitWarnings = (text: string) => {
  const kept: Array<string> = [];
  const found: Array<Warning> = [];
  let errors = 0;
  let current: { readonly file: string; readonly code: string; lines: Array<string> } | undefined;
  const finish = () => {
    if (current === undefined) return;
    const rule = /effect\((\w+)\)\s*$/.exec(current.lines.join("\n"))?.[1];
    found.push({ rule: rule ?? `TS${current.code}`, file: current.file });
    current = undefined;
  };
  for (const line of text.split("\n")) {
    const start = diagnosticStart.exec(line);
    if (start) {
      finish();
      if (start[2] === "warning") {
        current = { file: start[1] ?? "(project options)", code: start[3] ?? "", lines: [line] };
        continue;
      }
      errors++;
    } else if (current && line !== "") {
      current.lines.push(line);
      continue;
    } else {
      finish();
    }
    kept.push(line);
  }
  finish();
  return { kept: kept.join("\n"), warnings: found, errors };
};

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
process.on("exit", () => killAll("SIGKILL"));

const run = (step: Step): Promise<Result> =>
  new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(step.command, [...step.args], { stdio: ["ignore", "pipe", "pipe"] });
    running.add(child);
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => stderr.push(Buffer.from(`${error.message}\n`)));
    child.on("close", (exit, signal) => {
      running.delete(child);
      const code = exit === 0 ? 0 : 1;
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const status = code === 0 ? "ok" : `failed (${signal ?? `exit ${exit}`})`;
      const streams = [Buffer.concat(stdout).toString(), Buffer.concat(stderr).toString()];
      const split = streams.map(splitWarnings);
      const hidden = split.flatMap((stream) => stream.warnings);
      const summarize =
        !allWarnings &&
        hidden.length > 0 &&
        (code === 0 || split.some((stream) => stream.errors > 0));
      const counted = summarize ? `, ${hidden.length} warnings counted at the end` : "";
      process.stdout.write(`\n── ${step.name}: ${status} in ${seconds}s${counted}\n`);
      if (summarize) warnings.push(...hidden);
      for (const [index, stream] of split.entries())
        process.stdout.write(summarize ? stream.kept : streams[index]);
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

const largestFirst = <T>(items: ReadonlyArray<T>, key: (item: T) => string) => {
  const groups = new Map<string, Array<T>>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return [...groups].sort((a, b) => b[1].length - a[1].length);
};

if (warnings.length > 0) {
  const rules = largestFirst(warnings, (warning) => warning.rule);
  const width = Math.max(...rules.map(([rule]) => rule.length));
  console.log(
    `\n${warnings.length} warnings by rule, with the files that have the most. ` +
      "`--all-warnings` or TYPECHECK_WARNINGS=all prints each one.",
  );
  for (const [rule, found] of rules) {
    const files = largestFirst(found, (warning) => warning.file);
    const top = files.slice(0, 3).map(([file, inFile]) => `${file} ${inFile.length}`);
    if (files.length > 3) top.push(`${files.length - 3} more files`);
    console.log(`${String(found.length).padStart(6)}  ${rule.padEnd(width)}  ${top.join(", ")}`);
  }
}

const failed = results.filter((result) => result.code !== 0);
const total = ((performance.now() - started) / 1000).toFixed(1);
console.log(
  `\nTypechecked ${results.length} of ${projects.length} projects in ${total}s, ${concurrency} at a time.` +
    (failed.length ? ` Failed: ${failed.map((result) => result.name).join(", ")}.` : "") +
    (stoppedBy ? ` Stopped by ${stoppedBy}.` : ""),
);
process.exitCode = stoppedBy
  ? 128 + constants.signals[stoppedBy]
  : failed.length || results.length !== projects.length
    ? 1
    : 0;
