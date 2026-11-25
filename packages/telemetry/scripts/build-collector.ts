import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

class CollectorBuildError extends Error {
  readonly _tag = "CollectorBuildError";
}

const fail = (message: string): never => {
  throw new CollectorBuildError(message);
};

type Os = "linux" | "darwin" | "win32";
type Arch = "x64" | "arm64";

type Target = {
  readonly name: string;
  readonly triple: string;
  readonly os: Os;
  readonly arch: Arch;
  readonly macosMinimum: string | undefined;
};

const targets: ReadonlyArray<Target> = [
  {
    name: "linux-x64",
    triple: "x86_64-unknown-linux-gnu",
    os: "linux",
    arch: "x64",
    macosMinimum: undefined,
  },
  {
    name: "linux-arm64",
    triple: "aarch64-unknown-linux-gnu",
    os: "linux",
    arch: "arm64",
    macosMinimum: undefined,
  },
  {
    name: "darwin-arm64",
    triple: "aarch64-apple-darwin",
    os: "darwin",
    arch: "arm64",
    macosMinimum: "11.0",
  },
  {
    name: "darwin-x64",
    triple: "x86_64-apple-darwin",
    os: "darwin",
    arch: "x64",
    macosMinimum: "10.15",
  },
  {
    name: "win32-x64",
    triple: "x86_64-pc-windows-msvc",
    os: "win32",
    arch: "x64",
    macosMinimum: undefined,
  },
];

const glibcCeiling = [2, 35] as const;
const linuxLibraries =
  /^(libc\.so\.6|libm\.so\.6|libgcc_s\.so\.1|ld-linux-(x86-64|aarch64)\.so\.[12])$/u;
const windowsRuntime = /^(vcruntime.*|msvcp.*|ucrtbase.*|api-ms-win-crt-.*)\.dll$/iu;
const maxBytes = 15 * 1024 * 1024;
const noticeFile = /^(licen[sc]e|notice|copying|copyright|third.party)([._-]|$)/iu;
const primaryLicence = (name: string) =>
  /^(un)?licen[sc]e([._-]|$)|^copying([._-]|$)/iu.test(name) && !/third.party|notice/iu.test(name);

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "../../..");
const crate = path.join(root, "packages/telemetry/collector");
const output = path.join(root, "packages/telemetry/dist/collector");

const cacheRoot = (): string => {
  const set = process.env.EXECUTOR_COLLECTOR_CACHE;
  if (set !== undefined && set !== "") {
    if (!path.isAbsolute(set))
      return fail(`EXECUTOR_COLLECTOR_CACHE must be an absolute path, not ${JSON.stringify(set)}.`);
    return path.resolve(set);
  }
  const xdg = process.env.XDG_CACHE_HOME;
  const base =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches")
      : process.platform === "win32"
        ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"))
        : xdg !== undefined && path.isAbsolute(xdg)
          ? xdg
          : path.join(os.homedir(), ".cache");
  return path.join(base, "executor-collector");
};
const targetDirectory = (): string =>
  path.join(cacheRoot(), "target", createHash("sha256").update(crate).digest("hex").slice(0, 16));
const targetBytes = 3 * 1024 * 1024 * 1024;
const targetDays = 14;
const storeEntries = 32;
const storeDays = 30;
const inUseMs = 60 * 60 * 1000;
const storeEnabled = () => process.env.CI === undefined || process.env.CI === "";

const executableName = (target: Target) =>
  target.os === "win32" ? "executor-collector.exe" : "executor-collector";

const keptVariables: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "CARGO_HOME",
  "CARGO_BUILD_JOBS",
  "RUSTUP_HOME",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
]);

const fetchVariables: ReadonlySet<string> = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "CARGO_HTTP_PROXY",
  "CARGO_HTTP_CAINFO",
  "SSL_CERT_FILE",
]);
const fetchEnv = (): NodeJS.ProcessEnv =>
  toolEnv(
    Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          fetchVariables.has(entry[0].toUpperCase()) && entry[1] !== undefined,
      ),
    ),
  );

const pinnedToolchain = (): string =>
  fs
    .readFileSync(path.join(crate, "rust-toolchain.toml"), "utf8")
    .match(/^channel\s*=\s*"([^"]+)"\s*$/mu)?.[1] ??
  fail("Cannot read the channel from packages/telemetry/collector/rust-toolchain.toml");

const toolEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env))
    if (keptVariables.has(name.toUpperCase())) env[name] = value;
  return {
    ...env,
    CARGO_HOME: cargoHome(),
    RUSTUP_TOOLCHAIN: pinnedToolchain(),
    RUSTUP_AUTO_INSTALL: "0",
    ...extra,
  };
};

type Run = {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly failure: string;
};

const runResult = (command: string, args: ReadonlyArray<string>, options: Run) => {
  const result: SpawnSyncReturns<string> = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? toolEnv({}),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined)
    return fail(`${options.failure}: cannot run ${command}: ${result.error.message}`);
  return result;
};

const capture = (command: string, args: ReadonlyArray<string>, options: Run): string => {
  const result = runResult(command, args, options);
  if (result.status !== 0)
    return fail(
      `${options.failure}: ${command} ${args.join(" ")} exited ${result.status ?? result.signal}\n${result.stderr}${result.stdout}`,
    );
  return result.stdout;
};

const stream = (command: string, args: ReadonlyArray<string>, options: Run): void => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? toolEnv({}),
    stdio: ["ignore", 2, 2],
  });
  if (result.error !== undefined)
    return fail(`${options.failure}: cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0)
    return fail(
      `${options.failure}: ${command} ${args.join(" ")} exited ${result.status ?? result.signal}`,
    );
};

const cargoHome = (): string => {
  const set = process.env.CARGO_HOME;
  const home = set === undefined || set === "" ? path.join(os.homedir(), ".cargo") : set;
  if (!path.isAbsolute(home))
    return fail(
      `CARGO_HOME must be an absolute path, not ${JSON.stringify(set)}: each tool would resolve it from the directory it runs in.`,
    );
  return path.resolve(home);
};

const installCommand = (target: Target) => {
  const toolchain = pinnedToolchain();
  const host = target.name === hostTarget();
  return `rustup toolchain install ${toolchain} --profile minimal${host ? "" : ` && rustup target add --toolchain ${toolchain} ${target.triple}`}`;
};

const requireRustup = (target: Target) => {
  const result = spawnSync("rustup", ["--version"], { encoding: "utf8", env: toolEnv({}) });
  if (result.error !== undefined || result.status !== 0)
    fail(
      process.platform === "win32"
        ? `rustup is not installed. Install it from https://rustup.rs, then run: ${installCommand(target)}`
        : `rustup is not installed. Install it with the toolchain this crate pins: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain ${pinnedToolchain()}`,
    );
};

