import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Step = {
  readonly name: string;
  readonly command: ReadonlyArray<string>;
  readonly packages: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
  readonly after: ReadonlyArray<string>;
  readonly outputs: ReadonlyArray<string>;
  readonly cached?: false;
};

const steps: ReadonlyArray<Step> = [
  {
    name: "apps:build",
    command: ["bun", "run", "apps:build"],
    packages: ["packages/apps"],
    files: ["playground/demo-apps/live-inbox"],
    after: [],
    outputs: ["packages/apps/dist"],
  },
  {
    name: "collector:build",
    command: ["bun", "run", "collector:build"],
    packages: [],
    files: ["packages/telemetry/collector", "packages/telemetry/scripts/build-collector.ts"],
    after: [],
    outputs: ["packages/telemetry/dist/collector"],
    cached: false,
  },
  {
    name: "viewer:build",
    command: ["bun", "run", "viewer:build"],
    packages: ["packages/telemetry/viewer"],
    files: [],
    after: [],
    outputs: ["packages/telemetry/dist/viewer"],
  },
  {
    name: "e2e:runtime",
    command: ["bun", "run", "e2e:runtime"],
    packages: ["packages/sdk"],
    files: ["scripts/build-test-runtime.ts"],
    after: [],
    outputs: [".local/test-runtime/host.json", ".local/test-runtime/host.json.map"],
  },
  {
    name: "e2e:apps",
    command: ["bun", "run", "e2e:apps"],
    packages: [],
    files: ["scripts/pack-test-apps.ts"],
    after: ["apps:build"],
    outputs: [".local/test-runtime/apps.tgz"],
  },
  {
    name: "hosted:self-host:web:build",
    command: ["bun", "run", "hosted:self-host:web:build"],
    packages: ["apps/hosted/self-host/web"],
    files: ["apps/hosted/self-host/package.json"],
    after: [],
    outputs: ["apps/hosted/self-host/web/dist"],
  },
  {
    name: "web:build",
    command: ["bun", "run", "web:build"],
    packages: ["apps/local/web"],
    files: [],
    after: [],
    outputs: ["apps/local/web/dist"],
  },
  {
    name: "e2e:npm",
    command: ["bun", "run", "e2e:npm"],
    packages: [],
    files: ["scripts/e2e-npm-packages.ts", "e2e/npm-packages.json", "packages/apps/package.json"],
    after: [],
    outputs: [".local/test-runtime/npm"],
  },
];

const notPackageSources = [
  "packages/telemetry/collector",
  "packages/telemetry/scripts/build-collector.ts",
];

const rootFiles = ["package.json", "bun.lock", "tsconfig.json", "patches", ".gitignore"];
const buildEnv =
  /^(NODE_ENV|VITE_.*|HOSTED_API_URL|EXECUTOR_DESKTOP_DEV|EXECUTOR_DASHBOARD_SOURCEMAP)$/;
process.env.EXECUTOR_DASHBOARD_SOURCEMAP = "hidden";
const keep = 20;

const useCache = !process.env.CI && !process.argv.includes("--no-cache");
const listOutputs = process.argv.includes("--outputs");
const skipped = new Set<string>();
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === "--no-cache" || arg === "--outputs") continue;
  if (arg !== "--skip") {
    console.error(`Unknown argument ${arg}. Options: --no-cache, --outputs, --skip <step>.`);
    process.exit(2);
  }
  const name = process.argv[++index] ?? "";
  if (!steps.some((step) => step.name === name)) {
    console.error(
      `--skip names no step: ${JSON.stringify(name)}. Steps: ${steps.map((step) => step.name).join(", ")}.`,
    );
    process.exit(2);
  }
  skipped.add(name);
}
if (listOutputs) {
  for (const step of steps)
    if (!skipped.has(step.name)) for (const output of step.outputs) console.log(output);
  process.exit(0);
}
const cacheRoot =
  process.env.EXECUTOR_E2E_CACHE ?? path.join(os.homedir(), ".cache", "executor-e2e-prepare");

type Manifest = {
  readonly name: string;
  readonly workspaces?: ReadonlyArray<string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
};
const readManifest = (directory: string): Manifest =>
  JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));

const workspaces = new Map<string, string>();
for (const entry of readManifest(".").workspaces ?? []) {
  const directories = entry.endsWith("/*")
    ? fs
        .readdirSync(entry.slice(0, -2), { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => path.join(entry.slice(0, -2), dirent.name))
    : [entry];
  for (const directory of directories)
    if (fs.existsSync(path.join(directory, "package.json")))
      workspaces.set(readManifest(directory).name, directory);
}

const closure = (directories: ReadonlyArray<string>) => {
  const seen = new Set<string>();
  const queue = [...directories];
  for (let directory = queue.shift(); directory !== undefined; directory = queue.shift()) {
    if (seen.has(directory)) continue;
    seen.add(directory);
    const manifest = readManifest(directory);
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    })) {
      const dependency = workspaces.get(name);
      if (dependency !== undefined) queue.push(dependency);
    }
  }
  return [...seen];
};

