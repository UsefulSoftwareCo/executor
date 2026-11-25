import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Config, Console, Duration, Effect, Schedule, Schema } from "effect";
import { compareReleaseVersions } from "@executor-js/utils/release-version";
import { FetchHttpClient, HttpClient } from "effect/http";

export const npmRegistry = "https://registry.npmjs.org";

const isNpm = (registry: string) => {
  try {
    return new URL(registry).hostname.toLowerCase() === new URL(npmRegistry).hostname;
  } catch {
    return false;
  }
};

const orderable = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/u;

export const DistTags = Schema.Record(Schema.String, Schema.String);
export type DistTags = typeof DistTags.Type;

export class NpmChannelFailed extends Schema.TaggedError<NpmChannelFailed>()("NpmChannelFailed", {
  message: Schema.String,
}) {}

class NotYet extends Schema.TaggedError<NotYet>()("NotYet", { reason: Schema.String }) {}

export type NpmChannelWait = {
  /** The registry's origin, such as https://registry.npmjs.org. */
  readonly registry: string;
  readonly packageName: string;
  readonly channel: string;
  readonly version: string;
  readonly before: DistTags;
  readonly limitSeconds?: number;
  readonly pollSeconds?: number;
  readonly attemptSeconds?: number;
};

const named = (tags: DistTags, tag: string) => tags[tag] ?? "nothing";

export const readDistTags = (registry: string, packageName: string, attemptSeconds: number) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .get(`${registry}/-/package/${packageName}/dist-tags`)
      .pipe(Effect.mapError(() => new NotYet({ reason: "the registry did not answer" })));
    if (response.status !== 200) {
      yield* response.text.pipe(Effect.ignore);
      return yield* new NotYet({ reason: `the registry answered ${response.status}` });
    }
    const tags = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(DistTags)),
      Effect.mapError(() => new NotYet({ reason: "the registry answered unreadably" })),
    );
    if (tags.latest === undefined)
      return yield* new NotYet({ reason: "the registry answered without a latest tag" });
    return tags;
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(attemptSeconds),
      orElse: () =>
        Effect.fail(
          new NotYet({ reason: `the registry did not answer within ${attemptSeconds} s` }),
        ),
    }),
  );

export const distTagsBeforePublishing = (registry: string, packageName: string) =>
  readDistTags(registry, packageName, 15).pipe(
    Effect.retry({ schedule: Schedule.spaced(Duration.seconds(5)), times: 3 }),
    Effect.mapError(
      (notYet) =>
        new NpmChannelFailed({
          message: `Cannot read npm's dist-tags for ${packageName} before publishing (${notYet.reason}). Nothing was published.`,
        }),
    ),
  );

export const awaitNpmChannel = (options: NpmChannelWait) =>
  Effect.gen(function* () {
    const limit = options.limitSeconds ?? 600;
    const poll = options.pollSeconds ?? 10;
    const attempt = options.attemptSeconds ?? 15;
    const { channel, version, before } = options;
    const read = readDistTags(options.registry, options.packageName, attempt);

    const look = Effect.gen(function* () {
      const tags = yield* read;
      if (channel !== "latest" && tags.latest !== before.latest)
        return yield* new NpmChannelFailed({
          message: `npm's latest tag names ${named(tags, "latest")}, not ${named(before, "latest")} as before publishing ${version} to ${channel}. Restore latest by hand.`,
        });
      if (tags[channel] === version) return tags;
      const current = tags[channel];
      if (
        current !== undefined &&
        orderable.test(current) &&
        compareReleaseVersions(current, version) > 0
      )
        return yield* new NpmChannelFailed({
          message: `npm's ${channel} tag names ${current}, newer than ${version}: a newer release has published since, so this run is stale. Do not re-run it; the newer release carries everything.`,
        });
      if (tags[channel] === before[channel])
        return yield* new NotYet({
          reason: `npm's ${channel} tag still names ${named(tags, channel)}`,
        });
      return yield* new NpmChannelFailed({
        message: `npm's ${channel} tag names ${named(tags, channel)}: neither ${version} nor ${named(before, channel)}, which it named before publishing. Another publication moved it.`,
      });
    });

    let last = "no answer yet";
    const follow: Effect.Effect<DistTags, NpmChannelFailed, HttpClient.HttpClient> = Effect.suspend(
      () =>
        look.pipe(
          Effect.catchTag("NotYet", (notYet) => {
            last = notYet.reason;
            return Console.log(
              `Waiting for npm's ${channel} tag to name ${version}: ${notYet.reason}`,
            ).pipe(Effect.andThen(Effect.sleep(Duration.seconds(poll))), Effect.andThen(follow));
          }),
        ),
    );
    return yield* follow.pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(limit),
        orElse: () =>
          Effect.fail(
            new NpmChannelFailed({
              message: `npm serves ${options.packageName}@${version}, but its ${channel} tag did not name it within ${limit} s; the last read: ${last}. Before publishing, ${channel} named ${named(before, channel)} and latest ${named(before, "latest")}. Check \`npm view ${options.packageName} dist-tags\`: once the tag names ${version}, re-running the failed jobs resumes over the published version; if it names a version newer than ${version}, this run is stale and must not be re-run.`,
            }),
          ),
      }),
    );
  });

const command = Effect.gen(function* () {
  const registry = yield* Config.String("NPM_CHANNEL_REGISTRY").pipe(
    Config.withDefault(npmRegistry),
  );
  const seconds = (name: string) => Config.Number(name).pipe(Config.option);
  const limits = {
    limitSeconds: yield* seconds("NPM_CHANNEL_LIMIT_SECONDS"),
    pollSeconds: yield* seconds("NPM_CHANNEL_POLL_SECONDS"),
    attemptSeconds: yield* seconds("NPM_CHANNEL_ATTEMPT_SECONDS"),
  };
  const shortened = Object.values(limits).some((value) => value._tag === "Some");
  if (shortened && isNpm(registry))
    return yield* new NpmChannelFailed({
      message: `The NPM_CHANNEL_*_SECONDS limits apply only to another registry, not ${npmRegistry}.`,
    });
  const channel = yield* Config.String("NPM_CHANNEL");
  const version = yield* Config.String("NPM_CHANNEL_VERSION");
  const before = yield* Config.String("NPM_CHANNEL_BEFORE").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(DistTags))),
    Effect.mapError(
      () =>
        new NpmChannelFailed({
          message: "NPM_CHANNEL_BEFORE must be the dist-tags before publishing, as a JSON object",
        }),
    ),
  );
  const packageName = yield* Config.String("NPM_CHANNEL_PACKAGE").pipe(
    Config.withDefault("executor"),
  );
  const tags = yield* awaitNpmChannel({
    registry,
    packageName,
    channel,
    version,
    before,
    ...(limits.limitSeconds._tag === "Some" ? { limitSeconds: limits.limitSeconds.value } : {}),
    ...(limits.pollSeconds._tag === "Some" ? { pollSeconds: limits.pollSeconds.value } : {}),
    ...(limits.attemptSeconds._tag === "Some"
      ? { attemptSeconds: limits.attemptSeconds.value }
      : {}),
  });
  yield* Console.log(`npm's ${channel} tag names ${version}; latest=${named(tags, "latest")}`);
});

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  NodeRuntime.runMain(command.pipe(Effect.provide(FetchHttpClient.layer)));
