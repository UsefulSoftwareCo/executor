import { packagedEngineInputs, packagedEngineSpecs } from "./packaged-engine.ts";
import { Effect, FileSystem, Path, Schema } from "effect";

class ReleaseLanesFailed extends Schema.TaggedError<ReleaseLanesFailed>()("ReleaseLanesFailed", {
  message: Schema.String,
}) {}

const buildInputs = ["package.json", "bun.lock", "patches/**", "tsconfig.json"] as const;

const artifactRoots = {
  local: ["apps/cli", "apps/local/server", "apps/local/web", "apps/local/desktop"],
  image: ["apps/hosted/self-host", "apps/hosted/self-host/web"],
} as const;

const packagingPaths = [
  ".github/actions/setup/**",
  ".github/actions/e2e-tools/**",
  "scripts/releases/**",
  "apps/docs/public/install.*",
  ".github/workflows/bun-runtime.yml",
  "scripts/pack-test-apps.ts",
  ".github/actions/collector/**",
  ".github/actions/rustup/**",
] as const;

const matrixOnlyPaths = [".github/workflows/release-artifacts.yml"] as const;

const harnessRoots = ["apps/hosted/testing"] as const;

const cliSuiteEntries = [
  "e2e/check-boundary.ts",
  "e2e/run.ts",
  "e2e/vitest.config.ts",
  "e2e/setup.ts",
  "scripts/e2e-npm-packages.ts",
] as const;
const cliSuiteData = ["e2e/npm-packages.json"] as const;

const imagePaths = [
  ".github/actions/setup/**",
  ".github/actions/e2e-tools/**",
  ".dockerignore",
  "bunfig.toml",
  "playground/**",
  "e2e/viewer/package.json",
  "scripts/pack-test-apps.ts",
  "scripts/releases/config.ts",
  "scripts/releases/workflow.ts",
  "scripts/releases/pull-image-bases.sh",
  "scripts/releases/background.sh",
] as const;

const laneDefinition = ".github/workflows/checks.yml";

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

export const releaseSuiteConfigs: ReadonlyArray<string> = Object.keys({
  ...suites.docker,
  ...suites.local,
  ...suites.matrix,
}).sort();

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

export const matchesAny = (globs: ReadonlyArray<string>, file: string) =>
  globs.some((glob) => globExpression(glob).test(file));

const specifiers = (text: string) =>
  [...text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)].map(
    (match) => match[1]!,
  );

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

export const shippedSources = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))));
  return {
    local: yield* workspaceClosure(root, artifactRoots.local),
    image: yield* workspaceClosure(root, artifactRoots.image),
  };
});

export interface ReleaseSources {
  readonly local: ReadonlyArray<string>;
  readonly image: ReadonlyArray<string>;
  readonly docker: ReadonlyArray<string>;
  readonly localSuites: ReadonlyArray<string>;
  readonly matrixSuites: ReadonlyArray<string>;
  readonly harness: ReadonlyArray<string>;
  readonly packagedEngine: ReadonlyArray<string>;
}

export const releaseSources = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))));
  const docker = yield* suiteFiles(root, suites.docker);
  const stale = Object.keys(notSuiteInputs).filter((file) => !docker.has(file));
  if (stale.length > 0)
    return yield* new ReleaseLanesFailed({
      message: `notSuiteInputs in e2e/release-lanes.ts lists files the released-image suite no longer imports: ${stale.join(", ")}. Remove them.`,
    });
  const inputs = (files: ReadonlySet<string>) =>
    [...files].filter((file) => !(file in notSuiteInputs)).sort();
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

export const lanesFor = (sources: ReleaseSources, changed: ReadonlyArray<string>) => {
  const paths = lanePaths(sources);
  const matching = (globs: ReadonlyArray<string>) =>
    changed.filter((file) => matchesAny(globs, file));
  return {
    "release-docker": matching(paths["release-docker"]),
    "release-local": matching(paths["release-local"]),
    "release-docker-engine": matching(sources.packagedEngine),
  };
};

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
    "e2e/support/oauth-setup-issuer.ts",
    ...imagePaths,
    ...sources.docker,
  ]),
];
