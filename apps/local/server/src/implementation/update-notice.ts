/**
 * Tell a person running the npm CLI that a newer release is on its channel.
 * It only reports; npm owns installation. The desktop app updates itself.
 */
import {
  compareReleaseVersions,
  releaseChannel,
  ReleaseVersion,
} from "@executor-js/utils/release-version";
import { Clock, Config, Console, Duration, Effect, FileSystem, Option, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

const registry = "https://registry.npmjs.org/-/package/executor/dist-tags";
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

// Global installs replace the copy; one-shot runners fetch the tag again.
const installs = {
  npm: "npm i -g",
  bun: "bun add -g",
  pnpm: "pnpm add -g",
  yarn: "yarn global add",
  npx: "npx",
  bunx: "bunx",
  "pnpm dlx": "pnpm dlx",
} as const;

/** How this copy was installed, read from where its files live. Anything else is npm. */
const installer = (location: string): keyof typeof installs => {
  const file = location.replaceAll("\\", "/").toLowerCase();
  if (file.includes("/_npx/")) return "npx";
  if (/\/bunx-[^/]*executor@/.test(file)) return "bunx";
  if (file.includes("/dlx/") && file.includes("/.pnpm/")) return "pnpm dlx";
  if (file.includes("/install/global/node_modules/")) return "bun";
  if (file.includes("/.pnpm/")) return "pnpm";
  if (/\/yarn\/(data\/)?global\/node_modules\//.test(file)) return "yarn";
  return "npm";
};

/** The command that moves this installation to `version` with the tool it already uses. */
const updateCommand = (location: string | undefined, version: typeof ReleaseVersion.Type) => {
  const method = location === undefined ? "npm" : installer(location);
  const tag = releaseChannel(version);
  const oneShot = method === "npx" || method === "bunx" || method === "pnpm dlx";
  return oneShot
    ? `Run it with: ${installs[method]} executor@${tag}`
    : `Update with: ${installs[method]} executor${tag === "beta" ? "@beta" : ""}`;
};

const releaseTag = (tags: typeof DistTags.Type, name: string) =>
  Schema.decodeUnknownOption(ReleaseVersion)(tags[name]).pipe(Option.getOrUndefined);

/** Check at most daily, remember the answer in the data directory, and never delay or fail startup. */
export const updateNotice = (directory: string, installation: string | undefined) =>
  Effect.gen(function* () {
    const current = yield* Config.schema(ReleaseVersion, "EXECUTOR_BUILD_VERSION").pipe(
      Config.option,
    );
    const disabled = yield* Config.Boolean("EXECUTOR_NO_UPDATE_CHECK").pipe(
      Config.withDefault(false),
    );
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
        : yield* HttpClient.get(registry).pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap((response) => response.json),
            Effect.flatMap(Schema.decodeUnknownEffect(DistTags)),
            Effect.timeout(requestTimeout),
            Effect.map((tags) => ({
              checkedAt: now,
              beta: releaseTag(tags, "beta"),
              latest: releaseTag(tags, "latest"),
            })),
            Effect.tap((check) => fs.writeFileString(file, Schema.encodeSync(LastCheck)(check))),
            Effect.provide(FetchHttpClient.layer),
          );
    // Beta installs move to stable once it is newer; stable installs never move to beta.
    const candidates =
      releaseChannel(current.value) === "beta" ? [known.latest, known.beta] : [known.latest];
    const [newer] = candidates
      .filter((version) => version !== undefined)
      .filter((version) => compareReleaseVersions(version, current.value) > 0)
      .sort((left, right) => compareReleaseVersions(right, left));
    if (newer === undefined) return;
    yield* Console.error(`Executor ${newer} is available. ${updateCommand(installation, newer)}`);
  }).pipe(Effect.ignore);
