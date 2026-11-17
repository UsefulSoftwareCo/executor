/**
 * The paths that start the release checks, before and after merge.
 *
 * A pull request runs two short release lanes in CI, which the required `checks / e2e` check
 * covers (`.github/workflows/checks.yml`):
 *
 * - `release-docker` builds the self-host image on amd64 and runs the released-image suite when
 *   the image's source, its build inputs or a file that suite imports changed.
 * - `release-local` packages linux-x64 and runs its install, launcher, lockdown, credential store
 *   and desktop startup checks, without desktop crash recovery, when the CLI's or the desktop
 *   app's source, their build inputs or a packaging path changed.
 *
 * After merge, `.github/workflows/release-check.yml` runs e2e/release-check.ts on every push to
 * main and hourly, which starts the paced check in `.github/workflows/release-artifacts.yml` when a path
 * in `mainPushPaths` changed since the last check: Linux x64 packaging with desktop crash recovery,
 * its installed CLI suite and the image on both architectures, at most every two hours. Build and
 * publishing runs test every platform. Every list here is computed from the checkout when a run
 * needs it, so none is kept by hand and none can fall behind the suites' imports.
 *
 * Each artifact's source is the workspace packages it is built from: its own, and every
 * workspace package those depend on, transitively, read from their package.json files. The CLI
 * bundles `apps/local/server` and serves `apps/local/web`; the desktop app wraps both; the image
 * bundles `apps/hosted/self-host` and its web app. So a change to the server, the SDK or any
 * package they use starts the lane, and one to a package only Cloud uses does not. Each release
 * suite's files are found by following the relative imports of the files its configs run, so a
 * support file joins a lane when one of its spec files imports it, and other support files never
 * start it. Paths are GitHub's glob patterns: `*` within one path segment, `**` across
 * them.
 */
import { packagedEngineInputs, packagedEngineSpecs } from "./packaged-engine.ts";
import { Effect, FileSystem, Path, Schema } from "effect";

class ReleaseLanesFailed extends Schema.TaggedError<ReleaseLanesFailed>()("ReleaseLanesFailed", {
  message: Schema.String,
}) {}

/** The dependencies every artifact installs and the compiler settings it builds with. */
const buildInputs = ["package.json", "bun.lock", "patches/**", "tsconfig.json"] as const;

/** The workspace packages whose dependency closure each artifact is built from. */
const artifactRoots = {
  local: ["apps/cli", "apps/local/server", "apps/local/web", "apps/local/desktop"],
  image: ["apps/hosted/self-host", "apps/hosted/self-host/web"],
} as const;

/**
 * The scripts the packaged CLI, desktop app and install scripts are built with, and what the
 * `release-local` lane's steps read besides its suites (e2e-tools installs their browsers).
 */
const packagingPaths = [
  ".github/actions/setup/**",
  ".github/actions/e2e-tools/**",
  "scripts/releases/**",
  "apps/docs/public/install.*",
  ".github/workflows/bun-runtime.yml",
  "scripts/pack-test-apps.ts",
  // The run's collector job builds or restores the Rust telemetry collector through these; the
  // release-local jobs wait for it and fetch its build before they package it.
  ".github/actions/collector/**",
  ".github/actions/rustup/**",
] as const;

/** Only the matrix after merge reads its own workflow. */
const matrixOnlyPaths = [".github/workflows/release-artifacts.yml"] as const;

/**
 * Workspace packages the suites start at run time rather than import: e2e/sdk/fixtures.ts runs
 * the scenario server in `apps/hosted/testing` for the fixtures the scenarios use.
 */
const harnessRoots = ["apps/hosted/testing"] as const;

/**
 * The installed CLI suite after merge runs `bun run e2e:local` and stages its pinned packages, so
 * the files that command and that script load, and the pins it reads, change its result. Vitest
 * loads the setup file by name. Its spec files are the local scenarios CI's E2E jobs run on source
 * and select themselves, so they are left to CI.
 */