const requireToolchain = (target: Target) => {
  requireRustup(target);
  const toolchain = pinnedToolchain();
  const listed = (args: ReadonlyArray<string>) =>
    capture("rustup", args, { cwd: crate, failure: "Cannot list rustup's toolchains" })
      .split("\n")
      .map((line) => line.trim().split(/\s/u)[0] ?? "");
  const installed =
    listed(["toolchain", "list"]).some((name) => name.startsWith(`${toolchain}-`)) &&
    listed(["target", "list", "--installed", "--toolchain", toolchain]).includes(target.triple);
  if (!installed)
    fail(
      `The Rust toolchain this crate pins (${toolchain}, for ${target.triple}) is not installed. Install it with: ${installCommand(target)}`,
    );
};

const toolchainReady = (target: Target, install: boolean) =>
  install ? installToolchain(target) : requireToolchain(target);

const installToolchain = (target: Target) => {
  requireRustup(target);
  const toolchain = pinnedToolchain();
  stream(
    "rustup",
    ["toolchain", "install", toolchain, "--profile", "minimal", "--no-self-update"],
    {
      cwd: crate,
      failure: "Cannot install the pinned Rust toolchain from static.rust-lang.org",
    },
  );
  stream("rustup", ["target", "add", "--toolchain", toolchain, target.triple], {
    cwd: crate,
    failure: `Cannot install the ${target.triple} standard library from static.rust-lang.org`,
  });
};

const sysroot = () =>
  capture("rustc", ["--print", "sysroot"], {
    cwd: crate,
    failure: "Cannot find the Rust toolchain",
  }).trim();

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const hostTools = (target: Target): Record<string, string> => {
  const output = (command: string, args: ReadonlyArray<string>, anyStatus = false) => {
    const result = runResult(command, args, {
      cwd: crate,
      failure: "Cannot identify the build's tools",
    });
    const printed = `${result.stdout}${result.stderr}`.trim();
    if ((result.status !== 0 && !anyStatus) || printed === "")
      return fail(`Cannot identify the build's tools: ${command} ${args.join(" ")} failed`);
    return printed;
  };
  const rust = { rustc: output("rustc", ["-vV"]), cargo: output("cargo", ["-vV"]) };
  switch (target.os) {
    case "linux":
      return {
        ...rust,
        cc: output("cc", ["--version"]),
        ld: output("ld", ["--version"]),
        libc: output("ldd", ["--version"]).split("\n")[0] ?? "",
      };
    case "darwin":
      return {
        ...rust,
        cc: output("cc", ["--version"]),
        ld: output("ld", ["-v"], true),
        sdk: `${output("xcrun", ["--show-sdk-version"])} ${output("xcrun", ["--show-sdk-build-version"])}`,
      };
    case "win32": {
      const programFiles = process.env["ProgramFiles(x86)"] ?? fail("ProgramFiles(x86) is not set");
      const install = output(
        path.join(programFiles, "Microsoft Visual Studio/Installer/vswhere.exe"),
        [
          "-latest",
          "-products",
          "*",
          "-requires",
          "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
          "-property",
          "installationPath",
        ],
      );
      if (install === "") return fail("No Visual Studio with the C++ x64 tools is installed");
      const versionFile = path.join(
        install,
        "VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt",
      );
      const kits = path.join(programFiles, "Windows Kits/10/Lib");
      return {
        ...rust,
        msvc: fs.readFileSync(versionFile, "utf8").trim(),
        sdk: fs.existsSync(kits) ? fs.readdirSync(kits).sort().join(" ") : "none",
      };
    }
  }
};

const cargoConfigFiles = (): ReadonlyArray<string> => {
  const directories: string[] = [];
  for (let directory = crate; ; directory = path.dirname(directory)) {
    directories.push(path.join(directory, ".cargo"));
    if (path.dirname(directory) === directory) break;
  }
  directories.push(cargoHome());
  return [
    ...new Set(
      directories.flatMap((directory) =>
        ["config.toml", "config"]
          .map((name) => path.join(directory, name))
          .filter((file) => present(file) && regularFile(file)),
      ),
    ),
  ];
};

const present = (file: string): boolean => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

const regularFile = (file: string): true => {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return fail(
      `${file} is a link to nothing; remove it, since anything at a Cargo config path that is not a regular file is refused.`,
    );
  }
  if (!stat.isFile())
    return fail(
      `${file} is not a regular file; remove it, since anything at a Cargo config path that is not a regular file is refused.`,
    );
  return true;
};

const uncacheable = "uncacheable: a Cargo config file was in effect";

const editorLeftover = (name: string) =>
  name === ".DS_Store" ||
  name.startsWith(".#") ||
  (name.length > 2 && name.startsWith("#") && name.endsWith("#")) ||
  name.endsWith("~") ||
  /^\..+\.sw[po]$/u.test(name);

const crateFiles = (): ReadonlyArray<string> => {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (directory === crate && entry.name === "target") continue;
      if (entry.isDirectory()) walk(absolute);
      else if (editorLeftover(entry.name)) continue;
      else if (entry.isFile()) files.push(absolute);
      else if (entry.isSymbolicLink() && linked(absolute) !== "other") files.push(absolute);
      else
        fail(
          `${absolute} is neither a file, a directory nor a link to a file, so the build's identity cannot cover it; remove it from the crate.`,
        );
    }
  };
  walk(crate);
  return files.map((file) => path.relative(root, file).split(path.sep).join("/")).sort();
};

const linked = (link: string): "file" | "nothing" | "other" => {
  const stat = fs.statSync(link, { throwIfNoEntry: false });
  return stat === undefined ? "nothing" : stat.isFile() ? "file" : "other";
};

const identity = (target: Target): string => {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      target: target.triple,
      host: `${process.platform}-${process.arch}`,
      tools: hostTools(target),
      recipe: sha256(fs.readFileSync(script)),
    }),
  );
  for (const file of crateFiles()) {
    const absolute = path.join(root, file);
    const isLink = fs.lstatSync(absolute).isSymbolicLink();
    const link = isLink ? fs.readlinkSync(absolute) : "";
    const contents =
      isLink && linked(absolute) === "nothing" ? "nothing" : sha256(fs.readFileSync(absolute));
    hash.update(`${file}\0${link}\0${contents}\n`);
  }
  return hash.digest("hex");
};

const buildPaths = (): ReadonlyArray<string> => [
  cargoHome(),
  sysroot(),
  crate,
  root,
  targetDirectory(),
];

const rustFlags = (target: Target): string =>
  [
    `--remap-path-prefix=${cargoHome()}=/cargo`,
    `--remap-path-prefix=${sysroot()}=/rust`,
    `--remap-path-prefix=${crate}=/executor-collector`,
    ...(target.os === "win32" ? ["-Ctarget-feature=+crt-static"] : []),
  ].join("\u001f");

const buildEnv = (target: Target) =>
  toolEnv({
    CARGO_ENCODED_RUSTFLAGS: rustFlags(target),
    ...(target.macosMinimum === undefined ? {} : { MACOSX_DEPLOYMENT_TARGET: target.macosMinimum }),
  });

