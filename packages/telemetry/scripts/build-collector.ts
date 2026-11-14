/**
 * Builds the Rust telemetry collector (`packages/telemetry/collector`) for one release target, checks
 * the result against the platform floors, smoke-tests it, and writes it with its licence notices to
 * `packages/telemetry/dist/collector/`. Every consumer builds the collector through this script, so
 * the flags, path remapping and deployment targets live here, and this file is part of the
 * artifact's identity.
 *
 *   node packages/telemetry/scripts/build-collector.ts [--target <target>] --key
 *   node packages/telemetry/scripts/build-collector.ts [--target <target>] <step>...
 *
 * `<target>` is one of the release targets (`linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`,
 * `win32-x64`) and defaults to the host's. The steps run in the order given:
 *
 * - `build`: installs the pinned toolchain and the target's standard library with rustup, builds,
 *   and writes `dist/collector/` (the executable, `NOTICE`, `licenses/`, `cargo-packages.txt` and
 *   `identity`). It does nothing when `identity` already holds this tree's key.
 * - `notices`: rewrites the licence files and package list in `dist/collector/`.
 * - `check`: the platform checks on the built executable: architecture, size, the newest glibc
 *   symbol and the shared libraries on Linux, the minimum macOS version and the linked libraries on
 *   macOS, the C runtime imports on Windows, and no build machine paths.
 * - `smoke`: starts the built executable on a temporary store and port, sends one span and one log,
 *   reads the ingest counters, stops it and starts it again on the same store. It needs neither git
 *   nor Rust, so CI also runs it in an `ubuntu:22.04` container, the oldest glibc supported.
 *
 * `--key` prints the artifact's identity: a SHA-256 of the crate's files (tracked, or untracked and
 * not ignored, so uncommitted edits count), this script, the target, and the C compiler and linker
 * on this host. Caches store the build under it.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A failure the script reports in one line and exits 1 for. */
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
  /** `LC_BUILD_VERSION minos` on macOS. Pinned so a toolchain update cannot raise it unnoticed. */
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

/** The newest glibc symbol version the Linux executable may need: the CLI's bundled workerd needs it. */
const glibcCeiling = [2, 35] as const;
/** The shared libraries the Linux executable may link. */
const linuxLibraries =
  /^(libc\.so\.6|libm\.so\.6|libgcc_s\.so\.1|ld-linux-(x86-64|aarch64)\.so\.[12])$/u;
/** The Windows C runtime DLLs that `+crt-static` keeps out of the import table. */
const windowsRuntime = /^(vcruntime.*|msvcp.*|ucrtbase.*|api-ms-win-crt-.*)\.dll$/iu;
const maxBytes = 15 * 1024 * 1024;
/** The licence and notice files copied from each package, as `scripts/releases/runtime-bundle.ts` does. */
const noticeFile = /^(licen[sc]e|notice|copying|copyright|third.party)([._-]|$)/iu;
/**
 * A file that grants the package's licence: `LICENSE*`, `LICENCE*`, `COPYING*` or `UNLICENSE*`, but
 * not a supplemental one such as `LICENSE-THIRD-PARTY` or `LICENSE.notice`. A `NOTICE` or
 * `COPYRIGHT` file adds to a licence and grants none, so it never satisfies the gate alone.
 */
const primaryLicence = (name: string) =>
  /^(un)?licen[sc]e([._-]|$)|^copying([._-]|$)/iu.test(name) && !/third.party|notice/iu.test(name);

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "../../..");
const crate = path.join(root, "packages/telemetry/collector");
const output = path.join(root, "packages/telemetry/dist/collector");

const executableName = (target: Target) =>
  target.os === "win32" ? "executor-collector.exe" : "executor-collector";

// ---------------------------------------------------------------------------------------------
// Processes

/**
 * The variables rustup, cargo, rustc and the C compiler and linker they run may see. Everything
 * else is dropped, so nothing in the caller's environment can change the bytes without changing the
 * identity: `CC`, `CFLAGS`, `LDFLAGS` and their per-target forms, `LIBSQLITE3_FLAGS`, `SDKROOT`,
 * `RUSTFLAGS`, every `CARGO_*` setting but `CARGO_HOME`, a Visual Studio developer prompt's
 * `INCLUDE` and `LIB`, and any other variable a build script reads. What is kept only finds the tools (`PATH`, the homes,
 * the Windows system directories the MSVC lookup uses), and the identity records the versions of
 * the tools this environment finds. Compared with names in upper case, as Windows does.
 */