const cliSuiteEntries = [
  "e2e/check-boundary.ts",
  "e2e/run.ts",
  "e2e/vitest.config.ts",
  "e2e/setup.ts",
  "scripts/e2e-npm-packages.ts",
] as const;
const cliSuiteData = ["e2e/npm-packages.json"] as const;

/**
 * What else the image's build reads, besides its workspace packages: the Dockerfile installs with
 * the playground's and the viewer's manifests present, builds the live inbox demo app, and runs
 * Bun with the root bunfig.toml. Then the release identity that names it, and the action that
 * installs its suite's browsers.
 */
const imagePaths = [
  ".github/actions/setup/**",
  ".github/actions/e2e-tools/**",
  ".dockerignore",
  "bunfig.toml",
  "playground/**",
  "e2e/viewer/package.json",
  // The apps package its scenarios deploy is in the image's closure; this packs it for them.
  "scripts/pack-test-apps.ts",
  "scripts/releases/config.ts",
  "scripts/releases/workflow.ts",
  // Pulls the image's base images and builds it in the background of the lane's job.
  "scripts/releases/pull-image-bases.sh",
  "scripts/releases/background.sh",
] as const;

/** The lanes are defined there, so a change to them runs them. Main runs no lane. */
const laneDefinition = ".github/workflows/checks.yml";

/**
 * The configs of each release suite, as literal imports so e2e/check-boundary.ts can check them.
 * `test.include` and `test.globalSetup` start each walk. `local` runs in the `release-local` lane
 * and after merge; `matrix` only after merge (desktop crash recovery, and the PGlite checks on
 * Windows). The installed CLI suite after merge runs the scenarios CI's E2E jobs run on source,
 * which CI already selects.
 */
const suites = {
  docker: { "e2e/docker-release.config.ts": () => import("./docker-release.config.ts") },
  local: {
    "e2e/desktop-release.config.ts": () => import("./desktop-release.config.ts"),
    "e2e/npm-launcher.config.ts": () => import("./npm-launcher.config.ts"),
    "e2e/local-bootstrap.config.ts": () => import("./local-bootstrap.config.ts"),
    "e2e/standalone-lockdown.config.ts": () => import("./standalone-lockdown.config.ts"),
    "e2e/installer.config.ts": () => import("./installer.config.ts"),
  },
  matrix: {
    "e2e/desktop-recovery.config.ts": () => import("./desktop-recovery.config.ts"),
    "e2e/pglite.config.ts": () => import("./pglite.config.ts"),
  },
} as const satisfies Record<string, Record<string, () => Promise<unknown>>>;

/** Every release suite's config, which the release workflows must not run without listing here. */
export const releaseSuiteConfigs: ReadonlyArray<string> = Object.keys({
  ...suites.docker,
  ...suites.local,
  ...suites.matrix,
}).sort();

/**
 * Files the release suites import that cannot change what they do, and why. The released-image
 * suite must still import each, or the selection fails until the exception is removed.
 */
const notSuiteInputs: Readonly<Record<string, string>> = {
  "e2e/test-plan.ts":
    "e2e/report-model.ts imports only its TestPlan schema; the scenario list, which most changes to it edit, never reaches the suites, and `bun run check` typechecks the schema.",
};

const SuiteConfig = Schema.Struct({
  default: Schema.Struct({
    test: Schema.Struct({
      include: Schema.Array(Schema.String),
      globalSetup: Schema.optional(Schema.Array(Schema.String)),
    }),
  }),
});

/** A GitHub path glob as a regular expression over a whole repository path. */
const globExpression = (glob: string) =>
  new RegExp(
    `^${glob
      .split(/(\*\*|\*)/)
      .map((part) =>
        part === "**"
          ? "[\\s\\S]*"
          : part === "*"
            ? "[^/]*"
            : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("")}$`,
  );

/** Whether a repository path matches any of these globs. */
export const matchesAny = (globs: ReadonlyArray<string>, file: string) =>
  globs.some((glob) => globExpression(glob).test(file));

/** Relative module specifiers in a file's text: imports, re-exports and dynamic imports. */
const specifiers = (text: string) =>
  [...text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)].map(
    (match) => match[1]!,
  );