const vanished = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ||
  (error as NodeJS.ErrnoException).code === "ENOTDIR";

const directoryBytes = (directory: string): number => {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (vanished(error)) return 0;
    throw error;
  }
  let bytes = 0;
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += directoryBytes(absolute);
    else if (entry.isFile())
      try {
        bytes += fs.statSync(absolute).size;
      } catch (error) {
        if (!vanished(error)) throw error;
      }
  }
  return bytes;
};

const lastUsed = (entry: string): number => {
  const marker = path.join(entry, "last-used");
  try {
    return (fs.existsSync(marker) ? fs.statSync(marker) : fs.statSync(entry)).mtimeMs;
  } catch {
    return Number.NaN;
  }
};
const markUsed = (entry: string) => {
  fs.mkdirSync(entry, { recursive: true });
  const marker = path.join(entry, "last-used");
  const now = new Date();
  if (fs.existsSync(marker)) fs.utimesSync(marker, now, now);
  else fs.writeFileSync(marker, "");
};

const partialPath = (to: string) =>
  `${to}.partial-${process.pid}-${createHash("sha256").update(`${Date.now()}${Math.random()}`).digest("hex").slice(0, 8)}`;
const partialName = /\.partial-(\d+)-[0-9a-f]+$/u;

const abandoned = (entry: string, now: number): boolean => {
  const pid = Number(partialName.exec(entry)?.[1]);
  return !running(pid) || !(now - lastUsed(entry) <= inUseMs);
};

const prune = (
  directory: string,
  days: number,
  keep: string,
  within: (entries: ReadonlyArray<string>) => boolean,
) => {
  if (!fs.existsSync(directory)) return;
  const now = Date.now();
  const stale = (entry: string, ms: number) => {
    const used = lastUsed(entry);
    return Number.isNaN(used) || now - used > ms;
  };
  const remove = (entry: string) => fs.rmSync(entry, { recursive: true, force: true });
  let entries = fs
    .readdirSync(directory)
    .map((name) => path.join(directory, name))
    .map((entry) => ({ entry, used: lastUsed(entry) }))
    .sort((a, b) => a.used - b.used);
  for (const { entry } of entries) {
    if (entry === keep) continue;
    if (partialName.test(entry) ? abandoned(entry, now) : stale(entry, days * 24 * 60 * 60 * 1000))
      remove(entry);
  }
  entries = entries.filter(({ entry }) => fs.existsSync(entry));
  while (!within(entries.map(({ entry }) => entry))) {
    const oldest = entries.find(
      ({ entry }) => entry !== keep && !partialName.test(entry) && stale(entry, inUseMs),
    );
    if (oldest === undefined) return;
    remove(oldest.entry);
    entries = entries.filter(({ entry }) => entry !== oldest.entry);
  }
};

const replaceWithCopy = (from: string, to: string) => {
  const partial = partialPath(to);
  try {
    fs.cpSync(from, partial, { recursive: true, dereference: true, verbatimSymlinks: false });
    fs.rmSync(path.join(partial, "last-used"), { force: true });
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(partial, to);
  } finally {
    fs.rmSync(partial, { recursive: true, force: true });
  }
};

const storeEntry = (target: Target, key: string) =>
  path.join(cacheRoot(), "store", target.name, key);

const digestFile = "executable.sha256";
const executableDigest = (file: string) => {
  const bytes = fs.readFileSync(file);
  return `${sha256(bytes)} ${bytes.length}`;
};

const intact = (directory: string, target: Target, key: string): boolean => {
  const read = (name: string) => {
    try {
      return fs.readFileSync(path.join(directory, name), "utf8").trim();
    } catch {
      return undefined;
    }
  };
  if (read("identity") !== key) return false;
  const recorded = read(digestFile);
  const executable = path.join(directory, executableName(target));
  return (
    recorded !== undefined && fs.existsSync(executable) && executableDigest(executable) === recorded
  );
};

const storeBuild = (target: Target, key: string) => {
  const entry = storeEntry(target, key);
  if (!fs.existsSync(entry)) {
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    const partial = partialPath(entry);
    try {
      fs.cpSync(output, partial, { recursive: true, dereference: true });
      fs.renameSync(partial, entry);
    } catch (error) {
      if (!fs.existsSync(entry)) throw error;
    } finally {
      fs.rmSync(partial, { recursive: true, force: true });
    }
  }
  markUsed(entry);
};

const lockWaitMs = 20 * 60 * 1000;
const lockPollMs = 250;
const startToleranceMs = 5_000;
const startedAt = Math.round(Date.now() - process.uptime() * 1000);

const lockFile = (target: Target, key: string) =>
  path.join(cacheRoot(), "locks", target.name, `${key}.lock`);

type Holder = { readonly pid: number; readonly started: number; readonly token: string };

const readHolder = (file: string): Holder | undefined => {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      isRecord(value) &&
      typeof value.pid === "number" &&
      typeof value.started === "number" &&
      typeof value.token === "string"
    )
      return { pid: value.pid, started: value.started, token: value.token };
  } catch {}
  return undefined;
};

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const processStarted = (pid: number): number | undefined => {
  if (process.platform === "win32") return undefined;
  const result = spawnSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" });
  const elapsed = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/u.exec(result.stdout?.trim() ?? "");
  if (result.status !== 0 || elapsed === null) return undefined;
  const [days, hours, minutes, seconds] = elapsed.slice(1).map((part) => Number(part ?? 0));
  return Date.now() - (((days! * 24 + hours!) * 60 + minutes!) * 60 + seconds!) * 1000;
};

const staleness = (file: string, holder: Holder | undefined): string | undefined => {
  if (holder === undefined) return "it does not name a builder";
  if (!running(holder.pid)) return `its builder, process ${holder.pid}, has exited`;
  const age = Date.now() - lastUsed(file);
  if (age > inUseMs) return `it was taken ${Math.round(age / 60_000)} minutes ago`;
  const started = processStarted(holder.pid);
  if (started !== undefined && Math.abs(started - holder.started) > startToleranceMs)
    return `process ${holder.pid} is another process now, started after the lock was taken`;
  return undefined;
};

type Lock =
  | { readonly kind: "taken"; readonly release: () => void }
  | { readonly kind: "held"; readonly file: string; readonly holder: Holder | undefined }
  | { readonly kind: "unavailable"; readonly reason: string };

const takeLock = (target: Target, key: string): Lock => {
  const file = lockFile(target, key);
  const holder: Holder = {
    pid: process.pid,
    started: startedAt,
    token: createHash("sha256").update(`${Date.now()}${Math.random()}`).digest("hex").slice(0, 16),
  };
  const written = partialPath(file);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(written, JSON.stringify(holder));
    try {
      fs.linkSync(written, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return { kind: "held", file, holder: readHolder(file) };
    }
  } catch (error) {
    return { kind: "unavailable", reason: String(error) };
  } finally {
    fs.rmSync(written, { force: true });
  }
  return {
    kind: "taken",
    release: () => {
      if (readHolder(file)?.token === holder.token) fs.rmSync(file, { force: true });
    },
  };
};

