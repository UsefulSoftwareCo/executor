/** Prepare pinned Git sources beside binary releases. Does not publish or execute upstream code. */
import { createHash } from "node:crypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const dugiteVersion = "3.2.3";
const nativeVersion = "v2.53.0-4";
const sources = [
  {
    name: "dugite-native",
    repository: "desktop/dugite-native",
    revision: "4098283a7ecb8a227b9d43580336c78a06f90e5d",
    sha256: "88ca6b778c3daac6c58bb760cd41099b1f348b07ef3d8daf551269a142bccb5f",
  },
  {
    name: "git",
    repository: "git/git",
    revision: "67ad42147a7acc2af6074753ebd03d904476118f",
    sha256: "89b73762be55037144c92eaf5d0657b644330770f66c584c1ba2e7b90b6218cf",
  },
  {
    name: "git-for-windows",
    repository: "git-for-windows/git",
    revision: "3a9e66c3d66bb6509be99fe21c3205f024c04568",
    sha256: "986f8017f5a5246fe1fef718e505404cc4cb3e7e4a8ea2fab4b65f5d31452679",
  },
  {
    name: "git-lfs",
    repository: "git-lfs/git-lfs",
    revision: "b84b33847fe6458f36ef521534dc0eac953cb379",
    sha256: "e1ef5ba4828fa632337be6a2c421a685432faec0405bf187f46a1459e82a9a62",
  },
];

const PackageVersion = Schema.Struct({ name: Schema.String, version: Schema.String });
const Archive = Schema.Struct({
  file: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.+~-]*$/)),
  url: Schema.String,
  sha256: Schema.String,
});
const GitLfsModules = Schema.NonEmptyArray(
  Schema.Struct({
    ...Archive.fields,
    module: Schema.String,
    version: Schema.String,
    goSum: Schema.String,
  }),
);
const WindowsSources = Schema.Struct({
  binary: Schema.Struct({
    platform: Schema.Literal("win32-x64"),
    url: Schema.String,
    sha256: Schema.String,
    packages: Schema.NonEmptyArray(PackageVersion),
  }),
  sources: Schema.NonEmptyArray(
    Schema.Struct({
      ...Archive.fields,
      packages: Schema.NonEmptyArray(PackageVersion),
    }),
  ),
});

class SourceArchiveFailed extends Schema.TaggedError<SourceArchiveFailed>()("SourceArchiveFailed", {
  stage: Schema.Literals(["binary-version", "inventory", "checksum", "archive"]),
  file: Schema.optional(Schema.String),
}) {
  override get message() {
    return `Git source archive failed at ${this.stage}${this.file === undefined ? "" : `: ${this.file}`}.`;
  }
}

const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const root = yield* path.fromFileUrl(new URL("../../", import.meta.url));
  // Changing the bundled binary requires an explicit review of its matching sources.
  yield* fs.readFileString(path.join(root, "package.json")).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            devDependencies: Schema.Struct({ dugite: Schema.Literal(dugiteVersion) }),
          }),
        ),
      ),
    ),
  );
  const embedded = yield* fs
    .readFileString(path.join(root, "node_modules/dugite/script/embedded-git.json"))
    .pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Record(
              Schema.String,
              Schema.Struct({ url: Schema.String, checksum: Schema.String }),
            ),
          ),
        ),
      ),
    );
  if (
    Object.keys(embedded).length === 0 ||
    Object.values(embedded).some(
      ({ url }) =>
        !url.startsWith(
          `https://github.com/desktop/dugite-native/releases/download/${nativeVersion}/`,
        ),
    )
  )
    return yield* new SourceArchiveFailed({ stage: "binary-version" });

  const windows = yield* fs
    .readFileString(path.join(root, "scripts/releases/licenses/windows-git-sources.json"))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(WindowsSources))));
  const binary = embedded[windows.binary.platform];
  if (binary?.url !== windows.binary.url || binary.checksum !== windows.binary.sha256)
    return yield* new SourceArchiveFailed({ stage: "binary-version" });
  const inventory = new Map(windows.binary.packages.map(({ name, version }) => [name, version]));
  const provided = windows.sources.flatMap(({ packages }) => packages);
  if (
    inventory.size !== windows.binary.packages.length ||
    provided.length !== inventory.size ||
    new Set(provided.map(({ name }) => name)).size !== inventory.size ||
    provided.some(({ name, version }) => inventory.get(name) !== version) ||
    new Set(windows.sources.map(({ file }) => file)).size !== windows.sources.length
  )
    return yield* new SourceArchiveFailed({ stage: "inventory" });

  const output = path.join(root, ".local/releases/sources");
  yield* fs.makeDirectory(output, { recursive: true });
  const stage = yield* fs.makeTempDirectoryScoped({ prefix: "executor-git-sources-" });
  const downloadArchive = (source: typeof Archive.Type, directory: string) =>
    Effect.gen(function* () {
      const response = yield* http.get(source.url);
      const bytes = new Uint8Array(yield* response.arrayBuffer);
      if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
        return yield* new SourceArchiveFailed({ stage: "checksum", file: source.file });
      yield* fs.writeFile(path.join(directory, source.file), bytes);
      yield* Console.log(`Verified source: ${source.file}`);
    });
  for (const source of sources) {
    yield* downloadArchive(
      {
        file: `${source.name}.tar.gz`,
        url: `https://codeload.github.com/${source.repository}/tar.gz/${source.revision}`,
        sha256: source.sha256,
      },
      stage,
    );
  }
  const windowsDirectory = path.join(stage, "windows");
  yield* fs.makeDirectory(windowsDirectory);
  yield* Effect.forEach(windows.sources, (source) => downloadArchive(source, windowsDirectory), {
    concurrency: 3,
    discard: true,
  });
  const gitLfsModules = yield* fs
    .readFileString(path.join(root, "scripts/releases/licenses/git-lfs-sources.json"))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(GitLfsModules))));
  const modulesDirectory = path.join(stage, "git-lfs-modules");
  yield* fs.makeDirectory(modulesDirectory);
  yield* Effect.forEach(gitLfsModules, (source) => downloadArchive(source, modulesDirectory), {
    concurrency: 3,
    discard: true,
  });
  yield* fs.writeFileString(
    path.join(stage, "manifest.json"),
    JSON.stringify(
      {
        dugite: dugiteVersion,
        native: nativeVersion,
        sources,
        windows,
        gitLfsModules,
      },
      null,
      2,
    ),
  );
  yield* fs.copyFile(
    path.join(root, "scripts/releases/licenses/git-sources.md"),
    path.join(stage, "README.md"),
  );
  yield* fs.copyFile(
    path.join(root, "scripts/releases/licenses/git-lfs-notices.txt"),
    path.join(stage, "git-lfs-notices.txt"),
  );
  const archive = path.join(output, `executor-git-sources-dugite-${dugiteVersion}.tar.gz`);
  const result = yield* processes.exitCode(
    ChildProcess.make("tar", ["-czf", archive, "-C", stage, "."], {
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  if (result !== 0) return yield* new SourceArchiveFailed({ stage: "archive" });
  const checksum = createHash("sha256");
  yield* fs.stream(archive).pipe(
    Stream.runForEach((bytes) =>
      Effect.sync(() => {
        checksum.update(bytes);
      }),
    ),
  );
  const hash = checksum.digest("hex");
  yield* fs.writeFileString(`${archive}.sha256`, `${hash}  ${path.basename(archive)}\n`);
  yield* Console.log(`Git source archive: ${archive}`);
});

NodeRuntime.runMain(
  Effect.scoped(build).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);