/**
 * Every repository file one suite loads: its configs, the spec files and global setup they name,
 * and each file those import by a relative path, transitively, apart from `notSuiteInputs`. A
 * specifier that resolves to no file, such as one inside an app's source a scenario writes, is not
 * followed.
 */
const suiteFiles = (
  root: string,
  configs: Readonly<Record<string, () => Promise<unknown>>>,
  entries: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const found = new Set<string>();
    const pending: Array<string> = [...entries];
    for (const [config, load] of Object.entries(configs)) {
      const { include, globalSetup = [] } = (yield* Effect.tryPromise({
        try: load,
        catch: (cause) =>
          new ReleaseLanesFailed({ message: `${config} failed to load: ${String(cause)}` }),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(SuiteConfig)),
        Effect.mapError(
          (cause) =>
            new ReleaseLanesFailed({
              message: `${config} must export test.include and test.globalSetup as path lists: ${String(cause)}`,
            }),
        ),
      )).default.test;
      pending.push(config, ...include, ...globalSetup);
    }
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (found.has(file)) continue;
      if (!(yield* fs.exists(path.join(root, file))))
        return yield* new ReleaseLanesFailed({
          message: `A release suite runs ${file}, which does not exist.`,
        });
      found.add(file);
      for (const specifier of specifiers(yield* fs.readFileString(path.join(root, file)))) {
        const base = path.normalize(path.join(path.dirname(file), specifier));
        for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
          const absolute = path.join(root, candidate);
          if ((yield* fs.exists(absolute)) && (yield* fs.stat(absolute)).type === "File") {
            pending.push(candidate);
            break;
          }
        }
      }
    }
    return found;
  });

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);
const Workspaces = Schema.fromJsonString(
  Schema.Struct({ workspaces: Schema.Array(Schema.String) }),
);

/**
 * The workspace package directories these roots are built from: the roots and every workspace
 * package any of them depends on, of any dependency kind, transitively. A dependency on a package
 * outside the workspace is in bun.lock, which `buildInputs` covers.
 */
const workspaceClosure = (root: string, roots: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifest = (directory: string) =>
      fs
        .readFileString(path.join(root, directory, "package.json"))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Manifest)));
    const directories: Array<string> = [];
    for (const pattern of (yield* fs
      .readFileString(path.join(root, "package.json"))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Workspaces)))).workspaces) {
      const candidates = pattern.endsWith("/*")
        ? (yield* fs.readDirectory(path.join(root, pattern.slice(0, -2)))).map(
            (name) => `${pattern.slice(0, -2)}/${name}`,
          )
        : [pattern];
      for (const directory of candidates)
        if (yield* fs.exists(path.join(root, directory, "package.json")))
          directories.push(directory);
    }
    const byName = new Map<string, string>();
    for (const directory of directories) byName.set((yield* manifest(directory)).name, directory);
    const found = new Set<string>();
    const pending = [...roots];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      if (found.has(directory)) continue;
      if (!directories.includes(directory))
        return yield* new ReleaseLanesFailed({
          message: `${directory}, which an artifact is built from, is not a workspace package in package.json. Update artifactRoots in e2e/release-lanes.ts.`,
        });
      found.add(directory);
      const own = yield* manifest(directory);
      for (const dependencies of [
        own.dependencies,
        own.devDependencies,
        own.peerDependencies,
        own.optionalDependencies,
      ])
        for (const name of Object.keys(dependencies ?? {})) {
          const dependency = byName.get(name);
          if (dependency !== undefined) pending.push(dependency);
        }
    }
    return [...found].sort().map((directory) => `${directory}/**`);
  });

/** What each release check is built from and runs, read from this checkout. */
export interface ReleaseSources {
  /** The source of the CLI and the desktop app, as globs over their workspace packages. */
  readonly local: ReadonlyArray<string>;
  /** The source of the self-host image, likewise. */
  readonly image: ReadonlyArray<string>;
  /** The files the released-image suite loads. */
  readonly docker: ReadonlyArray<string>;
  /** The files the packaged CLI and desktop suites of the `release-local` lane load. */
  readonly localSuites: ReadonlyArray<string>;
  /** The files the suites only the matrix after merge runs load. */
  readonly matrixSuites: ReadonlyArray<string>;
  /** The packages the suites start at run time, as globs over their workspace packages. */
  readonly harness: ReadonlyArray<string>;
  /**
   * What the packaged engine's scenarios depend on beyond the rest of the image's suite: the
   * files that make the image's engine differ (e2e/packaged-engine.ts), the scenarios, and the
   * files only they import.
   */
  readonly packagedEngine: ReadonlyArray<string>;
}