const breakLock = (file: string, stale: Holder | undefined) => {
  const aside = partialPath(file);
  try {
    fs.renameSync(file, aside);
  } catch (error) {
    if (vanished(error)) return;
    throw error;
  }
  const moved = readHolder(aside);
  if (moved !== undefined && moved.token !== stale?.token) {
    try {
      fs.linkSync(aside, file);
    } catch {}
  }
  fs.rmSync(aside, { force: true });
};

const pruneLocks = (target: Target) => {
  const directory = path.dirname(lockFile(target, "x"));
  if (!fs.existsSync(directory)) return;
  const now = Date.now();
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    if (partialName.test(name)) {
      if (abandoned(file, now)) fs.rmSync(file, { force: true });
    } else {
      const holder = readHolder(file);
      if (holder !== undefined && staleness(file, holder) !== undefined) breakLock(file, holder);
    }
  }
};

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const copyFromStore = (target: Target, key: string): boolean => {
  const entry = storeEntry(target, key);
  if (!fs.existsSync(entry)) return false;
  try {
    markUsed(entry);
  } catch (error) {
    console.error(`Cannot mark ${entry} used (${String(error)}); copying it all the same.`);
  }
  if (!intact(entry, target, key)) {
    fs.rmSync(entry, { recursive: true, force: true });
    console.log(`Removed the damaged stored build ${entry}; building instead.`);
    return false;
  }
  const executable = path.join(output, executableName(target));
  replaceWithCopy(entry, output);
  if (target.os !== "win32") fs.chmodSync(executable, 0o755);
  if (!intact(output, target, key))
    fail(`The copy of ${entry} in ${output} does not match it; build again.`);
  console.log(`executor-collector for ${target.name} copied from ${entry} (${key}).`);
  return true;
};

const compile = (target: Target, key: string | undefined) => {
  const targetDir = targetDirectory();
  const executable = path.join(output, executableName(target));
  markUsed(targetDir);
  stream("cargo", ["fetch", "--locked", "--target", target.triple], {
    cwd: crate,
    env: fetchEnv(),
    failure: "Cannot download the crate's dependencies from crates.io",
  });
  stream(
    "cargo",
    [
      "build",
      ...(verbose ? ["-vv"] : []),
      "--release",
      "--locked",
      "--offline",
      "--target",
      target.triple,
      "--target-dir",
      targetDir,
    ],
    {
      cwd: crate,
      env: verbose ? { ...buildEnv(target), RUST_BACKTRACE: "1" } : buildEnv(target),
      failure: verbose
        ? "cargo build failed"
        : `cargo build failed. For every command cargo ran and the compiler's backtrace, run the build again with --verbose (node packages/telemetry/scripts/build-collector.ts --target ${target.name} --verbose build); a RUST_BACKTRACE or RUST_LOG you set does not reach the compiler`,
    },
  );
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  fs.copyFileSync(
    path.join(targetDir, target.triple, "release", executableName(target)),
    executable,
  );
  if (target.os !== "win32") fs.chmodSync(executable, 0o755);
  fs.writeFileSync(path.join(output, digestFile), `${executableDigest(executable)}\n`);
  notices(target);
  fs.writeFileSync(path.join(output, "identity"), `${key ?? uncacheable}\n`);
  console.log(`Built executor-collector for ${target.name} at ${output} (${key ?? uncacheable}).`);
};

const afterBuild = (what: string, work: () => void) => {
  try {
    work();
  } catch (error) {
    console.error(`${what} failed; the build stands: ${String(error)}`);
  }
};
const unwritableNote = (target: Target) =>
  path.join(cacheRoot(), "locks", target.name, "store-unwritable");

const prepareNote = (line: string) => {
  const file = process.env.EXECUTOR_PREPARE_NOTES;
  if (file === undefined || file === "") return;
  try {
    fs.appendFileSync(file, `${line}\n`);
  } catch {}
};

const storeBroken = (target: Target, reason: string) => {
  const store = path.join(cacheRoot(), "store", target.name);
  const line = `The shared collector store ${store} cannot be written (${reason}). This build stands, but it is not stored: every workspace compiles its own until the store can be written again.`;
  console.error(`\n*** ${line}\n`);
  prepareNote(line);
  const note = unwritableNote(target);
  try {
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(note, `${reason}\n`);
  } catch (error) {
    console.error(
      `Cannot leave the note ${note} either (${String(error)}): builds of one identity that start together wait for one another until the store can be written.`,
    );
  }
};

const storeRepaired = (target: Target) => {
  try {
    fs.rmSync(unwritableNote(target), { force: true });
  } catch {}
};

const storeUnwritable = (target: Target): string | undefined => {
  try {
    const note = unwritableNote(target);
    if (Date.now() - fs.statSync(note).mtimeMs > inUseMs) return undefined;
    return fs.readFileSync(note, "utf8").trim();
  } catch {
    return undefined;
  }
};

const probeStore = (target: Target): string | undefined => {
  const directory = path.join(cacheRoot(), "store", target.name);
  const probe = partialPath(path.join(directory, "probe"));
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(probe, "");
    return undefined;
  } catch (error) {
    return String(error);
  } finally {
    try {
      fs.rmSync(probe, { force: true });
    } catch {}
  }
};

const storeAfterBuild = (target: Target, key: string) => {
  try {
    storeBuild(target, key);
  } catch (error) {
    storeBroken(target, String(error));
    return;
  }
  storeRepaired(target);
  const entry = storeEntry(target, key);
  afterBuild(`Pruning ${path.dirname(entry)}`, () =>
    prune(path.dirname(entry), storeDays, entry, (entries) => entries.length <= storeEntries),
  );
};
const pruneTargets = () => {
  const targetDir = targetDirectory();
  afterBuild(`Pruning ${path.dirname(targetDir)}`, () =>
    prune(path.dirname(targetDir), targetDays, targetDir, (entries) => {
      let bytes = 0;
      for (const entry of entries) bytes += directoryBytes(entry);
      return bytes <= targetBytes;
    }),
  );
};

