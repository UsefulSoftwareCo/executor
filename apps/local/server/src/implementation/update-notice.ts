/**
 * Tell a person running the CLI that a newer release is on its channel, and how this copy was
 * installed. It only reports; `executor upgrade` installs on request. The desktop app updates itself.
 */
import {
  compareReleaseVersions,
  releaseChannel,
  ReleaseVersion,
} from "@executor-js/utils/release-version";
import { Clock, Config, Console, Duration, Effect, FileSystem, Option, Path, Schema } from "effect";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { HttpClient, HttpClientResponse } from "effect/http";

const checkInterval = Duration.days(1);
const requestTimeout = Duration.seconds(5);

// npm `latest` still names Executor 1 until the v2 stable cutover, so non-v2 tags are ignored.
const DistTags = Schema.Record(Schema.String, Schema.Unknown);
const LastCheck = Schema.fromJsonString(
  Schema.Struct({
    checkedAt: Schema.Number,
    beta: Schema.optional(ReleaseVersion),
    latest: Schema.optional(ReleaseVersion),
  }),
);
type LastCheck = typeof LastCheck.Type;

/** Package managers whose global install replaces this copy; `executor upgrade` runs them. */
export const GlobalInstaller = Schema.Literals(["npm", "pnpm", "bun", "yarn"]);
export type GlobalInstaller = typeof GlobalInstaller.Type;
/** Runners that fetch the release each time instead of keeping an installed copy. */
export type OneShotRunner = "npx" | "bunx" | "pnpm dlx";
/**
 * How this copy was installed: a package manager, a one-shot runner, the install script's
 * standalone layout, or Homebrew. `unknown` when its location matches none of them.
 */
export type InstallMethod = GlobalInstaller | OneShotRunner | "standalone" | "brew" | "unknown";