const keptVariables: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "CARGO_HOME",
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

/** The pinned Rust release, from the crate's `rust-toolchain.toml`. */
const pinnedToolchain = (): string =>
  fs
    .readFileSync(path.join(crate, "rust-toolchain.toml"), "utf8")
    .match(/^channel\s*=\s*"([^"]+)"\s*$/mu)?.[1] ??
  fail("Cannot read the channel from packages/telemetry/collector/rust-toolchain.toml");

/**
 * The environment for every Rust and C tool this script runs: the kept variables, the pinned
 * toolchain named explicitly in `RUSTUP_TOOLCHAIN` (it takes precedence over a `rustup override`
 * for the directory and over `rust-toolchain.toml`), and `extra`.
 */
const toolEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env))
    if (keptVariables.has(name.toUpperCase())) env[name] = value;
  return { ...env, CARGO_HOME: cargoHome(), RUSTUP_TOOLCHAIN: pinnedToolchain(), ...extra };
};

type Run = {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** What to say when the command cannot run or fails, before its own output. */
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

/** Runs a command to completion and returns its stdout; fails with its output when it fails. */
const capture = (command: string, args: ReadonlyArray<string>, options: Run): string => {
  const result = runResult(command, args, options);
  if (result.status !== 0)
    return fail(
      `${options.failure}: ${command} ${args.join(" ")} exited ${result.status ?? result.signal}\n${result.stderr}${result.stdout}`,
    );
  return result.stdout;
};

/**
 * Runs a command with its output on this process's stderr, so `--key` prints only the key, and
 * fails when it fails.
 */
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

// ---------------------------------------------------------------------------------------------
// Toolchain

/**
 * Cargo's home, by Cargo's own rule: `CARGO_HOME` when it is set and not empty, otherwise `.cargo`
 * in the home directory. Every tool this script runs is given this same absolute path, and the
 * Cargo config check looks there. A relative `CARGO_HOME` is refused: each tool would resolve it
 * from the directory it runs in, and this script from its own.
 */
const cargoHome = (): string => {
  const set = process.env.CARGO_HOME;
  const home = set === undefined || set === "" ? path.join(os.homedir(), ".cargo") : set;
  if (!path.isAbsolute(home))
    return fail(
      `CARGO_HOME must be an absolute path, not ${JSON.stringify(set)}: each tool would resolve it from the directory it runs in.`,
    );
  return path.resolve(home);
};

const requireRustup = () => {
  const result = spawnSync("rustup", ["--version"], { encoding: "utf8", env: toolEnv({}) });
  if (result.error !== undefined || result.status !== 0)
    fail(
      "rustup is not installed. Install it from https://rustup.rs; it installs the toolchain this crate pins in rust-toolchain.toml.",
    );
};

/** Installs the pinned toolchain and `target`'s standard library; both are no-ops once present. */
const installToolchain = (target: Target) => {
  requireRustup();
  const toolchain = pinnedToolchain();
  stream(
    "rustup",
    ["toolchain", "install", toolchain, "--profile", "minimal", "--no-self-update"],
    {
      cwd: crate,
      failure: "Cannot install the pinned Rust toolchain from static.rust-lang.org",
    },
  );
  // Only darwin-x64, built on an Apple Silicon runner, is not the host's own target. Adding it here
  // rather than in rust-toolchain.toml keeps every other machine from downloading four standard
  // libraries it never uses.
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

// ---------------------------------------------------------------------------------------------
// Identity

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * The tools that turn the crate into bytes, as `toolEnv` finds them: the pinned Rust toolchain
 * (`rustc -vV`, `cargo -vV`), the C compiler that builds the bundled SQLite and the linker that
 * links the executable.
 */
const hostTools = (target: Target): Record<string, string> => {
  // Some tools print their version and still exit non-zero (Apple's `ld -v` with no input), so
  // `anyStatus` takes what they printed.
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

/**
 * The Cargo configuration files in effect for the crate: `.cargo/config.toml` or `.cargo/config` in
 * the crate's directory or any directory above it, and in `CARGO_HOME`. The identity makes its
 * promise only when there are none, as on every CI and release runner. Cargo resolves a config's
 * values against where the file is, and an `[env]` entry can choose another compiler, so neither
 * its text nor its place says what it changes; a build with one in effect is never cached.
 */
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

/** Whether anything is at `file`, a link to nothing included. */
const present = (file: string): boolean => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether what is at a config path is a regular file, through links; fails otherwise. This is the
 * script's own rule, deliberately stricter than Cargo, which ignores a link to nothing there: no
 * key is made while anything other than a readable config file sits at a config path.
 */
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

/** The `identity` of a build a Cargo config affected. A key is 64 hex digits, so none equals it. */
const uncacheable = "uncacheable: a Cargo config file was in effect";

/** The crate's files as git sees them: tracked, or untracked and not ignored. */
const crateFiles = (): ReadonlyArray<string> =>
  capture(
    "git",
    ["ls-files", "-z", "-co", "--exclude-standard", "--", "packages/telemetry/collector"],
    { env: process.env, failure: "Cannot list the crate's files" },
  )
    .split("\0")
    .filter((file) => file !== "")
    .sort();

/**
 * The artifact identity of `target` built from this tree on this host: the crate's files, this
 * script, the target and the tools `toolEnv` finds. `toolEnv` keeps the caller's other variables
 * out of the build. It is a cacheable identity only while no Cargo config file is in effect
 * (`cargoConfigFiles`); callers check that first. Needs the pinned toolchain installed.
 */
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
    // A path git lists can be gone from the working tree (deleted, not yet staged).
    const absolute = path.join(root, file);
    hash.update(
      `${file}\0${fs.existsSync(absolute) ? sha256(fs.readFileSync(absolute)) : "deleted"}\n`,
    );
  }
  return hash.digest("hex");
};

// ---------------------------------------------------------------------------------------------
// Build

/** Paths on the build machine that must not appear in the executable. */
const buildPaths = (): ReadonlyArray<string> => [cargoHome(), sysroot(), crate, root];

const rustFlags = (target: Target): string =>
  [
    // The executable keeps source paths for panic messages. Fixed prefixes keep the build machine's
    // directories, and the user name in them, out of the bytes.
    `--remap-path-prefix=${cargoHome()}=/cargo`,
    `--remap-path-prefix=${sysroot()}=/rust`,
    `--remap-path-prefix=${crate}=/executor-collector`,
    // Link the C runtime statically, so the executable needs no Visual C++ redistributable.
    ...(target.os === "win32" ? ["-Ctarget-feature=+crt-static"] : []),
  ].join("\u001f");

const buildEnv = (target: Target) =>
  toolEnv({
    // The encoded form keeps paths with spaces whole.
    CARGO_ENCODED_RUSTFLAGS: rustFlags(target),
    // Read by rustc's linker arguments and by the C compiler for the bundled SQLite.
    ...(target.macosMinimum === undefined ? {} : { MACOSX_DEPLOYMENT_TARGET: target.macosMinimum }),
  });

const build = (target: Target) => {
  installToolchain(target);
  const configs = cargoConfigFiles();
  if (configs.length > 0)
    console.log(
      `Cargo config in effect (${configs.join(", ")}): building without the up-to-date check, and writing an identity no cache matches.`,
    );
  const key = configs.length === 0 ? identity(target) : undefined;
  const stamp = path.join(output, "identity");
  const executable = path.join(output, executableName(target));
  if (
    key !== undefined &&
    fs.existsSync(executable) &&
    fs.existsSync(stamp) &&
    fs.readFileSync(stamp, "utf8").trim() === key
  ) {
    console.log(`executor-collector for ${target.name} is up to date (${key}).`);
    return;
  }
  // Separate from the build, so an outage at crates.io is named as one.
  stream("cargo", ["fetch", "--locked", "--target", target.triple], {
    cwd: crate,
    failure: "Cannot download the crate's dependencies from crates.io",
  });
  stream("cargo", ["build", "--release", "--locked", "--offline", "--target", target.triple], {
    cwd: crate,
    env: buildEnv(target),
    failure: "cargo build failed",
  });
  // Replace the whole directory, and write the identity last, so an interrupted build never
  // leaves a directory that claims to be complete.
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  fs.copyFileSync(
    path.join(crate, "target", target.triple, "release", executableName(target)),
    executable,
  );
  if (target.os !== "win32") fs.chmodSync(executable, 0o755);
  notices(target);
  fs.writeFileSync(stamp, `${key ?? uncacheable}\n`);
  console.log(`Built executor-collector for ${target.name} at ${output} (${key ?? uncacheable}).`);
};

// ---------------------------------------------------------------------------------------------
// Notices

type CargoPackage = {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly directory: string;
  readonly licenseFile: string | undefined;
  /** A procedural macro runs inside the compiler; neither it nor what only it uses is linked. */
  readonly procMacro: boolean;
};

type CargoGraph = {
  readonly root: string;
  readonly packages: ReadonlyMap<string, CargoPackage>;
  /** Each package's dependencies that are linked into it: normal ones, not build or dev ones. */
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

/** Parses `cargo metadata --format-version 1` output into the resolved package graph. */
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
        // `null` is a normal dependency; "build" and "dev" never reach the executable.
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

/** Every package linked into the executable for `target`, the collector itself excluded. */
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

/**
 * Writes `NOTICE` (Motel's licence, whose behaviour the collector follows), `licenses/cargo/` (each
 * linked crate's licence and notice files), `licenses/rust/COPYRIGHT-library.html` (the Rust
 * standard library's notices, shipped in the toolchain) and `cargo-packages.txt`. SQLite is in the
 * public domain; `libsqlite3-sys` carries its notice. The system C libraries are linked dynamically,
 * except the MSVC C runtime on Windows.
 */
const notices = (target: Target) => {
  const licenses = path.join(output, "licenses");
  fs.rmSync(licenses, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  fs.copyFileSync(path.join(crate, "NOTICE"), path.join(output, "NOTICE"));
  const packages = linkedPackages(target);
  for (const pkg of packages) {
    const listed = fs.readdirSync(pkg.directory);
    // The package's own licence: the file its manifest declares, or a primary licence file.
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

// ---------------------------------------------------------------------------------------------
// Check

/** The DLL names a PE32+ executable imports, read from its import directory. */
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
  // PE32+: the data directories start at 112; the import directory is the second.
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

/** Facts the check established, for the log and the job summary. */
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
  // build.rs embeds windows.manifest; without it SQLite cannot open a store path over 260
  // characters even where the machine allows long paths.
  if (!/<longPathAware\b[^>]*>\s*true\s*<\/longPathAware>/u.test(bytes.toString("latin1")))
    fail("The executable's embedded manifest does not declare longPathAware");
  return { "C runtime": "static", "long paths": "longPathAware", imports: imports.join(" ") };
};

/** The executable's bytes; fails when it is over the 15 MiB cap, which `check` and `smoke` enforce. */
const executableBytes = (binary: string): Buffer => {
  const bytes = fs.readFileSync(binary);
  if (bytes.length > maxBytes) fail(`The executable is ${bytes.length} bytes, over ${maxBytes}`);
  return bytes;
};

const check = (target: Target) => {
  const binary = path.join(output, executableName(target));
  if (!fs.existsSync(binary)) fail(`${binary} does not exist; run the build step first`);
  const bytes = executableBytes(binary);
  // A leaked path continues into a file name, so each directory is searched with a separator after
  // it, which keeps a short directory such as a container's `/w` from matching other text. Both
  // separators are tried, since a path can be written either way on Windows.
  const leaked = [...buildPaths(), os.homedir()]
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

// ---------------------------------------------------------------------------------------------
// Smoke

/** A collector process this smoke test started. It is reaped before the test returns. */
type Owned = {
  readonly child: ChildProcess;
  /** Resolves with the exit code once the process has exited, or failed to start. */
  readonly exited: Promise<number | null>;
  /** Resolves with the first line it writes on stdout. */
  readonly firstLine: Promise<string>;
  /** Resolves when the process could not be started or signalled. */
  readonly failed: Promise<Error>;
  readonly running: () => boolean;
  /** Its output so far, for a failure message. */
  readonly log: () => string;
};

/** One collector that printed its listening line. */
type Collector = {
  readonly port: number;
  readonly instance: Owned;
  readonly log: () => string;
};

const startDeadlineMs = 30_000;
const requestDeadlineMs = 10_000;
/** The local host kills the collector 3 s after asking it to stop. */
const stopDeadlineMs = 3_000;
/** How long a killed collector gets to exit before the test gives up waiting for it. */
const reapDeadlineMs = 5_000;

/** A promise that resolves with "late" after `ms`, and the way to stop its timer. */
const deadline = (ms: number) => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((done) => {
    timer = setTimeout(() => done("late"), ms);
  });
  return { late, cancel: () => clearTimeout(timer) };
};

/**
 * Starts the collector and records it in `owned` before anything is read from it, so every path
 * out of the smoke test, a failure included, can reap it. The callbacks only collect output and
 * settle promises; nothing in them can throw.
 */
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
      // A process that never started emits no exit event.
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

/** Kills `instance` if it is still running and waits, at most `reapDeadlineMs`, for it to exit. */
const reap = async (instance: Owned) => {
  if (instance.running()) instance.child.kill("SIGKILL");
  const wait = deadline(reapDeadlineMs);
  await Promise.race([instance.exited, wait.late]);
  wait.cancel();
};

/** Starts a collector on `data` and waits for its listening line; fails on anything else. */
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

/**
 * Asks the collector to stop and resolves with its exit code; fails when it is still running
 * `stopDeadlineMs` later. Node cannot send Ctrl-Break to another process, so on Windows this
 * terminates it.
 */
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

/** A trace export of one synthetic span with these attributes. */
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

/** How many key-value lists the nested attribute value sits inside. */
const nestedDepth = 64;

/** What the smoke test sends and checks; each probe runs against the collector in order. */
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
  // The collector decodes on threads with a stack of its own size (otlp::DECODE_STACK), measured
  // on x86-64 Linux only, and its tests run only there: each platform's build must store a value
  // inside 64 key-value lists and stay up.
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
  // When the query routes exist, read the span and the log back here.
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
  if (target.os !== process.platform)
    fail(`Smoke-test ${target.name} on ${target.os}; this host is ${process.platform}`);
  const binary = path.join(output, executableName(target));
  if (!fs.existsSync(binary)) fail(`${binary} does not exist; run the build step first`);
  executableBytes(binary);
  if (target.os === "win32") {
    // A longPathAware process gets long paths only where the machine allows them; print the
    // setting, so a failure below says which of the two is missing.
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
  // The store's path is longer than Windows' 260-character MAX_PATH, as data directories under a
  // long user or temporary path can be.
  const data = path.join(scratch, ..."abcde".split("").map((letter) => letter.repeat(60)));
  const owned = new Set<Owned>();
  try {
    fs.mkdirSync(data, { recursive: true });
    const first = await start(binary, data, owned);
    for (const probe of probes) await probe(first);
    const code = await stop(first);
    // Windows: the process was terminated, which exits 1. Elsewhere SIGTERM is a clean stop.
    if (target.os !== "win32") expectEqual("stop", "exit code", code, 0);
    // The store opens again after the stop.
    const second = await start(binary, data, owned);
    await probes[0]?.(second);
    await stop(second);
    console.log(
      `Smoke-tested executor-collector for ${target.name} with a ${path.join(data, "telemetry.sqlite").length}-character store path.`,
    );
  } finally {
    await Promise.all([...owned].map(reap));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------------------------
// Command line

const steps = ["build", "notices", "check", "smoke"] as const;
type Step = (typeof steps)[number];

const isStep = (value: string): value is Step => steps.some((step) => step === value);

const hostTarget = () => `${process.platform}-${process.arch}`;

const parseArguments = (args: ReadonlyArray<string>) => {
  let targetName = hostTarget();
  let key = false;
  const chosen: Step[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--target") targetName = args[++index] ?? fail("--target needs a value");
    else if (arg === "--key") key = true;
    else if (isStep(arg)) chosen.push(arg);
    else
      fail(
        `Unknown argument ${arg}. Steps: ${steps.join(", ")}; options: --target <target>, --key`,
      );
  }
  const target =
    targets.find((candidate) => candidate.name === targetName) ??
    fail(
      `No collector target ${targetName}; the targets are ${targets.map((t) => t.name).join(", ")}`,
    );
  if (key && chosen.length > 0) fail("--key prints the identity and runs no steps");
  if (!key && chosen.length === 0) fail(`Name a step (${steps.join(", ")}) or --key`);
  return { target, key, steps: chosen };
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  if (options.key) {
    installToolchain(options.target);
    const configs = cargoConfigFiles();
    if (configs.length > 0)
      fail(
        `Cargo config in effect (${configs.join(", ")}): this build has no cacheable identity. Remove the file, or build without --key.`,
      );
    console.log(identity(options.target));
    return;
  }
  for (const step of options.steps) {
    switch (step) {
      case "build":
        build(options.target);
        break;
      case "notices":
        notices(options.target);
        break;
      case "check":
        check(options.target);
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