const build = (target: Target, install: boolean) => {
  toolchainReady(target, install);
  const configs = cargoConfigFiles();
  if (configs.length > 0)
    console.log(
      `Cargo config in effect (${configs.join(", ")}): building without the up-to-date check, and writing an identity no cache matches.`,
    );
  const key = configs.length === 0 ? identity(target) : undefined;
  if (key !== undefined && intact(output, target, key)) {
    console.log(`executor-collector for ${target.name} is up to date (${key}).`);
    return;
  }
  if (key !== undefined && storeEnabled()) {
    const deadline = Date.now() + lockWaitMs;
    let waitingFor: string | undefined;
    for (;;) {
      if (copyFromStore(target, key)) return;
      const lock = takeLock(target, key);
      if (lock.kind === "taken") {
        let held = true;
        try {
          if (copyFromStore(target, key)) return;
          const probed = probeStore(target);
          const noted = probed === undefined ? storeUnwritable(target) : undefined;
          if (probed === undefined && noted === undefined) {
            compile(target, key);
            storeAfterBuild(target, key);
          } else {
            if (probed !== undefined) storeBroken(target, probed);
            else
              console.error(
                `The shared store was found unwritable less than an hour ago (${noted}; noted in ${unwritableNote(target)}): building without holding the lock, then trying to store.`,
              );
            lock.release();
            held = false;
            compile(target, key);
            if (probed === undefined) storeAfterBuild(target, key);
          }
        } finally {
          if (held) lock.release();
        }
        pruneTargets();
        afterBuild("Removing stale locks", () => pruneLocks(target));
        return;
      }
      if (lock.kind === "unavailable") {
        console.error(
          `Cannot take the lock for ${key} (${lock.reason}); building without waiting for other builds.`,
        );
        break;
      }
      if (lock.holder === undefined && !fs.existsSync(lock.file)) continue;
      const stale = staleness(lock.file, lock.holder);
      if (stale !== undefined) {
        console.log(`Taking over the build of ${key}: the lock ${lock.file} is stale, ${stale}.`);
        breakLock(lock.file, lock.holder);
        continue;
      }
      const holder = `process ${lock.holder?.pid}`;
      const unwritable = storeUnwritable(target);
      if (unwritable !== undefined) {
        console.error(
          `The shared store cannot be written (${unwritable}; noted in ${unwritableNote(target)}): building here without waiting for ${holder}.`,
        );
        break;
      }
      if (Date.now() > deadline) {
        console.error(
          `Waited ${lockWaitMs / 60_000} minutes for ${holder} to build ${key} (lock ${lock.file}); building here instead.`,
        );
        break;
      }
      if (waitingFor !== holder) {
        waitingFor = holder;
        console.log(
          `Waiting for ${holder}, which is building executor-collector for ${target.name} (${key}; lock ${lock.file}), for up to ${lockWaitMs / 60_000} minutes.`,
        );
      }
      sleep(lockPollMs);
    }
  }
  compile(target, key);
  if (key !== undefined && storeEnabled()) storeAfterBuild(target, key);
  pruneTargets();
};

type CargoPackage = {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly directory: string;
  readonly licenseFile: string | undefined;
  readonly procMacro: boolean;
};

type CargoGraph = {
  readonly root: string;
  readonly packages: ReadonlyMap<string, CargoPackage>;
  readonly linked: ReadonlyMap<string, ReadonlyArray<string>>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const field = (value: Record<string, unknown>, name: string, where: string): unknown =>
  name in value ? value[name] : fail(`cargo metadata: ${where} has no ${name}`);

const text = (value: unknown, where: string): string =>
  typeof value === "string" ? value : fail(`cargo metadata: ${where} is not a string`);

const list = (value: unknown, where: string): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : fail(`cargo metadata: ${where} is not a list`);

const record = (value: unknown, where: string): Record<string, unknown> =>
  isRecord(value) ? value : fail(`cargo metadata: ${where} is not an object`);

const parseCargoGraph = (json: string): CargoGraph => {
  const metadata = record(JSON.parse(json), "the output");
  const packages = new Map<string, CargoPackage>();
  for (const entry of list(field(metadata, "packages", "the output"), "packages")) {
    const pkg = record(entry, "a package");
    const id = text(field(pkg, "id", "a package"), "a package id");
    const licenseFile = field(pkg, "license_file", id);
    packages.set(id, {
      id,
      name: text(field(pkg, "name", id), `${id} name`),
      version: text(field(pkg, "version", id), `${id} version`),
      directory: path.dirname(text(field(pkg, "manifest_path", id), `${id} manifest_path`)),
      licenseFile: licenseFile === null ? undefined : text(licenseFile, `${id} license_file`),
      procMacro: list(field(pkg, "targets", id), `${id} targets`).some((entry) =>
        list(field(record(entry, `${id} target`), "kind", id), `${id} target kind`).includes(
          "proc-macro",
        ),
      ),
    });
  }
  const resolve = record(field(metadata, "resolve", "the output"), "resolve");
  const linked = new Map<string, ReadonlyArray<string>>();
  for (const entry of list(field(resolve, "nodes", "resolve"), "resolve nodes")) {
    const node = record(entry, "a resolve node");
    const id = text(field(node, "id", "a resolve node"), "a resolve node id");
    linked.set(
      id,
      list(field(node, "deps", id), `${id} deps`).flatMap((dependency) => {
        const dep = record(dependency, `a dependency of ${id}`);
        const kinds = list(field(dep, "dep_kinds", id), `${id} dep_kinds`).map((kind) =>
          field(record(kind, `${id} dep_kind`), "kind", id),
        );
        return kinds.includes(null) ? [text(field(dep, "pkg", id), `${id} dep pkg`)] : [];
      }),
    );
  }
  return {
    root: text(field(resolve, "root", "resolve"), "resolve root"),
    packages,
    linked,
  };
};

const linkedPackages = (target: Target): ReadonlyArray<CargoPackage> => {
  const graph = parseCargoGraph(
    capture(
      "cargo",
      [
        "metadata",
        "--locked",
        "--offline",
        "--format-version",
        "1",
        "--filter-platform",
        target.triple,
      ],
      { cwd: crate, env: toolEnv({}), failure: "Cannot read the crate's dependency graph" },
    ),
  );
  const seen = new Set<string>();
  const pending = [graph.root];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (seen.has(id)) continue;
    const pkg = graph.packages.get(id) ?? fail(`cargo metadata: ${id} is not a listed package`);
    if (pkg.procMacro) continue;
    seen.add(id);
    pending.push(
      ...(graph.linked.get(id) ?? fail(`cargo metadata: ${id} is not in the resolve graph`)),
    );
  }
  seen.delete(graph.root);
  return [...seen]
    .map((id) => graph.packages.get(id) ?? fail(`cargo metadata: ${id} is not a listed package`))
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
};

