/**
 * `packages/telemetry/scripts/build-collector.ts build` and its shared store. These cases copy the
 * script into a temporary git repository shaped like the crate, put fake `rustup`, `rustc`,
 * `cargo`, `cc`, `ld` and `ldd` first on PATH, and give the script its own cache directory, as
 * `prepare-cache.spec.ts` fakes e2e:prepare's builds. They read what the script compiled, copied,
 * kept and removed.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const triple = "x86_64-unknown-linux-gnu";
const output = "packages/telemetry/dist/collector";

/**
 * The fake tools. `cargo build` writes an executable naming the build's number, and appends to
 * `FAKE_STATE/ran`; the rest print fixed versions, as the identity reads them. Files in
 * `FAKE_STATE` steer `cargo build`: `slow` makes it take a second, `fail-once` makes the next build
 * fail after a second, `die-once` makes the next one kill the build script that ran it, and
 * `vanish` leaves a temporary file in the target directory, as rustc does. The script runs its
 * tools with only the variables that find them, so the fakes' own paths are written into them
 * (`FAKE_STATE`, `FAKE_SYSROOT`, `FAKE_METADATA` are replaced when the repository is made).
 */
const tools: Record<string, string> = {
  rustup: `#!/bin/sh
case "$1 $2" in
  "--version "*) echo "rustup 1.29.3 (fake)";;
  "toolchain list") echo "1.100.0-${triple}";;
  "target list") echo "${triple}";;
esac
`,
  rustc: `#!/bin/sh
case "$1" in
  -vV) printf 'rustc 1.100.0 (fake)\\nhost: ${triple}\\n';;
  --print) echo "FAKE_SYSROOT";;
esac
`,
  cargo: `#!/bin/sh
case "$1" in
  -vV) echo "cargo 1.100.0 (fake)";;
  fetch) echo "proxy=\${HTTPS_PROXY:-unset} lower=\${https_proxy:-unset} cainfo=\${CARGO_HTTP_CAINFO:-unset} cert=\${SSL_CERT_FILE:-unset} make=\${MAKEFLAGS:-unset} cargomake=\${CARGO_MAKEFLAGS:-unset} backtrace=\${RUST_BACKTRACE:-unset} log=\${RUST_LOG:-unset}" >> "FAKE_STATE/fetch-env";;
  metadata) cat "FAKE_METADATA";;
  build)
    echo "proxy=\${HTTPS_PROXY:-unset} lower=\${https_proxy:-unset} cainfo=\${CARGO_HTTP_CAINFO:-unset} cert=\${SSL_CERT_FILE:-unset} make=\${MAKEFLAGS:-unset} cargomake=\${CARGO_MAKEFLAGS:-unset} backtrace=\${RUST_BACKTRACE:-unset} log=\${RUST_LOG:-unset} args=$*" >> "FAKE_STATE/build-env"
    target=""
    while [ $# -gt 0 ]; do [ "$1" = --target-dir ] && target="$2"; shift; done
    if [ -f "FAKE_STATE/fail-once" ]; then rm "FAKE_STATE/fail-once"; sleep 1; exit 1; fi
    if [ -f "FAKE_STATE/die-once" ]; then rm "FAKE_STATE/die-once"; sleep 1; kill -9 $PPID; exit 1; fi
    started=$(date +%s.%N)
    [ -f "FAKE_STATE/slow" ] && sleep 1
    [ -f "FAKE_STATE/vanish" ] && mkdir -p "$target/.temp-archive" && echo a > "$target/.temp-archive/tmp.a"
    echo build >> "FAKE_STATE/ran"
    echo "$started $(date +%s.%N)" >> "FAKE_STATE/spans"
    echo "\${CARGO_BUILD_JOBS:-unset}" >> "FAKE_STATE/jobs"
    mkdir -p "$target/${triple}/release"
    printf 'collector build %s\\n' "$(wc -l < "FAKE_STATE/ran")" > "$target/${triple}/release/executor-collector";;
esac
`,
  cc: `#!/bin/sh
echo "cc (fake) 13"
`,
  ld: `#!/bin/sh
echo "GNU ld (fake) 2.42"
`,
  ldd: `#!/bin/sh
echo "ldd (fake) 2.39"
`,
};

