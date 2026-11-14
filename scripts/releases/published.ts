/**
 * The newest Executor 2 release that installs can get. The committed version names the release
 * being built: the release commit merges before publication, and its image, npm launcher and Git
 * tag exist only once the release workflow publishes them. Install instructions name this one
 * instead, so they work while a newer release is still building.
 *
 * npm's dist-tags are the record. The release workflow moves them last, after the Docker manifest
 * and the public GitHub release, so a version they name has every artifact. `latest` still names
 * Executor 1 until Executor 2 is stable, so it counts only once it names a version 2 release,
 * as in `install.sh`.
 */
import { Effect, Option, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { ReleaseVersion } from "./config.ts";

const DistTags = Schema.Record(Schema.String, Schema.String);

/** npm's dist-tags named no Executor 2 release. */
class PublishedReleaseUnknown extends Schema.TaggedError<PublishedReleaseUnknown>()(
  "PublishedReleaseUnknown",
  { message: Schema.String },
) {}

const v2 = (tags: typeof DistTags.Type, name: string) =>
  Schema.decodeUnknownOption(ReleaseVersion)(tags[name]);

export const publishedRelease = Effect.gen(function* () {
  const tags = yield* HttpClient.get(
    "https://registry.npmjs.org/-/package/executor/dist-tags",
  ).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(DistTags)),
    Effect.timeout(15_000),
    Effect.retry({ schedule: Schedule.exponential(1_000), times: 4 }),
  );
  const version = Option.orElse(v2(tags, "latest"), () => v2(tags, "beta"));
  if (Option.isNone(version))
    return yield* new PublishedReleaseUnknown({
      message: "npm's executor dist-tags name no Executor 2 release",
    });
  return {
    version: version.value,
    imageTag: version.value,
    tag: `executor@${version.value}`,
  };
}).pipe(Effect.provide(FetchHttpClient.layer));