const notices = (target: Target) => {
  const licenses = path.join(output, "licenses");
  fs.rmSync(licenses, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  fs.copyFileSync(path.join(crate, "NOTICE"), path.join(output, "NOTICE"));
  const packages = linkedPackages(target);
  for (const pkg of packages) {
    const listed = fs.readdirSync(pkg.directory);
    const licences = [
      ...(pkg.licenseFile === undefined ? [] : [path.resolve(pkg.directory, pkg.licenseFile)]),
      ...listed.filter(primaryLicence).map((name) => path.join(pkg.directory, name)),
    ];
    if (licences.length === 0)
      fail(
        `${pkg.name}@${pkg.version} has no licence file to ship with the collector (it has ${listed.filter((name) => noticeFile.test(name)).join(", ") || "no licence or notice file"})`,
      );
    const files = new Set([
      ...licences,
      ...listed
        .filter((name) => noticeFile.test(name))
        .map((name) => path.join(pkg.directory, name)),
    ]);
    const destination = path.join(licenses, "cargo", `${pkg.name}@${pkg.version}`);
    fs.mkdirSync(destination, { recursive: true });
    for (const file of files) fs.copyFileSync(file, path.join(destination, path.basename(file)));
  }
  const library = path.join(sysroot(), "share/doc/rust/COPYRIGHT-library.html");
  if (!fs.existsSync(library)) fail(`The Rust toolchain has no ${library}`);
  fs.mkdirSync(path.join(licenses, "rust"), { recursive: true });
  fs.copyFileSync(library, path.join(licenses, "rust/COPYRIGHT-library.html"));
  fs.writeFileSync(
    path.join(output, "cargo-packages.txt"),
    packages.map((pkg) => `${pkg.name}@${pkg.version}\n`).join(""),
  );
};

const peImports = (
  bytes: Buffer,
): { readonly machine: number; readonly imports: ReadonlyArray<string> } => {
  if (bytes.readUInt16LE(0) !== 0x5a4d) return fail("The Windows executable has no MZ header");
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.readUInt32LE(pe) !== 0x4550) return fail("The Windows executable has no PE header");
  const machine = bytes.readUInt16LE(pe + 4);
  const sectionCount = bytes.readUInt16LE(pe + 6);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const optional = pe + 24;
  if (bytes.readUInt16LE(optional) !== 0x20b) return fail("The Windows executable is not PE32+");
  const importRva = bytes.readUInt32LE(optional + 112 + 8);
  const sections = Array.from({ length: sectionCount }, (_, index) => {
    const at = optional + optionalSize + index * 40;
    return {
      address: bytes.readUInt32LE(at + 12),
      size: Math.max(bytes.readUInt32LE(at + 8), bytes.readUInt32LE(at + 16)),
      offset: bytes.readUInt32LE(at + 20),
    };
  });
  const offsetOf = (rva: number) => {
    const section = sections.find((s) => rva >= s.address && rva < s.address + s.size);
    return section === undefined
      ? fail(`RVA ${rva} is in no section`)
      : rva - section.address + section.offset;
  };
  const imports: string[] = [];
  if (importRva === 0) return { machine, imports };
  for (let at = offsetOf(importRva); ; at += 20) {
    const nameRva = bytes.readUInt32LE(at + 12);
    if (nameRva === 0) break;
    const start = offsetOf(nameRva);
    imports.push(bytes.toString("latin1", start, bytes.indexOf(0, start)));
  }
  return { machine, imports };
};

const glibcVersion = (version: string) => version.split(".").map(Number);

const atMost = (version: ReadonlyArray<number>, ceiling: ReadonlyArray<number>) => {
  for (let index = 0; index < Math.max(version.length, ceiling.length); index++) {
    const a = version[index] ?? 0;
    const b = ceiling[index] ?? 0;
    if (a !== b) return a < b;
  }
  return true;
};

type Facts = Record<string, string>;

const checkLinux = (target: Target, binary: string): Facts => {
  const header = capture("objdump", ["-f", binary], { failure: "Cannot read the ELF header" });
  const architecture = target.arch === "x64" ? "i386:x86-64" : "aarch64";
  if (!header.includes(`architecture: ${architecture}`))
    fail(`The executable is not ${architecture}:\n${header}`);
  const symbols = capture("objdump", ["-T", binary], {
    failure: "Cannot read the dynamic symbols",
  });
  const versions = [...symbols.matchAll(/\bGLIBC_(\d+(?:\.\d+)+)\b/gu)].map(
    (match) => match[1] ?? "",
  );
  if (versions.length === 0)
    fail("The executable needs no glibc symbol: it is not the glibc build expected");
  const newest = versions.reduce((a, b) => (atMost(glibcVersion(a), glibcVersion(b)) ? b : a));
  if (!atMost(glibcVersion(newest), glibcCeiling))
    fail(
      `The executable needs GLIBC_${newest}, newer than GLIBC_${glibcCeiling.join(".")}: ${symbols
        .split("\n")
        .filter((line) => line.includes(`(GLIBC_${newest})`))
        .map((line) => line.trim().split(/\s+/u).at(-1))
        .join(", ")}`,
    );
  const needed = [
    ...capture("objdump", ["-p", binary], { failure: "Cannot read the dynamic section" }).matchAll(
      /^\s*NEEDED\s+(\S+)$/gmu,
    ),
  ].map((match) => match[1] ?? "");
  const unexpected = needed.filter((library) => !linuxLibraries.test(library));
  if (unexpected.length > 0)
    fail(`The executable links unexpected libraries: ${unexpected.join(", ")}`);
  return { "newest glibc symbol": `GLIBC_${newest}`, libraries: needed.join(" ") };
};

const checkDarwin = (target: Target, binary: string): Facts => {
  const expected = target.arch === "x64" ? "x86_64" : "arm64";
  const archs = capture("lipo", ["-archs", binary], {
    failure: "Cannot read the Mach-O header",
  }).trim();
  if (archs !== expected) fail(`The executable is ${archs}, not ${expected}`);
  const commands = capture("otool", ["-l", binary], { failure: "Cannot read the load commands" });
  const build = commands
    .split("Load command")
    .find((command) => command.includes("cmd LC_BUILD_VERSION"));
  const minos =
    build?.match(/^\s*minos (\S+)$/mu)?.[1] ?? fail("The executable has no LC_BUILD_VERSION minos");
  if (minos !== target.macosMinimum)
    fail(`The executable needs macOS ${minos}; it must be built for ${target.macosMinimum}`);
  const libraries = capture("otool", ["-L", binary], {
    failure: "Cannot read the linked libraries",
  })
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0] ?? "")
    .filter((library) => library !== "");
  const unexpected = libraries.filter(
    (library) => !library.startsWith("/usr/lib/") && !library.startsWith("/System/Library/"),
  );
  if (unexpected.length > 0)
    fail(`The executable links libraries outside the system: ${unexpected.join(", ")}`);
  return {
    "minimum macOS": minos,
    libraries: libraries.map((library) => path.basename(library)).join(" "),
  };
};

const checkWindows = (binary: string): Facts => {
  const bytes = fs.readFileSync(binary);
  const { machine, imports } = peImports(bytes);
  if (machine !== 0x8664) fail(`The executable's machine is 0x${machine.toString(16)}, not x86-64`);
  const runtime = imports.filter((name) => windowsRuntime.test(name));
  if (runtime.length > 0)
    fail(
      `The executable imports the C runtime dynamically (${runtime.join(", ")}): it must link it statically`,
    );
  if (!/<longPathAware\b[^>]*>\s*true\s*<\/longPathAware>/u.test(bytes.toString("latin1")))
    fail("The executable's embedded manifest does not declare longPathAware");
  return { "C runtime": "static", "long paths": "longPathAware", imports: imports.join(" ") };
};