const fileHashes = new Map<string, string>();
const hashFile = (file: string) => {
  let hash = fileHashes.get(file);
  if (hash === undefined) {
    hash = fs.existsSync(file)
      ? createHash("sha256").update(fs.readFileSync(file)).digest("hex")
      : "deleted";
    fileHashes.set(file, hash);
  }
  return hash;
};

const gitFiles = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  paths.length === 0
    ? []
    : execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard", "--", ...paths], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      })
        .split("\0")
        .filter(Boolean);

const within = (file: string, directory: string) =>
  file === directory || file.startsWith(`${directory}/`);

const packageFiles = (found: string) => {
  const directory = found.split(path.sep).join("/");
  const left = [
    ...notPackageSources,
    ...[...workspaces.values()]
      .map((other) => other.split(path.sep).join("/"))
      .filter((other) => other !== directory && within(other, directory)),
  ];
  return gitFiles([directory]).filter((file) => !left.some((out) => within(file, out)));
};

const keys = new Map<string, string>();
const keyOf = (step: Step) => {
  const files = [
    ...new Set([
      ...gitFiles([...rootFiles, ...step.files]),
      ...closure(step.packages).flatMap(packageFiles),
    ]),
  ].sort();
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      step: step.name,
      command: step.command,
      outputs: step.outputs,
      after: step.after.map((name) => keys.get(name)),
      node: process.version,
      bun: execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
      platform: process.platform,
      arch: process.arch,
      env: Object.entries(process.env)
        .filter(([name]) => buildEnv.test(name))
        .sort(([a], [b]) => a.localeCompare(b)),
    }),
  );
  for (const file of files) hash.update(`${file}\0${hashFile(file)}\n`);
  return hash.digest("hex");
};

const copy = (from: string, to: string) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
};

const restore = (step: Step, entry: string) => {
  for (const output of step.outputs) {
    fs.rmSync(output, { recursive: true, force: true });
    copy(path.join(entry, output), output);
  }
};

const store = (step: Step, entry: string) => {
  const partial = `${entry}.${process.pid}.partial`;
  fs.rmSync(partial, { recursive: true, force: true });
  for (const output of step.outputs) copy(output, path.join(partial, output));
  try {
    fs.renameSync(partial, entry);
  } catch {
    fs.rmSync(partial, { recursive: true, force: true });
  }
  const directory = path.dirname(entry);
  const entries = fs
    .readdirSync(directory)
    .filter((name) => !name.endsWith(".partial"))
    .map((name) => ({ name, time: fs.statSync(path.join(directory, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  for (const old of entries.slice(keep))
    fs.rmSync(path.join(directory, old.name), { recursive: true, force: true });
};

const started = performance.now();
const summary: Array<string> = [];
for (const step of steps) {
  if (skipped.has(step.name)) {
    summary.push(`${step.name}: skipped, provided elsewhere`);
    continue;
  }
  const stepStarted = performance.now();
  const key = useCache && step.cached !== false ? keyOf(step) : undefined;
  if (key !== undefined) keys.set(step.name, key);
  const entry = key === undefined ? undefined : path.join(cacheRoot, step.name, key);
  if (entry !== undefined && fs.existsSync(entry)) {
    restore(step, entry);
    const now = new Date();
    fs.utimesSync(entry, now, now);
    summary.push(`${step.name}: cached`);
  } else {
    const [command, ...args] = step.command;
    const notes = path.join(
      os.tmpdir(),
      `executor-prepare-notes-${process.pid}-${step.name.replace(/\W/gu, "-")}`,
    );
    fs.rmSync(notes, { force: true });
    const run = spawnSync(command!, args, {
      stdio: "inherit",
      env: { ...process.env, EXECUTOR_PREPARE_NOTES: notes },
    });
    const noted = fs.existsSync(notes)
      ? fs.readFileSync(notes, "utf8").split("\n").filter(Boolean)
      : [];
    fs.rmSync(notes, { force: true });
    if (run.status !== 0) {
      console.error(`\n${step.name} failed (${run.signal ?? `exit ${run.status}`}).`);
      process.exit(run.status ?? 1);
    }
    if (entry !== undefined) store(step, entry);
    summary.push(
      `${step.name}: built in ${((performance.now() - stepStarted) / 1000).toFixed(1)}s`,
    );
    for (const line of new Set(noted)) summary.push(`  ${step.name}: ${line}`);
    continue;
  }
  summary[summary.length - 1] += ` in ${((performance.now() - stepStarted) / 1000).toFixed(1)}s`;
}
console.log(
  `\n${summary.join("\n")}\nPrepared in ${((performance.now() - started) / 1000).toFixed(1)}s` +
    (useCache ? `, cache ${cacheRoot}.` : ", without the cache."),
);
