import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const unreachable = "1000000000";

const run = (
  command: string,
  args: ReadonlyArray<string>,
  options: { cwd?: string; env?: Record<string, string> } = {},
) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make(command, args, {
        cwd: options.cwd,
        env: options.env ?? {},
        extendEnv: true,
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { exitCode, output: `${stdout}${stderr}` };
  }).pipe(Effect.scoped);

const listing = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(directory))) return [];
    return (yield* fs.readDirectory(directory)).toSorted();
  });

const freeGb = (directory: string) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const text = yield* processes.string(ChildProcess.make("df", ["-Pk", directory]));
    return (Number(text.trim().split("\n").at(-1)?.split(/\s+/)[3]) * 1024) / 1e9;
  });

const Manifest = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

const otherPlatform = process.platform === "linux" ? "darwin" : "linux";
const kind = `${process.platform}-${process.arch}`;

const releases = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { version } = yield* fs
    .readFileString(path.resolve("apps/cli/package.json"))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Manifest)));
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-local-disk-" });
  const workspace = path.join(root, "workspace");
  const builds = path.join(workspace, ".local/releases");
  const outside = path.join(root, "outside");
  const sibling = path.join(root, "sibling/.local/releases", `0.0.1-${kind}`);
  const names = {
    current: `${version}-${kind}`,
    old: `0.0.1-${kind}`,
    oldWithLink: `0.0.2-${kind}`,
    held: `0.0.3-${kind}`,
    otherPlatform: `0.0.1-${otherPlatform}-${process.arch}`,
    link: `0.0.4-${kind}`,
    wrapper: "0.0.1",
    sources: "sources",
    log: "desktop-test.log",
  };
  for (const directory of [
    names.current,
    names.old,
    names.oldWithLink,
    names.held,
    names.otherPlatform,
    `${names.wrapper}/wrapper`,
    names.sources,
  ]) {
    yield* fs.makeDirectory(path.join(builds, directory, "package"), { recursive: true });
    yield* fs.writeFileString(path.join(builds, directory, "package/bin.mjs"), "build\n");
  }
  yield* fs.writeFileString(path.join(builds, names.log), "log\n");
  yield* fs.makeDirectory(outside, { recursive: true });
  yield* fs.writeFileString(path.join(outside, "keep.txt"), "outside\n");
  yield* fs.symlink(outside, path.join(builds, names.oldWithLink, "link"));
  yield* fs.symlink(outside, path.join(builds, names.link));
  yield* fs.makeDirectory(sibling, { recursive: true });
  yield* fs.writeFileString(path.join(sibling, "bin.mjs"), "build\n");
  return { root, workspace, builds, outside, sibling, names };
});

const prune = (workspace: string, env: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* run("node", [path.resolve("scripts/releases/prune-builds.ts")], {
      cwd: workspace,
      env: { CI: "", ...env },
    });
  });

layer(NodeServices.layer, { excludeTestServices: true })("local disk guards", (it) => {
  for (const script of ["e2e:local", "e2e:self-host", "release:cli", "release:desktop"])
    it.effect(`bun run ${script} refuses to start below the floor and writes nothing`, () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const watched = [".local/e2e", ".local/releases"].map((folder) => path.resolve(folder));
        const before = yield* Effect.forEach(watched, listing);
        const { exitCode, output } = yield* run(
          "bun",
          ["run", script, "--test-name", "^no scenario has this name$"],
          { env: { CI: "true", EXECUTOR_DISK_FLOOR_GB: unreachable } },
        );
        expect(exitCode).not.toBe(0);
        const own = output
          .trim()
          .split("\n")
          .filter((line) => !line.startsWith("$ ") && !line.startsWith("error: script "));
        expect(own).toHaveLength(1);
        expect(own[0]).toMatch(
          new RegExp(
            `^${script}: not started: \\d+\\.\\d GB free on the disk holding .+, below the ${unreachable} GB floor\\. .*set EXECUTOR_DISK_FLOOR_GB=0 to start anyway\\.$`,
          ),
        );
        expect(yield* Effect.forEach(watched, listing)).toEqual(before);
      }),
    );

  it.effect("the floor is off at 0, and a value that is not a number refuses", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const floor = path.resolve("scripts/disk-floor.ts");
      const off = yield* run("node", [floor, "e2e:local"], {
        env: { CI: "", EXECUTOR_DISK_FLOOR_GB: "0" },
      });
      expect(off).toEqual({ exitCode: 0, output: "" });
      const garbled = yield* run("node", [floor, "e2e:local"], {
        env: { CI: "", EXECUTOR_DISK_FLOOR_GB: "lots" },
      });
      expect(garbled.exitCode).not.toBe(0);
      expect(garbled.output.trim()).toBe(
        'e2e:local: not started: EXECUTOR_DISK_FLOOR_GB is "lots"; give a number of GB, or 0 to turn the floor off.',
      );
    }),
  );

  it.effect("in CI the default floor does not apply; outside CI it is 20 GB", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const floor = path.resolve("scripts/disk-floor.ts");
      const ci = yield* run("node", [floor, "e2e:local"], {
        env: { CI: "true", EXECUTOR_DISK_FLOOR_GB: "" },
      });
      expect(ci).toEqual({ exitCode: 0, output: "" });
      const free = yield* freeGb(process.cwd());
      const workstation = yield* run("node", [floor, "e2e:local"], {
        env: { CI: "", EXECUTOR_DISK_FLOOR_GB: "" },
      });
      if (free < 20) expect(workstation.output).toContain("below the 20 GB floor");
      else expect(workstation).toEqual({ exitCode: 0, output: "" });
    }),
  );

  it.effect(
    "release:cli removes this platform's builds at other versions and nothing else in or outside the workspace",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = yield* releases;
        const n = input.names;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const holder = yield* processes.spawn(
          ChildProcess.make("sleep", ["60"], { cwd: path.join(input.builds, n.held) }),
        );
        const { exitCode, output } = yield* prune(input.workspace);
        yield* holder.kill();
        expect(exitCode).toBe(0);
        expect(yield* listing(input.builds)).toEqual(
          [n.current, n.held, n.otherPlatform, n.link, n.wrapper, n.sources, n.log].toSorted(),
        );
        expect(output).toContain(`release: kept ${n.held}: a running process has it open.`);
        expect(output).toMatch(
          new RegExp(`release: removed 2 old ${kind} builds \\(\\d+ MB freed\\) from `),
        );
        expect(yield* fs.readFileString(path.join(input.outside, "keep.txt"))).toBe("outside\n");
        expect(yield* fs.readLink(path.join(input.builds, n.link))).toBe(input.outside);
        expect(yield* fs.readFileString(path.join(input.sibling, "bin.mjs"))).toBe("build\n");
      }).pipe(Effect.scoped),
  );

  it.effect("in CI release:cli removes no build", () =>
    Effect.gen(function* () {
      const input = yield* releases;
      const before = yield* listing(input.builds);
      const { exitCode, output } = yield* prune(input.workspace, { CI: "true" });
      expect(exitCode).toBe(0);
      expect(output).toBe("");
      expect(yield* listing(input.builds)).toEqual(before);
    }),
  );

  it.effect("release:cli removes no build when .local/releases is a link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* releases;
      const moved = path.join(input.root, "moved-releases");
      yield* fs.rename(input.builds, moved);
      yield* fs.symlink(moved, input.builds);
      const before = yield* listing(moved);
      const { exitCode, output } = yield* prune(input.workspace);
      expect(exitCode).toBe(0);
      expect(output).toContain("is or is under a symbolic link");
      expect(yield* listing(moved)).toEqual(before);
    }),
  );
});
