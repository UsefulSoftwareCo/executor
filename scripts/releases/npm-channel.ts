/**
 * Wait for npm's dist-tags to name a release that npm already serves, and fail on what was seen.
 *
 * npm moves a dist-tag some time after it serves the version itself: beta.51's version document
 * answered at 21:16:00, and one read of the dist-tags 0.1 s later still named beta.50, though
 * `npm view` named beta.51 34 s after that. So the tag is read until it names this release, for a
 * bounded time, and the wait ends on the first answer that settles it:
 *
 * - The channel's tag names this release (and, for a beta, `latest` is what it was before
 *   publishing): done.
 * - The channel's tag still names what it named before publishing: npm has not caught up. Ask
 *   again, until the limit; then fail naming what the tag still says.
 * - A beta's publication changed `latest`: fail at once. A late read shows the old value, so any
 *   other value is a real change, which must be restored by hand.
 * - The channel's tag names some third version: another publication moved it. Fail at once.
 *
 * A request that fails, times out or answers unreadably is not an answer, and is asked again.
 * The limit has no override in production: `publish-npm.ts` passes none.
 *
 * Run directly, it waits once with its inputs from the environment, as e2e/tests/npm-channel.spec.ts
 * runs it against a local registry: `NPM_CHANNEL`, `NPM_CHANNEL_VERSION`, `NPM_CHANNEL_BEFORE` (the
 * dist-tags before publishing, as JSON), and optionally `NPM_CHANNEL_REGISTRY` and
 * `NPM_CHANNEL_PACKAGE` (npm and `executor`). Against another registry only,
 * `NPM_CHANNEL_LIMIT_SECONDS`, `NPM_CHANNEL_POLL_SECONDS` and `NPM_CHANNEL_ATTEMPT_SECONDS` shorten
 * the wait, so a test can reach its end; against npm they are refused.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Config, Console, Duration, Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

export const npmRegistry = "https://registry.npmjs.org";

export const DistTags = Schema.Record(Schema.String, Schema.String);
export type DistTags = typeof DistTags.Type;

export class NpmChannelFailed extends Schema.TaggedError<NpmChannelFailed>()("NpmChannelFailed", {
  message: Schema.String,
}) {}

/** The tags have not settled yet, or the registry could not say: ask again, within the limit. */
class NotYet extends Schema.TaggedError<NotYet>()("NotYet", { reason: Schema.String }) {}

export type NpmChannelWait = {
  /** The registry's origin, such as https://registry.npmjs.org. */
  readonly registry: string;
  readonly packageName: string;
  /** The dist-tag this release moves: `beta` or `latest`. */
  readonly channel: string;
  readonly version: string;
  /** The dist-tags as read before publishing. */
  readonly before: DistTags;
  /** How long to wait in all; 10 minutes. */
  readonly limitSeconds?: number;
  /** How long between two reads; 10 s. */
  readonly pollSeconds?: number;
  /** How long one read may take, its body included; 15 s. */
  readonly attemptSeconds?: number;
};

const named = (tags: DistTags, tag: string) => tags[tag] ?? "nothing";

/** Reads the dist-tags until they name `version` under `channel`; returns them. */
export const awaitNpmChannel = (options: NpmChannelWait) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const limit = options.limitSeconds ?? 600;
    const poll = options.pollSeconds ?? 10;
    const attempt = options.attemptSeconds ?? 15;
    const { channel, version, before } = options;
    const url = `${options.registry}/-/package/${options.packageName}/dist-tags`;

    const read = Effect.gen(function* () {
      const response = yield* http
        .get(url)
        .pipe(Effect.mapError(() => new NotYet({ reason: "the registry did not answer" })));
      if (response.status !== 200) {
        yield* response.text.pipe(Effect.ignore);
        return yield* new NotYet({ reason: `the registry answered ${response.status}` });
      }
      return yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(DistTags)),
        Effect.mapError(() => new NotYet({ reason: "the registry answered unreadably" })),
      );
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(attempt),
        orElse: () =>
          Effect.fail(new NotYet({ reason: `the registry did not answer within ${attempt} s` })),
      }),
    );

    const look = Effect.gen(function* () {
      const tags = yield* read;
      if (channel !== "latest" && tags.latest !== before.latest)
        return yield* new NpmChannelFailed({
          message: `npm's latest tag names ${named(tags, "latest")}, not ${named(before, "latest")} as before publishing ${version} to ${channel}. Restore latest by hand.`,
        });
      if (tags[channel] === version) return tags;
      if (tags[channel] === before[channel])
        return yield* new NotYet({
          reason: `npm's ${channel} tag still names ${named(tags, channel)}`,
        });
      return yield* new NpmChannelFailed({
        message: `npm's ${channel} tag names ${named(tags, channel)}: neither ${version} nor ${named(before, channel)}, which it named before publishing. Another publication moved it.`,
      });
    });

    let last = "no answer yet";
    const follow: Effect.Effect<DistTags, NpmChannelFailed, never> = Effect.suspend(() =>
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
              message: `npm serves ${options.packageName}@${version}, but its ${channel} tag did not name it within ${limit} s; the last read: ${last}. Before publishing, ${channel} named ${named(before, channel)} and latest ${named(before, "latest")}. Check \`npm view ${options.packageName} dist-tags\`; rerunning the job resumes over the published version.`,
            }),
          ),
      }),
    );
  });

/** The wait as a command, with its inputs from the environment. */
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
  if (shortened && registry === npmRegistry)
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

// Run as the main module: Node loads it by its real path, which argv[1] may reach through a link.
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  NodeRuntime.runMain(command.pipe(Effect.provide(FetchHttpClient.layer)));