export const releaseSources = Effect.gen(function* () {
  const path = yield* Path.Path;
  // The checkout this module is in, so a copy of it reads the copy's files.
  const root = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))));
  const docker = yield* suiteFiles(root, suites.docker);
  const stale = Object.keys(notSuiteInputs).filter((file) => !docker.has(file));
  if (stale.length > 0)
    return yield* new ReleaseLanesFailed({
      message: `notSuiteInputs in e2e/release-lanes.ts lists files the released-image suite no longer imports: ${stale.join(", ")}. Remove them.`,
    });
  const inputs = (files: ReadonlySet<string>) =>
    [...files].filter((file) => !(file in notSuiteInputs)).sort();
  // The files only the packaged engine's scenarios import: theirs, less what the rest of the
  // image's suite (its other spec files, config and setup) imports.
  const engineScenarios = yield* suiteFiles(root, {}, packagedEngineSpecs);
  const rest = yield* suiteFiles(root, {}, [
    ...Object.keys(suites.docker),
    "e2e/docker-release-networks.ts",
    ...[...docker].filter(
      (file) =>
        file.startsWith("e2e/tests/") &&
        !(packagedEngineSpecs as ReadonlyArray<string>).includes(file),
    ),
  ]);
  return {
    packagedEngine: [
      ...new Set([
        ...packagedEngineInputs,
        ...[...engineScenarios].filter((file) => !rest.has(file)),
      ]),
    ].sort(),
    local: yield* workspaceClosure(root, artifactRoots.local),
    image: yield* workspaceClosure(root, artifactRoots.image),
    docker: inputs(docker),
    localSuites: inputs(yield* suiteFiles(root, suites.local)),
    matrixSuites: inputs(yield* suiteFiles(root, suites.matrix, cliSuiteEntries)),
    harness: yield* workspaceClosure(root, harnessRoots),
  } satisfies ReleaseSources;
});

/** The paths that start each lane on a pull request. */
export const lanePaths = (sources: ReleaseSources) => ({
  "release-docker": [
    ...new Set([
      ...buildInputs,
      ...sources.image,
      ...imagePaths,
      ...sources.docker,
      ...sources.harness,
      laneDefinition,
    ]),
  ],
  "release-local": [
    ...new Set([
      ...buildInputs,
      ...sources.local,
      ...packagingPaths,
      ...sources.localSuites,
      ...sources.harness,
      laneDefinition,
    ]),
  ],
});

/** The files that start each lane among a pull request's changed files. */
export const lanesFor = (sources: ReleaseSources, changed: ReadonlyArray<string>) => {
  const paths = lanePaths(sources);
  const matching = (globs: ReadonlyArray<string>) =>
    changed.filter((file) => matchesAny(globs, file));
  return {
    "release-docker": matching(paths["release-docker"]),
    "release-local": matching(paths["release-local"]),
    /** Of those, the files that also start the packaged engine's scenarios. */
    "release-docker-engine": matching(sources.packagedEngine),
  };
};

/** What any release check builds or runs: a push that changes one of these needs the paced check. */
export const mainPushPaths = (sources: ReleaseSources) => [
  ...new Set([
    ...buildInputs,
    ...sources.local,
    ...sources.image,
    ...packagingPaths,
    ...sources.localSuites,
    ...matrixOnlyPaths,
    ...sources.matrixSuites,
    ...cliSuiteData,
    ...sources.harness,
    // The installed CLI suite's OAuth scenarios start this issuer.
    "e2e/support/oauth-setup-issuer.ts",
    ...imagePaths,
    ...sources.docker,
  ]),
];