/** A repository with the crate's shape, the real script, the fakes, a cache and a state file. */
const repository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-collector-build-" });
  const repo = path.join(root, "repo");
  const crate = path.join(repo, "packages/telemetry/collector");
  yield* fs.makeDirectory(path.join(crate, "src"), { recursive: true });
  yield* fs.writeFileString(path.join(crate, "rust-toolchain.toml"), 'channel = "1.100.0"\n');
  yield* fs.writeFileString(path.join(crate, "Cargo.toml"), '[package]\nname = "fake"\n');
  yield* fs.writeFileString(path.join(crate, "NOTICE"), "notice\n");
  yield* fs.writeFileString(path.join(crate, "src/main.rs"), "fn main() {}\n");
  yield* fs.makeDirectory(path.join(repo, "packages/telemetry/scripts"), { recursive: true });
  yield* fs.copyFile(
    "packages/telemetry/scripts/build-collector.ts",
    path.join(repo, "packages/telemetry/scripts/build-collector.ts"),
  );
  yield* processes.exitCode(ChildProcess.make("git", ["init", "--quiet"], { cwd: repo }));
  const bin = path.join(root, "bin");
  yield* fs.makeDirectory(bin);
  const sysroot = path.join(root, "sysroot");
  const metadata = path.join(root, "metadata.json");
  const state = path.join(root, "state");
  for (const [name, text] of Object.entries(tools)) {
    yield* fs.writeFileString(
      path.join(bin, name),
      text
        .replaceAll("FAKE_STATE", state)
        .replaceAll("FAKE_SYSROOT", sysroot)
        .replaceAll("FAKE_METADATA", metadata),
    );
    yield* fs.chmod(path.join(bin, name), 0o755);
  }
  yield* fs.makeDirectory(path.join(sysroot, "share/doc/rust"), { recursive: true });
  yield* fs.writeFileString(path.join(sysroot, "share/doc/rust/COPYRIGHT-library.html"), "©\n");
  const id = "path+file:///fake#0.1.0";
  yield* fs.writeFileString(
    metadata,
    JSON.stringify({
      packages: [
        {
          id,
          name: "fake",
          version: "0.1.0",
          manifest_path: path.join(crate, "Cargo.toml"),
          license_file: null,
          targets: [{ kind: ["bin"] }],
        },
      ],
      resolve: { root: id, nodes: [{ id, deps: [] }] },
    }),
  );
  yield* fs.makeDirectory(state);
  yield* fs.makeDirectory(path.join(root, "home"));
  return { root, repo, bin, sysroot, metadata, state, cache: path.join(root, "cache") };
});
type Repository = Effect.Success<typeof repository>;

/** Runs `build-collector.ts build` in `input.repo`; its exit code, output and the builds it ran. */
const build = (
  input: Repository,
  preload?: string,
  repo: string = input.repo,
  extra: Record<string, string> = {},
  flags: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const ranFile = path.join(input.state, "ran");
    const before = (yield* fs.exists(ranFile))
      ? (yield* fs.readFileString(ranFile)).split("\n").filter(Boolean).length
      : 0;
    const child = yield* processes.spawn(
      ChildProcess.make(
        "node",
        [
          ...(preload === undefined ? [] : ["--import", preload]),
          "packages/telemetry/scripts/build-collector.ts",
          "--target",
          "linux-x64",
          ...flags,
          "build",
        ],
        {
          cwd: repo,
          env: {
            PATH: `${input.bin}:${process.env.PATH ?? ""}`,
            HOME: path.join(input.root, "home"),
            CARGO_HOME: path.join(input.root, "home/.cargo"),
            RUSTUP_HOME: path.join(input.root, "home/.rustup"),
            EXECUTOR_COLLECTOR_CACHE: input.cache,
            FAKE_STATE: input.state,
            FAKE_SYSROOT: input.sysroot,
            FAKE_METADATA: input.metadata,
            CI: "",
            ...extra,
          },
          extendEnv: false,
        },
      ),
    );
    const [log, exitCode] = yield* Effect.all(
      [
        child.all.pipe(Stream.decodeText(), Stream.mkString),
        // A build killed by a signal has no exit code: -1.
        child.exitCode.pipe(Effect.orElseSucceed(() => -1)),
      ],
      { concurrency: "unbounded" },
    );
    const after = (yield* fs.exists(ranFile))
      ? (yield* fs.readFileString(ranFile)).split("\n").filter(Boolean).length
      : 0;
    return { exitCode, log, compiled: after - before };
  }).pipe(Effect.scoped);

/** The store's entries for linux-x64, partial copies included. */
const storeEntries = (input: Repository) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(input.cache, "store/linux-x64");
    return (yield* fs.exists(directory)) ? (yield* fs.readDirectory(directory)).sort() : [];
  });

const read = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file);
  });

/** Copies of `input.repo`, each its own workspace, sharing its cache, fakes and state. */
const workspaces = (input: Repository, count: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const made: string[] = [];
    for (let index = 0; index < count; index++) {
      const copy = path.join(input.root, `workspace-${index}`);
      yield* fs.copy(input.repo, copy);
      made.push(copy);
    }
    return made;
  });