const executableBytes = (binary: string): Buffer => {
  const bytes = fs.readFileSync(binary);
  if (bytes.length > maxBytes) fail(`The executable is ${bytes.length} bytes, over ${maxBytes}`);
  return bytes;
};

let chosenExecutable: string | undefined;
let verbose = false;
const executablePath = (target: Target) =>
  chosenExecutable ?? path.join(output, executableName(target));

const check = (target: Target, packaged: boolean) => {
  const binary = executablePath(target);
  if (!fs.existsSync(binary)) fail(`${binary} does not exist; run the build step first`);
  const bytes = executableBytes(binary);
  if (packaged) {
    const recorded = fs.existsSync(path.join(output, digestFile))
      ? fs.readFileSync(path.join(output, digestFile), "utf8").trim()
      : fail(`${output} records no ${digestFile}; it is not a whole build`);
    if (executableDigest(binary) !== recorded)
      fail(`${binary} is not the build in ${output} (its SHA-256 and size differ)`);
  }
  const leaked = (packaged ? [] : [...buildPaths(), os.homedir()])
    .map((directory) => directory.replace(/[\\/]+$/u, ""))
    .filter((directory) => directory !== "")
    .flatMap((directory) => {
      const forward = directory.replaceAll("\\", "/");
      const backward = directory.replaceAll("/", "\\");
      return [`${forward}/`, `${backward}\\`];
    })
    .filter((prefix) => bytes.includes(prefix));
  if (leaked.length > 0)
    fail(`The executable contains build machine paths: ${[...new Set(leaked)].join(", ")}`);
  const facts: Facts = {
    target: target.name,
    bytes: String(bytes.length),
    ...(target.os === "linux"
      ? checkLinux(target, binary)
      : target.os === "darwin"
        ? checkDarwin(target, binary)
        : checkWindows(binary)),
  };
  for (const [name, value] of Object.entries(facts)) console.log(`${name}: ${value}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== "")
    fs.appendFileSync(
      summary,
      `### executor-collector ${target.name}\n\n${Object.entries(facts)
        .map(([name, value]) => `- ${name}: \`${value}\``)
        .join("\n")}\n\n`,
    );
};

type Owned = {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  readonly firstLine: Promise<string>;
  readonly failed: Promise<Error>;
  readonly running: () => boolean;
  readonly log: () => string;
};

type Collector = {
  readonly port: number;
  readonly instance: Owned;
  readonly log: () => string;
};

const startDeadlineMs = 30_000;
const requestDeadlineMs = 10_000;
const stopDeadlineMs = 3_000;
const reapDeadlineMs = 5_000;

const deadline = (ms: number) => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((done) => {
    timer = setTimeout(() => done("late"), ms);
  });
  return { late, cancel: () => clearTimeout(timer) };
};

const spawnCollector = (binary: string, data: string, owned: Set<Owned>): Owned => {
  const child = spawn(binary, ["serve", "--data", data, "--listen", "127.0.0.1:0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let ended = false;
  let line: ((value: string) => void) | undefined;
  const firstLine = new Promise<string>((done) => {
    line = done;
  });
  let exit: ((code: number | null) => void) | undefined;
  const exited = new Promise<number | null>((done) => {
    exit = done;
  });
  const failed = new Promise<Error>((done) => {
    child.on("error", (error) => {
      done(error);
      if (child.pid === undefined) {
        ended = true;
        exit?.(null);
      }
    });
  });
  child.once("exit", (code) => {
    ended = true;
    exit?.(code);
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    const newline = stdout.indexOf("\n");
    if (newline >= 0) line?.(stdout.slice(0, newline));
  });
  const instance: Owned = {
    child,
    exited,
    firstLine,
    failed,
    running: () => !ended,
    log: () => `stdout:\n${stdout}\nstderr:\n${stderr}`,
  };
  owned.add(instance);
  return instance;
};

const reap = async (instance: Owned) => {
  if (instance.running()) instance.child.kill("SIGKILL");
  const wait = deadline(reapDeadlineMs);
  await Promise.race([instance.exited, wait.late]);
  wait.cancel();
};

const start = async (binary: string, data: string, owned: Set<Owned>): Promise<Collector> => {
  const instance = spawnCollector(binary, data, owned);
  const wait = deadline(startDeadlineMs);
  const first = await Promise.race([
    instance.firstLine.then((line) => ({ line })),
    instance.exited.then((code) => ({ code })),
    instance.failed.then((error) => ({ error })),
    wait.late,
  ]);
  wait.cancel();
  if (first === "late")
    return fail(
      `The collector did not print its listening line within ${startDeadlineMs} ms\n${instance.log()}`,
    );
  if ("error" in first) return fail(`Cannot start ${binary}: ${first.error.message}`);
  if ("code" in first)
    return fail(`The collector exited (${first.code}) before listening\n${instance.log()}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(first.line);
  } catch {
    return fail(`The collector's first line is not JSON: ${first.line}\n${instance.log()}`);
  }
  const port = isRecord(parsed) && parsed.event === "listening" ? parsed.port : undefined;
  if (typeof port !== "number")
    return fail(`Unexpected first line from the collector\n${instance.log()}`);
  return { port, instance, log: instance.log };
};

const stop = async (collector: Collector): Promise<number | null> => {
  const { instance } = collector;
  if (!instance.running()) return instance.exited;
  instance.child.kill("SIGTERM");
  const wait = deadline(stopDeadlineMs);
  const code = await Promise.race([instance.exited, wait.late]);
  wait.cancel();
  if (code === "late")
    return fail(
      `The collector did not exit within ${stopDeadlineMs} ms of SIGTERM\n${collector.log()}`,
    );
  return code;
};