/** Classify a CLI file's location by the directory layout each package manager uses. */
const classify = (location: string): InstallMethod => {
  const file = location.replaceAll("\\", "/").toLowerCase();
  if (/\/runtime\/versions\/[^/]+\/executor(?:\.exe)?$/u.test(file)) return "standalone";
  if (/\/cellar\/executor(?:-beta)?\//u.test(file)) return "brew";
  if (file.includes("/_npx/")) return "npx";
  if (/\/bunx-[^/]*executor@/u.test(file)) return "bunx";
  if (file.includes("/dlx/") && file.includes("/.pnpm/")) return "pnpm dlx";
  if (file.includes("/install/global/node_modules/")) return "bun";
  if (file.includes("/.pnpm/")) return "pnpm";
  if (/\/yarn\/(data\/)?global\/node_modules\//u.test(file)) return "yarn";
  // npm's global prefix: lib/node_modules on macOS and Linux, npm/node_modules on Windows.
  if (/\/(lib|npm)\/node_modules\/executor\//u.test(file)) return "npm";
  return "unknown";
};

/**
 * How the running CLI was installed, read from the file that started it: the npm launcher, the
 * release executable, or the script Node started. Command shims are often symlinks into the
 * package, so the real path is the one that shows the layout.
 */
export const installMethod = (entry: string | undefined) =>
  Effect.gen(function* () {
    if (entry === undefined) return "unknown" as const;
    const fs = yield* FileSystem.FileSystem;
    const real = yield* fs.realPath(entry).pipe(Effect.orElseSucceed(() => entry));
    return classify(real);
  });

export const isOneShot = (method: InstallMethod): method is OneShotRunner =>
  method === "npx" || method === "bunx" || method === "pnpm dlx";

/** What to tell a person whose CLI is older than `version`. */
const updateCommand = (method: InstallMethod, version: typeof ReleaseVersion.Type) =>
  isOneShot(method)
    ? `Run it with: ${method} executor@${releaseChannel(version)}`
    : method === "brew"
      ? `Run: brew upgrade ${releaseChannel(version) === "beta" ? "executor-beta" : "executor"}`
      : "Run: executor upgrade";

const releaseTag = (tags: typeof DistTags.Type, name: string) =>
  Schema.decodeUnknownOption(ReleaseVersion)(tags[name]).pipe(Option.getOrUndefined);

/** The registry Executor reads releases from. `EXECUTOR_NPM_REGISTRY` names a registry mirror. */
export const npmRegistry = Config.String("EXECUTOR_NPM_REGISTRY").pipe(
  Config.withDefault("https://registry.npmjs.org"),
  Config.map((registry) => registry.replace(/\/+$/u, "")),
);

/** Read the npm `beta` and `latest` tags. */
export const fetchReleases = (timeout: Duration.Input) =>
  Effect.gen(function* () {
    const registry = yield* npmRegistry;
    const tags = yield* HttpClient.get(`${registry}/-/package/executor/dist-tags`).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(DistTags)),
      Effect.timeout(timeout),
      // node:http destroys an unanswered connection on timeout; an aborted fetch keeps the
      // process alive until the operating system gives up on connecting.
      Effect.provide(NodeHttpClient.layerNodeHttp),
    );
    return { beta: releaseTag(tags, "beta"), latest: releaseTag(tags, "latest") };
  });

/** The newest release this installation should move to, if any. */
export const newerRelease = (
  current: typeof ReleaseVersion.Type,
  known: {
    readonly beta?: typeof ReleaseVersion.Type | undefined;
    readonly latest?: typeof ReleaseVersion.Type | undefined;
  },
) => {
  // Beta installs move to stable once it is newer; stable installs never move to beta.
  const candidates =
    releaseChannel(current) === "beta" ? [known.latest, known.beta] : [known.latest];
  const [newer] = candidates
    .filter((version) => version !== undefined)
    .filter((version) => compareReleaseVersions(version, current) > 0)
    .sort((left, right) => compareReleaseVersions(right, left));
  return newer;
};

/** This build's release version, or none for development and commit builds. */
export const currentRelease = Config.schema(ReleaseVersion, "EXECUTOR_BUILD_VERSION").pipe(
  Config.option,
);
const checksDisabled = Config.Boolean("EXECUTOR_NO_UPDATE_CHECK").pipe(Config.withDefault(false));

/**
 * When a command has failed, say so if this CLI is older than the newest release: an old CLI is a
 * common cause. The lookup waits at most two seconds and never fails; undefined when the CLI is
 * current, checks are off, or the registry does not answer in time.
 */
export const outdatedCli = (entry: string | undefined) =>
  Effect.gen(function* () {
    const current = yield* currentRelease;
    if (Option.isNone(current) || (yield* checksDisabled)) return undefined;
    const newer = newerRelease(current.value, yield* fetchReleases(Duration.seconds(2)));
    if (newer === undefined) return undefined;
    return `This CLI (v${current.value}) is out of date; the latest is v${newer}. ${updateCommand(yield* installMethod(entry), newer)}`;
  }).pipe(Effect.orElseSucceed(() => undefined));

/** Check at most daily, remember the answer in the data directory, and never delay or fail startup. */
export const updateNotice = (directory: string, entry: string | undefined) =>
  Effect.gen(function* () {
    const current = yield* currentRelease;
    const disabled = yield* checksDisabled;
    const ci = yield* Config.String("CI").pipe(Config.option);
    // Development and commit builds have no release version to compare.
    if (Option.isNone(current) || disabled || Option.isSome(ci)) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(directory, "update-check.json");
    const now = yield* Clock.currentTimeMillis;
    const saved = yield* fs
      .readFileString(file)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(LastCheck)), Effect.option);
    const known: LastCheck =
      Option.isSome(saved) && now - saved.value.checkedAt < Duration.toMillis(checkInterval)
        ? saved.value
        : yield* fetchReleases(requestTimeout).pipe(
            Effect.map((tags) => ({ checkedAt: now, ...tags })),
            Effect.tap((check) => fs.writeFileString(file, Schema.encodeSync(LastCheck)(check))),
          );
    const newer = newerRelease(current.value, known);
    if (newer === undefined) return;
    yield* Console.error(
      `Executor ${newer} is available. ${updateCommand(yield* installMethod(entry), newer)}`,
    );
  }).pipe(Effect.ignore);