/** Every `cargo build` the fakes ran, in all workspaces. */
const compiles = (input: Repository) =>
  read(`${input.state}/ran`).pipe(
    Effect.map((text) => text.split("\n").filter(Boolean).length),
    Effect.orElseSucceed(() => 0),
  );

const locks = (input: Repository) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = `${input.cache}/locks/linux-x64`;
    return (yield* fs.exists(directory)) ? yield* fs.readDirectory(directory) : [];
  });

/** Waits until a build holds the identity's lock. */
const lockTaken = (input: Repository) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 500; tries++) {
      if ((yield* locks(input)).some((name) => name.endsWith(".lock"))) return;
      yield* Effect.sleep("20 millis");
    }
    return yield* Effect.die(new Error("no build took the lock within 10 s"));
  });

const flag = (input: Repository, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`${input.state}/${name}`, "");
  });

// The real clock: the cases that run builds at once wait for one another in real time.
const suite = layer(NodeServices.layer, { excludeTestServices: true });

suite("The collector's build and its store", (it) => {
  it.effect("a damaged executable is never taken as up to date, in a workspace or the store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* repository;
      const first = yield* build(input);
      expect(first.exitCode, first.log).toBe(0);
      expect(first.compiled).toBe(1);
      const [key] = yield* storeEntries(input);
      expect(key, first.log).toMatch(/^[0-9a-f]{64}$/u);
      const executable = path.join(input.repo, output, "executor-collector");
      const stored = path.join(input.cache, "store/linux-x64", key!, "executor-collector");

      // The workspace's executable cut short: not "up to date"; the store's whole copy replaces it.
      yield* fs.writeFileString(executable, "cut");
      const workspace = yield* build(input);
      expect(workspace.exitCode, workspace.log).toBe(0);
      expect(workspace.log).not.toContain("is up to date");
      expect(workspace.log).toContain("copied from");
      expect(yield* read(executable)).toBe("collector build 1\n");

      // The stored executable cut short: removed and built again, never handed to a workspace.
      yield* fs.writeFileString(stored, "cut");
      yield* fs.remove(path.join(input.repo, output), { recursive: true });
      const damaged = yield* build(input);
      expect(damaged.exitCode, damaged.log).toBe(0);
      expect(damaged.log).toContain("Removed the damaged stored build");
      expect(damaged.compiled, damaged.log).toBe(1);
      expect(yield* read(executable)).toBe("collector build 2\n");
      expect(yield* read(stored)).toBe("collector build 2\n");

      // One byte changed, the length kept: the digest, not the size, decides. In the workspace's
      // copy first, then in the store's.
      yield* fs.writeFileString(executable, "Xollector build 2\n");
      const flipped = yield* build(input);
      expect(flipped.exitCode, flipped.log).toBe(0);
      expect(flipped.log).not.toContain("is up to date");
      expect(flipped.log).toContain("copied from");
      expect(yield* read(executable)).toBe("collector build 2\n");
      yield* fs.writeFileString(stored, "Xollector build 2\n");
      yield* fs.writeFileString(executable, "Xollector build 2\n");
      const storeFlipped = yield* build(input);
      expect(storeFlipped.exitCode, storeFlipped.log).toBe(0);
      expect(storeFlipped.log).toContain("Removed the damaged stored build");
      expect(storeFlipped.compiled, storeFlipped.log).toBe(1);
      expect(yield* read(executable)).toBe("collector build 3\n");
      expect(yield* read(stored)).toBe("collector build 3\n");

      // Unchanged since: up to date, nothing compiled.
      const again = yield* build(input);
      expect(again.log).toContain("is up to date");
      expect(again.compiled).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("an abandoned partial copy is removed and counted, a live writer's is kept", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* repository;
      const store = path.join(input.cache, "store/linux-x64");
      yield* fs.makeDirectory(store, { recursive: true });
      // A copy whose writer has exited (no process has that id) and one whose writer runs: this
      // test's own process, the copy fresh.
      const dead = path.join(store, `${"0".repeat(64)}.partial-2147483646-0a0b0c0d`);
      const live = path.join(store, `${"1".repeat(64)}.partial-${process.pid}-0a0b0c0d`);
      for (const partial of [dead, live]) {
        yield* fs.makeDirectory(partial);
        yield* fs.writeFileString(path.join(partial, "executor-collector"), "partial");
      }
      const run = yield* build(input);
      expect(run.exitCode, run.log).toBe(0);
      expect(yield* fs.exists(dead), "the abandoned copy is removed").toBe(false);
      expect(yield* fs.exists(live), "a live writer's copy is kept").toBe(true);
      // Partial copies count against the store's bound: 31 old entries, the live partial and the
      // new build are 33, so the oldest entry goes.
      const old = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
      for (let index = 0; index < 31; index++) {
        const entry = path.join(store, index.toString(16).padStart(64, "a"));
        yield* fs.makeDirectory(entry);
        yield* fs.writeFileString(path.join(entry, "last-used"), "");
        yield* fs.utimes(path.join(entry, "last-used"), old + index, old + index);
      }
      yield* fs.writeFileString(
        path.join(input.repo, "packages/telemetry/collector/src/main.rs"),
        "fn main() { }\n",
      );
      const next = yield* build(input);
      expect(next.exitCode, next.log).toBe(0);
      const entries = yield* storeEntries(input);
      expect(entries).toHaveLength(32);
      expect(entries).toContain(path.basename(live));
      expect(entries).not.toContain("0".padStart(64, "a"));
    }).pipe(Effect.scoped),
  );

  it.effect("a copy that fails part way leaves no partial copy behind", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* repository;
      const first = yield* build(input);
      expect(first.exitCode, first.log).toBe(0);
      yield* fs.remove(path.join(input.repo, output), { recursive: true });
      // Every copy out of the store fails part way, as a full disk would.
      const preload = path.join(input.root, "fail-copy.mjs");
      yield* fs.writeFileString(
        preload,
        `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const copy = fs.cpSync;
fs.cpSync = (from, to, options) => {
  if (String(from).includes("/store/")) { copy(from, to, options); throw new Error("ENOSPC: copy cut short"); }
  return copy(from, to, options);
};
syncBuiltinESMExports();
`,
      );
      const failed = yield* build(input, preload);
      expect(failed.exitCode).not.toBe(0);
      const left = (yield* fs.readDirectory(
        path.join(input.repo, "packages/telemetry/dist"),
      )).filter((name) => name.includes(".partial-"));
      expect(left, "no partial copy is left in the workspace").toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("an entry marked after pruning listed it is kept: pruning reads it again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* repository;
      const first = yield* build(input);
      expect(first.exitCode, first.log).toBe(0);
      const [key] = yield* storeEntries(input);
      const marker = path.join(input.cache, "store/linux-x64", key!, "last-used");
      // Unused for 40 days, past the store's 30.
      const old = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000;
      yield* fs.utimes(marker, old, old);
      // Another crate's build publishes and prunes. Just after its pruning first reads the old
      // entry's last use, another workspace marks the entry used, before pruning decides.
      yield* fs.writeFileString(
        path.join(input.repo, "packages/telemetry/collector/src/main.rs"),
        "fn main() { }\n",
      );
      const preload = path.join(input.root, "mark-after-listing.mjs");
      yield* fs.writeFileString(
        preload,
        `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const stat = fs.statSync;
let listed = false;
fs.statSync = (file, ...rest) => {
  const found = stat(file, ...rest);
  if (!listed && String(file) === ${JSON.stringify(marker)}) {
    listed = true;
    const now = new Date();
    fs.utimesSync(file, now, now);
  }
  return found;
};
syncBuiltinESMExports();
`,
      );
      const run = yield* build(input, preload);
      expect(run.exitCode, run.log).toBe(0);
      expect(yield* fs.exists(marker), "the entry marked after the listing is kept").toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("an old entry being copied is not removed by another build's pruning", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* repository;
      const first = yield* build(input);
      expect(first.exitCode, first.log).toBe(0);
      const [key] = yield* storeEntries(input);
      const entry = path.join(input.cache, "store/linux-x64", key!);
      // Unused for 40 days, past the store's 30.
      const old = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000;
      yield* fs.utimes(path.join(entry, "last-used"), old, old);
      yield* fs.remove(path.join(input.repo, output), { recursive: true });
      // A second workspace, whose crate differs, publishes and prunes just as this one starts
      // copying the old entry: run it from inside the first copy out of the store.
      const second = path.join(input.root, "second");
      yield* fs.copy(input.repo, second);
      yield* fs.writeFileString(
        path.join(second, "packages/telemetry/collector/src/main.rs"),
        "fn main() { }\n",
      );
      const preload = path.join(input.root, "prune-during-copy.mjs");
      yield* fs.writeFileString(
        preload,
        `import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const copy = fs.cpSync;
let once = false;
fs.cpSync = (from, to, options) => {
  if (!once && String(from).includes("/store/")) {
    once = true;
    execFileSync("node", ["packages/telemetry/scripts/build-collector.ts", "--target", "linux-x64", "build"], { cwd: ${JSON.stringify(second)}, stdio: "ignore" });
  }
  return copy(from, to, options);
};
syncBuiltinESMExports();
`,
      );
      const run = yield* build(input, preload);
      expect(run.exitCode, run.log).toBe(0);
      expect(run.log).toContain("copied from");
      expect(yield* fs.exists(entry), "the entry being copied is kept").toBe(true);
      expect(yield* read(path.join(input.repo, output, "executor-collector"))).toBe(
        "collector build 1\n",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("CARGO_BUILD_JOBS reaches cargo and is not part of the identity", () =>
    Effect.gen(function* () {
      const input = yield* repository;
      const first = yield* build(input, undefined, input.repo, { CARGO_BUILD_JOBS: "3" });
      expect(first.exitCode, first.log).toBe(0);
      expect(yield* read(`${input.state}/jobs`)).toBe("3\n");
      // Another limit, the same identity: up to date, nothing compiled.
      const second = yield* build(input, undefined, input.repo, { CARGO_BUILD_JOBS: "5" });
      expect(second.log).toContain("is up to date");
      expect(second.compiled).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("proxy and certificate variables reach the fetch alone, outside the identity", () =>
    Effect.gen(function* () {
      const input = yield* repository;
      const proxied = {
        HTTPS_PROXY: "http://proxy.invalid:3128",
        https_proxy: "http://lower.invalid:3128",
        CARGO_HTTP_CAINFO: "/etc/fake-ca.pem",
        SSL_CERT_FILE: "/etc/fake-ca.pem",
      };
      const first = yield* build(input, undefined, input.repo, proxied);
      expect(first.exitCode, first.log).toBe(0);
      expect(yield* read(`${input.state}/fetch-env`)).toContain(
        "proxy=http://proxy.invalid:3128 lower=http://lower.invalid:3128 cainfo=/etc/fake-ca.pem cert=/etc/fake-ca.pem",
      );
      expect(yield* read(`${input.state}/build-env`)).toContain(
        "proxy=unset lower=unset cainfo=unset cert=unset",
      );
      // Another proxy, or none: the same identity, nothing compiled.
      for (const env of [{ HTTPS_PROXY: "http://other.invalid:8080" }, {}]) {
        const again = yield* build(input, undefined, input.repo, env);
        expect(again.log).toContain("is up to date");
        expect(again.compiled).toBe(0);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("jobserver and diagnostic variables reach neither the fetch nor the compile", () =>
    Effect.gen(function* () {
      const input = yield* repository;
      const run = yield* build(input, undefined, input.repo, {
        MAKEFLAGS: "-j2 --jobserver-auth=3,4",
        CARGO_MAKEFLAGS: "-j2 --jobserver-auth=3,4",
        RUST_BACKTRACE: "full",
        RUST_LOG: "debug",
      });
      expect(run.exitCode, run.log).toBe(0);
      const unset = "make=unset cargomake=unset backtrace=unset log=unset";
      expect(yield* read(`${input.state}/fetch-env`)).toContain(unset);
      expect(yield* read(`${input.state}/build-env`)).toContain(unset);
    }).pipe(Effect.scoped),
  );

  it.effect("--verbose asks cargo and the compiler for more, outside the identity", () =>
    Effect.gen(function* () {
      const input = yield* repository;
      // A failed build says how to see more.
      yield* flag(input, "fail-once");
      const failed = yield* build(input);
      expect(failed.exitCode).not.toBe(0);
      expect(failed.log).toContain("run the build again with --verbose");
      const verbose = yield* build(input, undefined, input.repo, {}, ["--verbose"]);
      expect(verbose.exitCode, verbose.log).toBe(0);
      expect(yield* read(`${input.state}/build-env`)).toMatch(
        /backtrace=1 log=unset args=build -vv /u,
      );
      const plain = yield* build(input);
      expect(plain.log).toContain("is up to date");
      expect(plain.compiled).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a store that cannot be written is said loudly, and three builds at once do not queue",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = yield* repository;
        yield* flag(input, "slow");
        const three = yield* workspaces(input, 3);
        // The store alone is read-only: the locks beside it can still be taken.
        const store = path.join(input.cache, "store");
        yield* fs.makeDirectory(store, { recursive: true });
        yield* fs.chmod(store, 0o555);
        const notes = three.map((repo) => `${repo}.notes`);
        const runs = yield* Effect.all(
          three.map((repo, index) =>
            build(input, undefined, repo, { EXECUTOR_PREPARE_NOTES: notes[index]! }),
          ),
          { concurrency: "unbounded" },
        ).pipe(Effect.ensuring(fs.chmod(store, 0o755).pipe(Effect.orDie)));
        for (const run of runs) {
          expect(run.exitCode, run.log).toBe(0);
          expect(run.log).toContain("cannot be written");
        }
        for (const file of notes)
          expect(yield* read(file), "the line e2e:prepare repeats").toMatch(
            /^The shared collector store .* cannot be written \(Error: EACCES/u,
          );
        // Three compiles, each while the others ran: none waited for another's build.
        const spans = (yield* read(`${input.state}/spans`))
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split(" ").map(Number) as [number, number]);
        expect(spans).toHaveLength(3);
        expect(
          Math.max(...spans.map(([start]) => start)),
          runs.map((run) => run.log).join("\n"),
        ).toBeLessThan(Math.min(...spans.map(([, end]) => end)));
        const note = path.join(input.cache, "locks/linux-x64/store-unwritable");
        expect(yield* fs.exists(note), "the note beside the locks").toBe(true);
        expect(yield* locks(input)).toEqual(["store-unwritable"]);
        // The store repaired: the next build stores, and the note goes with no one removing it.
        yield* fs.remove(path.join(three[0]!, output), { recursive: true });
        const repaired = yield* build(input, undefined, three[0]);
        expect(repaired.exitCode, repaired.log).toBe(0);
        expect(repaired.log).not.toContain("cannot be written");
        expect(yield* storeEntries(input)).toHaveLength(1);
        expect(yield* fs.exists(note)).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a store with room for the probe but not the build: waiters read the note and do not queue",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = yield* repository;
        yield* flag(input, "slow");
        const three = yield* workspaces(input, 3);
        // Every copy into the store fails as a full disk would; the small probe still fits.
        const preload = path.join(input.root, "store-full.mjs");
        yield* fs.writeFileString(
          preload,
          `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const copy = fs.cpSync;
fs.cpSync = (from, to, options) => {
  if (String(to).includes("/store/")) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  return copy(from, to, options);
};
syncBuiltinESMExports();
`,
        );
        const [first, ...rest] = three;
        const [held, ...waited] = yield* Effect.all(
          [
            build(input, preload, first),
            ...rest.map((repo) =>
              lockTaken(input).pipe(Effect.andThen(build(input, preload, repo))),
            ),
          ],
          { concurrency: "unbounded" },
        );
        for (const run of [held!, ...waited]) expect(run.exitCode, run.log).toBe(0);
        expect(held!.log).toContain("cannot be written (Error: ENOSPC");
        // Each read the note: while the holder still held the lock, or on taking it after.
        for (const run of waited)
          expect(run.log).toMatch(/building (here without waiting|without holding the lock)/u);
        // The two waiters compile together once the holder has noted the store, not one after another.
        const spans = (yield* read(`${input.state}/spans`))
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split(" ").map(Number) as [number, number])
          .sort((a, b) => a[0] - b[0]);
        expect(spans).toHaveLength(3);
        const [, second, third] = spans;
        expect(Math.max(second![0], third![0])).toBeLessThan(Math.min(second![1], third![1]));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a link to nothing counts by its target; editor leftovers do not count, near misses do",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = yield* repository;
        const src = path.join(input.repo, "packages/telemetry/collector/src");
        // Emacs's lock link for an open file: a link to nothing, its text a user, host and pid.
        yield* fs.symlink("someone@host.4242:1700000000", path.join(src, ".#main.rs"));
        const first = yield* build(input);
        expect(first.exitCode, first.log).toBe(0);
        expect(first.compiled).toBe(1);
        // Left out: another Emacs lock, a vim swap file, a backup and .DS_Store.
        yield* fs.remove(path.join(src, ".#main.rs"));
        yield* fs.symlink("someone@host.4343:1700000001", path.join(src, ".#main.rs"));
        for (const name of [".main.rs.swp", "main.rs~", ".DS_Store"])
          yield* fs.writeFileString(path.join(src, name), "leftover\n");
        const leftovers = yield* build(input);
        expect(leftovers.log, "leftovers are not part of the identity").toContain("is up to date");
        // Counted: a near miss of the swap pattern, and any other link to nothing, by its target.
        for (const [change, act] of [
          ["a near miss, main.swp", fs.writeFileString(path.join(src, "main.swp"), "counts\n")],
          ["a link to nothing", fs.symlink("nowhere", path.join(src, "dangling"))],
          [
            "the same link's new target",
            fs
              .remove(path.join(src, "dangling"))
              .pipe(Effect.andThen(fs.symlink("elsewhere", path.join(src, "dangling")))),
          ],
        ] as const) {
          yield* act;
          const run = yield* build(input);
          expect(run.exitCode, run.log).toBe(0);
          expect(run.compiled, change).toBe(1);
        }
        // A link to a directory is still refused.
        yield* fs.symlink("..", path.join(src, "up"));
        const refused = yield* build(input);
        expect(refused.exitCode).toBe(1);
        expect(refused.log).toContain("neither a file, a directory nor a link to a file");
      }).pipe(Effect.scoped),
  );

  it.effect("a source file git ignores is part of the identity", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* repository;
      // The repository's root ignores dist/, as executor-next's does; the compiler still reads it.
      yield* fs.writeFileString(path.join(input.repo, ".gitignore"), "dist/\n");
      const module = path.join(input.repo, "packages/telemetry/collector/src/dist/mod.rs");
      yield* fs.makeDirectory(path.dirname(module), { recursive: true });
      yield* fs.writeFileString(module, "pub const A: u8 = 1;\n");
      const first = yield* build(input);
      expect(first.exitCode, first.log).toBe(0);
      expect(first.compiled).toBe(1);
      yield* fs.writeFileString(module, "pub const A: u8 = 2;\n");
      const changed = yield* build(input);
      expect(changed.exitCode, changed.log).toBe(0);
      expect(changed.log).not.toContain("is up to date");
      expect(changed.compiled, "the ignored file's change is compiled").toBe(1);
      // The crate's own target/, where cargo test writes, is not.
      const tested = path.join(input.repo, "packages/telemetry/collector/target/debug/x");
      yield* fs.makeDirectory(path.dirname(tested), { recursive: true });
      yield* fs.writeFileString(tested, "test output\n");
      const again = yield* build(input);
      expect(again.log).toContain("is up to date");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "nothing after a whole build fails it: a file gone in the walk, a cache it cannot read",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const input = yield* repository;
        // Another workspace's rustc removes its temporary file between the walk's listing and its stat.
        yield* flag(input, "vanish");
        const preload = path.join(input.root, "vanish.mjs");
        yield* (yield* FileSystem.FileSystem).writeFileString(
          preload,
          `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const stat = fs.statSync;
fs.statSync = (file, ...rest) => {
  if (String(file).endsWith("/.temp-archive/tmp.a")) {
    fs.rmSync(file, { force: true });
    throw Object.assign(new Error("ENOENT: no such file or directory, stat '" + file + "'"), { code: "ENOENT" });
  }
  return stat(file, ...rest);
};
syncBuiltinESMExports();
`,
        );
        const vanished = yield* build(input, preload);
        expect(vanished.exitCode, vanished.log).toBe(0);
        expect(vanished.log).not.toContain("failed; the build stands");
        expect(yield* read(path.join(input.repo, output, "executor-collector"))).toBe(
          "collector build 1\n",
        );
        // Pruning cannot even list the cache's target directories: logged, and the build stands.
        yield* (yield* FileSystem.FileSystem).writeFileString(
          path.join(input.repo, "packages/telemetry/collector/src/main.rs"),
          "fn main() { }\n",
        );
        const unreadable = path.join(input.root, "unreadable.mjs");
        yield* (yield* FileSystem.FileSystem).writeFileString(
          unreadable,
          `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const list = fs.readdirSync;
fs.readdirSync = (directory, ...rest) => {
  if (String(directory) === ${JSON.stringify(path.join(input.cache, "target"))})
    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  return list(directory, ...rest);
};
syncBuiltinESMExports();
`,
        );
        const failed = yield* build(input, unreadable);
        expect(failed.exitCode, failed.log).toBe(0);
        expect(failed.log).toContain("failed; the build stands: Error: EACCES");
        expect(yield* read(path.join(input.repo, output, "executor-collector"))).toBe(
          "collector build 2\n",
        );
      }).pipe(Effect.scoped),
  );

  it.effect("four builds of one identity at once compile once and each copy it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const input = yield* repository;
      yield* flag(input, "slow");
      const four = yield* workspaces(input, 4);
      const runs = yield* Effect.all(
        four.map((repo) => build(input, undefined, repo)),
        { concurrency: "unbounded" },
      );
      for (const run of runs) expect(run.exitCode, run.log).toBe(0);
      expect(yield* compiles(input), runs.map((run) => run.log).join("\n")).toBe(1);
      expect(runs.filter((run) => run.log.includes("Built executor-collector"))).toHaveLength(1);
      const copied = runs.filter((run) => run.log.includes("copied from"));
      expect(copied).toHaveLength(3);
      for (const run of copied) expect(run.log).toContain("Waiting for process");
      for (const repo of four)
        expect(yield* read(path.join(repo, output, "executor-collector"))).toBe(
          "collector build 1\n",
        );
      expect(yield* locks(input), "every lock is released").toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("a waiter builds when the lock's holder fails, and takes over when it is killed", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const input = yield* repository;
      const [first, second] = yield* workspaces(input, 2);
      // The holder's build fails: the waiter finds no stored build and compiles it itself.
      yield* flag(input, "fail-once");
      const [failed, waited] = yield* Effect.all(
        [
          build(input, undefined, first),
          lockTaken(input).pipe(Effect.andThen(build(input, undefined, second))),
        ],
        { concurrency: "unbounded" },
      );
      expect(failed.exitCode).not.toBe(0);
      expect(waited.exitCode, waited.log).toBe(0);
      expect(waited.log).toContain("Waiting for process");
      expect(waited.log).toContain("Built executor-collector");
      expect(yield* read(path.join(second!, output, "executor-collector"))).toBe(
        "collector build 1\n",
      );
      expect(yield* locks(input)).toEqual([]);

      // The holder is killed part way, its lock left behind: the waiter takes it over.
      const fs = yield* FileSystem.FileSystem;
      for (const repo of [first!, second!])
        yield* fs.writeFileString(
          path.join(repo, "packages/telemetry/collector/src/main.rs"),
          "fn main() { }\n",
        );
      yield* flag(input, "die-once");
      const [killed, tookOver] = yield* Effect.all(
        [
          build(input, undefined, first),
          lockTaken(input).pipe(Effect.andThen(build(input, undefined, second))),
        ],
        { concurrency: "unbounded" },
      );
      expect(killed.exitCode).not.toBe(0);
      expect(tookOver.exitCode, tookOver.log).toBe(0);
      expect(tookOver.log).toMatch(/is stale, its builder, process \d+, has exited/u);
      expect(tookOver.log).toContain("Built executor-collector");
      expect(yield* read(path.join(second!, output, "executor-collector"))).toBe(
        "collector build 2\n",
      );
      expect(yield* locks(input)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a lock whose process id now names another process, or over an hour old, is stale",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = yield* repository;
        // Learn the identity, then make its lock by hand.
        const first = yield* build(input);
        expect(first.exitCode, first.log).toBe(0);
        const [key] = yield* storeEntries(input);
        yield* fs.remove(path.join(input.cache, "store"), { recursive: true });
        yield* fs.remove(path.join(input.repo, output), { recursive: true });
        const lock = path.join(input.cache, "locks/linux-x64", `${key}.lock`);
        yield* fs.makeDirectory(path.dirname(lock), { recursive: true });
        // This test's process is running, but it started long after the builder that took the lock.
        yield* fs.writeFileString(
          lock,
          JSON.stringify({ pid: process.pid, started: 0, token: "a" }),
        );
        const reused = yield* build(input);
        expect(reused.exitCode, reused.log).toBe(0);
        expect(reused.log).toContain(`process ${process.pid} is another process now`);
        expect(reused.log).toContain("Built executor-collector");
        // The process and its start time match, but the lock was taken two hours ago.
        yield* fs.remove(path.join(input.cache, "store"), { recursive: true });
        yield* fs.remove(path.join(input.repo, output), { recursive: true });
        const started = Math.round(Date.now() - process.uptime() * 1000);
        yield* fs.writeFileString(lock, JSON.stringify({ pid: process.pid, started, token: "b" }));
        const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
        yield* fs.utimes(lock, old, old);
        const aged = yield* build(input);
        expect(aged.exitCode, aged.log).toBe(0);
        expect(aged.log).toContain("minutes ago");
        expect(aged.log).toContain("Built executor-collector");
        expect(yield* locks(input)).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a store this build cannot write is no lock and no failure: it builds and says so",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = yield* repository;
        for (const name of ["store", "locks"]) {
          yield* fs.makeDirectory(path.join(input.cache, name), { recursive: true });
          yield* fs.chmod(path.join(input.cache, name), 0o555);
        }
        const run = yield* build(input).pipe(
          Effect.ensuring(
            Effect.forEach(["store", "locks"], (name) =>
              fs.chmod(path.join(input.cache, name), 0o755),
            ).pipe(Effect.orDie),
          ),
        );
        expect(run.exitCode, run.log).toBe(0);
        expect(run.log).toContain("Cannot take the lock");
        expect(run.log).toContain("cannot be written");
        expect(yield* read(path.join(input.repo, output, "executor-collector"))).toBe(
          "collector build 1\n",
        );
      }).pipe(Effect.scoped),
  );
});