const request = async (
  collector: Collector,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
) => {
  const response = await fetch(`http://127.0.0.1:${collector.port}${route}`, {
    method,
    signal: AbortSignal.timeout(requestDeadlineMs),
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (response.status !== 200)
    fail(`${method} ${route} answered ${response.status}: ${text}\n${collector.log()}`);
  const json: unknown = JSON.parse(text);
  return isRecord(json) ? json : fail(`${method} ${route} answered ${text}, not an object`);
};

const expectEqual = (route: string, name: string, actual: unknown, expected: unknown) => {
  if (actual !== expected)
    fail(`${route}: ${name} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
};

const crateVersion = () =>
  fs
    .readFileSync(path.join(crate, "Cargo.toml"), "utf8")
    .match(/^\[package\][^[]*?^version = "([^"]+)"/msu)?.[1] ??
  fail("Cannot read the crate's version from Cargo.toml");

const syntheticTraceId = "5b8efff798038103d269b633813fc60c";
const syntheticSpanId = "eee19b7ec3c1b174";

const spanExport = (spanId: string, name: string, attributes: ReadonlyArray<unknown>) => {
  const now = BigInt(Date.now()) * 1_000_000n;
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "collector-smoke" } }],
        },
        scopeSpans: [
          {
            scope: { name: "collector-smoke" },
            spans: [
              {
                traceId: syntheticTraceId,
                spanId,
                name,
                kind: 1,
                startTimeUnixNano: String(now - 1_000_000n),
                endTimeUnixNano: String(now),
                attributes,
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
};

const nestedDepth = 64;

const probes: ReadonlyArray<(collector: Collector) => Promise<void>> = [
  async (collector) => {
    const health = await request(collector, "GET", "/api/health");
    expectEqual("/api/health", "ok", health.ok, true);
    expectEqual("/api/health", "service", health.service, "executor-collector");
    expectEqual("/api/health", "version", health.version, crateVersion());
  },
  async (collector) => {
    const stored = await request(
      collector,
      "POST",
      "/v1/traces",
      spanExport(syntheticSpanId, "smoke", [
        { key: "smoke.case", value: { stringValue: "one span" } },
      ]),
    );
    expectEqual("/v1/traces", "insertedSpans", stored.insertedSpans, 1);
  },
  async (collector) => {
    let value: unknown = { stringValue: "deepest" };
    for (let depth = 0; depth < nestedDepth; depth++)
      value = { kvlistValue: { values: [{ key: `level${depth}`, value }] } };
    const stored = await request(
      collector,
      "POST",
      "/v1/traces",
      spanExport("eee19b7ec3c1b175", "smoke nested", [{ key: "smoke.nested", value }]),
    );
    expectEqual("/v1/traces nested", "insertedSpans", stored.insertedSpans, 1);
    const health = await request(collector, "GET", "/api/health");
    expectEqual("/api/health after the nested export", "ok", health.ok, true);
  },
  async (collector) => {
    const stored = await request(collector, "POST", "/v1/logs", {
      resourceLogs: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "collector-smoke" } }],
          },
          scopeLogs: [
            {
              scope: { name: "collector-smoke" },
              logRecords: [
                {
                  timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
                  severityText: "INFO",
                  body: { stringValue: "smoke" },
                  traceId: syntheticTraceId,
                  spanId: syntheticSpanId,
                },
              ],
            },
          ],
        },
      ],
    });
    expectEqual("/v1/logs", "insertedLogs", stored.insertedLogs, 1);
  },
  async (collector) => {
    const ingest = await request(collector, "GET", "/api/ingest");
    expectEqual("/api/ingest", "pending", ingest.pending, 0);
    const refused = isRecord(ingest.refused)
      ? ingest.refused
      : fail("/api/ingest: refused is not an object");
    for (const reason of ["queueFull", "tooLarge", "invalid", "storeFailed", "overBound"])
      expectEqual("/api/ingest", `refused.${reason}`, refused[reason], 0);
  },
];

const smoke = async (target: Target) => {
  const chosen = executablePath(target);
  if (target.os !== process.platform)
    fail(`Smoke-test ${target.name} on ${target.os}; this host is ${process.platform}`);
  const binary = chosen;
  if (!fs.existsSync(binary)) fail(`${binary} does not exist; run the build step first`);
  executableBytes(binary);
  if (target.os === "win32") {
    const setting = spawnSync(
      "reg",
      ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem", "/v", "LongPathsEnabled"],
      { encoding: "utf8" },
    );
    console.log(
      `LongPathsEnabled: ${setting.stdout.match(/LongPathsEnabled\s+REG_DWORD\s+(\S+)/u)?.[1] ?? "not set"}`,
    );
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "executor-collector-smoke-"));
  const data = path.join(scratch, ..."abcde".split("").map((letter) => letter.repeat(60)));
  const owned = new Set<Owned>();
  try {
    fs.mkdirSync(data, { recursive: true });
    const first = await start(binary, data, owned);
    for (const probe of probes) await probe(first);
    const code = await stop(first);
    if (target.os !== "win32") expectEqual("stop", "exit code", code, 0);
    const second = await start(binary, data, owned);
    await probes[0]?.(second);
    await stop(second);
    console.log(
      `Smoke-tested executor-collector for ${target.name} with a ${path.join(data, "telemetry.sqlite").length}-character store path.`,
    );
  } finally {
    await Promise.all([...owned].map(reap));
    try {
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.error(`Could not remove the smoke's directory ${scratch}: ${String(error)}`);
    }
  }
};

const steps = ["build", "notices", "check", "smoke"] as const;
type Step = (typeof steps)[number];

const isStep = (value: string): value is Step => steps.some((step) => step === value);

const hostTarget = () => `${process.platform}-${process.arch}`;

const parseArguments = (args: ReadonlyArray<string>) => {
  let targetName = hostTarget();
  let key = false;
  let install = false;
  let packaged = false;
  const chosen: Step[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--target") targetName = args[++index] ?? fail("--target needs a value");
    else if (arg === "--key") key = true;
    else if (arg === "--install-toolchain") install = true;
    else if (arg === "--packaged") packaged = true;
    else if (arg === "--verbose") verbose = true;
    else if (arg === "--executable") {
      const file = args[++index] ?? fail("--executable needs a path");
      chosenExecutable = path.resolve(file);
    } else if (isStep(arg)) chosen.push(arg);
    else
      fail(
        `Unknown argument ${arg}. Steps: ${steps.join(", ")}; options: --target <target>, --key, --install-toolchain, --packaged, --executable <file>, --verbose`,
      );
  }
  const target =
    targets.find((candidate) => candidate.name === targetName) ??
    fail(
      `No collector target ${targetName}; the targets are ${targets.map((t) => t.name).join(", ")}`,
    );
  if (key && chosen.length > 0) fail("--key prints the identity and runs no steps");
  if (!key && !install && chosen.length === 0)
    fail(`Name a step (${steps.join(", ")}), --key or --install-toolchain`);
  return { target, key, install, packaged, steps: chosen };
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  if (options.key) {
    toolchainReady(options.target, options.install);
    const configs = cargoConfigFiles();
    if (configs.length > 0)
      fail(
        `Cargo config in effect (${configs.join(", ")}): this build has no cacheable identity. Remove the file, or build without --key.`,
      );
    console.log(identity(options.target));
    return;
  }
  if (!options.key && options.steps.length === 0) {
    installToolchain(options.target);
    return;
  }
  for (const step of options.steps) {
    switch (step) {
      case "build":
        build(options.target, options.install);
        break;
      case "notices":
        notices(options.target);
        break;
      case "check":
        check(options.target, options.packaged);
        break;
      case "smoke":
        await smoke(options.target);
        break;
    }
  }
};

main().catch((error: unknown) => {
  if (error instanceof CollectorBuildError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
});
