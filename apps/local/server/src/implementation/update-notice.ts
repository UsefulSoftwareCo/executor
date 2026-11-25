import {
  defaultNpmRegistry,
  distTagsPath,
  newerRelease,
  releaseChannel,
  releasesFromDistTags,
  ReleaseVersion,
} from "@executor-js/utils/release-version";
import { Clock, Config, Console, Duration, Effect, FileSystem, Option, Path, Schema } from "effect";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { HttpClient, HttpClientResponse } from "effect/http";

const checkInterval = Duration.days(1);
const requestTimeout = Duration.seconds(5);

const LastCheck = Schema.fromJsonString(
  Schema.Struct({
    checkedAt: Schema.Number,
    beta: Schema.optional(ReleaseVersion),
    latest: Schema.optional(ReleaseVersion),
  }),
);
type LastCheck = typeof LastCheck.Type;

export const GlobalInstaller = Schema.Literals(["npm", "pnpm", "bun", "yarn"]);
export type GlobalInstaller = typeof GlobalInstaller.Type;
export type OneShotRunner = "npx" | "bunx" | "pnpm dlx";
export type InstallMethod = GlobalInstaller | OneShotRunner | "standalone" | "brew" | "unknown";

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
  if (/\/(lib|npm)\/node_modules\/executor\//u.test(file)) return "npm";
  return "unknown";
};

export const installMethod = (entry: string | undefined) =>
  Effect.gen(function* () {
    if (entry === undefined) return "unknown" as const;
    const fs = yield* FileSystem.FileSystem;
    const real = yield* fs.realPath(entry).pipe(Effect.orElseSucceed(() => entry));
    return classify(real);
  });

export const isOneShot = (method: InstallMethod): method is OneShotRunner =>
  method === "npx" || method === "bunx" || method === "pnpm dlx";

const updateCommand = (method: InstallMethod, version: typeof ReleaseVersion.Type) =>
  isOneShot(method)
    ? `Run it with: ${method} executor@${releaseChannel(version)}`
    : method === "brew"
      ? `Run: brew upgrade ${releaseChannel(version) === "beta" ? "executor-beta" : "executor"}`
      : "Run: executor upgrade";

export const npmRegistry = Config.String("EXECUTOR_NPM_REGISTRY").pipe(
  Config.withDefault(defaultNpmRegistry),
  Config.map((registry) => registry.replace(/\/+$/u, "")),
);

export const fetchReleases = (timeout: Duration.Input) =>
  Effect.gen(function* () {
    const registry = yield* npmRegistry;
    const tags = yield* HttpClient.get(`${registry}${distTagsPath}`).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(timeout),
      Effect.provide(NodeHttpClient.layerNodeHttp),
    );
    return releasesFromDistTags(tags);
  });

export const currentRelease = Config.schema(ReleaseVersion, "EXECUTOR_BUILD_VERSION").pipe(
  Config.option,
);
const checksDisabled = Config.Boolean("EXECUTOR_NO_UPDATE_CHECK").pipe(Config.withDefault(false));

export const outdatedCli = (entry: string | undefined) =>
  Effect.gen(function* () {
    const current = yield* currentRelease;
    if (Option.isNone(current) || (yield* checksDisabled)) return undefined;
    const newer = newerRelease(current.value, yield* fetchReleases(Duration.seconds(2)));
    if (newer === undefined) return undefined;
    return `This CLI (v${current.value}) is out of date; the latest is v${newer}. ${updateCommand(yield* installMethod(entry), newer)}`;
  }).pipe(Effect.orElseSucceed(() => undefined));

export const updateNotice = (directory: string, entry: string | undefined) =>
  Effect.gen(function* () {
    const current = yield* currentRelease;
    const disabled = yield* checksDisabled;
    const ci = yield* Config.String("CI").pipe(Config.option);
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
