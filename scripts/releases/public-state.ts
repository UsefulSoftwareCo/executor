/**
 * Read what a release's public surfaces name now, without credentials: the image's tags on GHCR,
 * npm's dist-tags and versions, the Homebrew formula, the desktop update feed and the public GitHub
 * release. `channel-guard.ts` reads them before a step moves a channel, and
 * `publication-report.ts` after a failed publish job.
 *
 * Each read is one answer or a `PublicReadFailed`: a surface that names nothing yet (a tag, file or
 * release that does not exist, 404) is `undefined`, never a failure. A read that fails, times out
 * (15 s, its body included) or answers unreadably is asked again, on one of two schedules:
 *
 * - `quick` (the default): three more reads 2 s apart. For reads whose failure only warns (the
 *   preflight's image, tap and feed) or only leaves a row unread (the report).
 * - `patient` (`patiently(at)`): four more reads after 5, 10, 20 and 40 s, 75 s of waiting and at
 *   most about 2.5 minutes when every read runs to its limit. For reads whose failure stops a
 *   publication: each moving step's own check, in the middle of a publication, and the preflight's
 *   npm read. A short outage or rate limit then costs a minute instead of a stopped release; one
 *   that lasts longer stops it loudly, and re-running the failed jobs finishes it, where a channel
 *   moved backwards would be silent.
 *
 * A first publication under a new image name cannot be read: GHCR answers 403, not 404, to an
 * anonymous token for a repository that does not exist yet, and a new package starts private,
 * which answers the same. channel-guard.ts's preflight only warns about it, but the image step's
 * own check stops, before anything public has moved. The person doing that first publication
 * makes the package public once the `docker` job's push has created it (the package's settings on
 * GitHub), then re-runs the failed jobs.
 *
 * The origins default to the real services. `EXECUTOR_PUBLIC_NPM`, `EXECUTOR_PUBLIC_GHCR`,
 * `EXECUTOR_PUBLIC_GITHUB`, `EXECUTOR_PUBLIC_GITHUB_API` and `EXECUTOR_PUBLIC_RAW` replace them;
 * e2e/tests/publish-guard.spec.ts points them at one local stub, and shortens the spacing of the
 * repeated reads with `EXECUTOR_PUBLIC_RETRY_SECONDS` (2 s). The release workflow sets none.
 */
import { Config, Duration, Effect, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  compareReleaseVersions,
  desktopUpdateFeed,
  desktopUpdateFile,
  platforms,
  type ReleaseChannel,
} from "./config.ts";

export class PublicReadFailed extends Schema.TaggedError<PublicReadFailed>()("PublicReadFailed", {
  message: Schema.String,
}) {}

export const endpoints = Effect.gen(function* () {
  const origin = (name: string, fallback: string) =>
    Config.String(name).pipe(Config.withDefault(fallback));
  return {
    npm: yield* origin("EXECUTOR_PUBLIC_NPM", "https://registry.npmjs.org"),
    ghcr: yield* origin("EXECUTOR_PUBLIC_GHCR", "https://ghcr.io"),
    github: yield* origin("EXECUTOR_PUBLIC_GITHUB", "https://github.com"),
    githubApi: yield* origin("EXECUTOR_PUBLIC_GITHUB_API", "https://api.github.com"),
    raw: yield* origin("EXECUTOR_PUBLIC_RAW", "https://raw.githubusercontent.com"),
    retrySeconds: yield* Config.Number("EXECUTOR_PUBLIC_RETRY_SECONDS").pipe(Config.withDefault(2)),
    patience: "quick" as "quick" | "patient",
  };
});
export type Endpoints = Effect.Success<typeof endpoints>;

/** The same endpoints, read on the patient schedule (above). */
export const patiently = (at: Endpoints): Endpoints => ({ ...at, patience: "patient" });

/**
 * The repeats after a failed read. `EXECUTOR_PUBLIC_RETRY_SECONDS` (2 s) is the quick spacing;
 * the patient waits start at 2.5 times it and double: 5, 10, 20 and 40 s.
 */
const repeats = (
  at: Endpoints,
): { readonly schedule: Schedule.Schedule<unknown>; readonly times: number } =>
  at.patience === "patient"
    ? { schedule: Schedule.exponential(Duration.seconds(at.retrySeconds * 2.5), 2), times: 4 }
    : { schedule: Schedule.spaced(Duration.seconds(at.retrySeconds)), times: 3 };

/** A release version this tooling can order: `2.0.0`, `2.0.0-beta.10`, or Executor 1's `1.6.11`. */
const orderable = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/u;

/**
 * Whether `current`, what a channel names now, is newer than `version`: true, false, or undefined
 * when `current` is not a version this tooling can order. `2.0.0-beta.10` is newer than
 * `2.0.0-beta.9`, and `2.0.0` newer than every `2.0.0-beta.N`.
 */
export const newerThan = (current: string, version: string): boolean | undefined =>
  orderable.test(current) && orderable.test(version)
    ? compareReleaseVersions(current, version) > 0
    : undefined;

/** The Homebrew formula a channel's releases update: a beta never touches the stable one. */
export const formulaName = (channel: ReleaseChannel) =>
  channel === "beta" ? "executor-beta" : "executor";

/** The `version "…"` line of a Homebrew formula, or undefined when it has none. */
export const formulaVersion = (formula: string) => /^\s*version "([^"]+)"/mu.exec(formula)?.[1];

/** The desktop feed's file names for one channel, one per platform, as electron-updater reads them. */
export const feedFiles = (channel: ReleaseChannel) => [
  ...new Set(platforms.map((target) => desktopUpdateFile(target, channel))),
];

/** One GET, once: the body, or undefined for a 404; anything else but 200 fails. */
const getOnce = (url: string, headers: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers)))
      .pipe(Effect.mapError(() => new PublicReadFailed({ message: `${url} did not answer` })));
    if (response.status === 404) {
      yield* response.text.pipe(Effect.ignore);
      return undefined;
    }
    const text = yield* response.text.pipe(
      Effect.mapError(() => new PublicReadFailed({ message: `${url} answered unreadably` })),
    );
    if (response.status !== 200)
      return yield* new PublicReadFailed({ message: `${url} answered ${response.status}` });
    return text;
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(15),
      orElse: () =>
        Effect.fail(new PublicReadFailed({ message: `${url} did not answer within 15 s` })),
    }),
  );

/** One GET, asked again on `at`'s schedule while it fails. */
const get = (at: Endpoints, url: string, headers: Readonly<Record<string, string>> = {}) =>
  getOnce(url, headers).pipe(Effect.retry(repeats(at)));

const json = <S extends Schema.Top>(schema: S, text: string, what: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError(() => new PublicReadFailed({ message: `${what} answered unreadably` })),
  );

/**
 * npm's dist-tags for `name`, or undefined when npm has no such package. An answer without a
 * `latest` tag is unreadable, as in npm-channel.ts: npm always has one, so it is an error body, and
 * taking it for "names nothing yet" would let a stale release through. It is asked again.
 */
export const npmTags = (at: Endpoints, name: string) =>
  getOnce(`${at.npm}/-/package/${name}/dist-tags`).pipe(
    Effect.flatMap((text) =>
      text === undefined
        ? Effect.succeed(undefined)
        : json(Schema.Record(Schema.String, Schema.String), text, "npm's dist-tags").pipe(
            Effect.flatMap((tags) =>
              tags.latest === undefined
                ? Effect.fail(
                    new PublicReadFailed({
                      message: `npm's dist-tags for ${name} answered without a latest tag`,
                    }),
                  )
                : Effect.succeed(tags),
            ),
          ),
    ),
    Effect.retry(repeats(at)),
  );

/**
 * The archive npm serves as `name@version`: its integrity and, when it is deprecated, the
 * deprecation message; undefined when npm does not hold that version.
 */
export const npmArchive = (at: Endpoints, name: string, version: string) =>
  get(at, `${at.npm}/${name}/${version}`).pipe(
    Effect.flatMap((text) =>
      text === undefined
        ? Effect.succeed(undefined)
        : json(
            Schema.Struct({
              dist: Schema.Struct({ integrity: Schema.String }),
              deprecated: Schema.optional(Schema.String),
            }),
            text,
            `npm's ${name}@${version}`,
          ).pipe(
            Effect.map((found) => ({
              integrity: found.dist.integrity,
              deprecated: found.deprecated,
            })),
          ),
    ),
  );

/** When npm says it published `name@version`, from the package's `time`; undefined if it does not say. */
export const npmPublishedAt = (at: Endpoints, name: string, version: string) =>
  get(at, `${at.npm}/${name}`).pipe(
    Effect.flatMap((text) =>
      text === undefined
        ? Effect.succeed(undefined)
        : json(
            Schema.Struct({ time: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
            text,
            `npm's ${name} document`,
          ).pipe(Effect.map((found) => found.time?.[version])),
    ),
  );

const manifestTypes = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const Manifest = Schema.Struct({
  manifests: Schema.optional(
    Schema.Array(
      Schema.Struct({
        digest: Schema.String,
        platform: Schema.optional(
          Schema.Struct({ os: Schema.String, architecture: Schema.String }),
        ),
      }),
    ),
  ),
  config: Schema.optional(Schema.Struct({ digest: Schema.String })),
});
const ImageConfig = Schema.Struct({
  config: Schema.Struct({
    Labels: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
  }),
});

/**
 * The version an image tag names, from its Linux image's `org.opencontainers.image.version` label
 * (release-artifacts.yml sets it), or undefined when the tag does not exist. `image` is the
 * workflow's IMAGE, such as `ghcr.io/usefulsoftwareco/executor-selfhost`.
 */
export const imageVersion = (at: Endpoints, image: string, tag: string) =>
  Effect.gen(function* () {
    const repository = image.slice(image.indexOf("/") + 1);
    const token = yield* get(at, `${at.ghcr}/token?scope=repository:${repository}:pull`).pipe(
      Effect.flatMap((text) =>
        text === undefined
          ? Effect.fail(new PublicReadFailed({ message: `GHCR gave no token for ${repository}` }))
          : json(Schema.Struct({ token: Schema.String }), text, "GHCR's token endpoint"),
      ),
    );
    const headers = { authorization: `Bearer ${token.token}`, accept: manifestTypes };
    const manifest = (reference: string) =>
      get(at, `${at.ghcr}/v2/${repository}/manifests/${reference}`, headers).pipe(
        Effect.flatMap((text) =>
          text === undefined
            ? Effect.succeed(undefined)
            : json(Manifest, text, `${image}:${reference}`),
        ),
      );
    const top = yield* manifest(tag);
    if (top === undefined) return undefined;
    const linux = top.manifests?.find((entry) => entry.platform?.os === "linux");
    const single = linux === undefined ? top : yield* manifest(linux.digest);
    const config = single?.config?.digest;
    if (config === undefined)
      return yield* new PublicReadFailed({ message: `${image}:${tag} has no image config` });
    const blob = yield* get(at, `${at.ghcr}/v2/${repository}/blobs/${config}`, headers);
    if (blob === undefined)
      return yield* new PublicReadFailed({ message: `${image}:${tag}'s config is missing` });
    const labels = (yield* json(ImageConfig, blob, `${image}:${tag}'s config`)).config.Labels;
    const version = labels?.["org.opencontainers.image.version"];
    if (version === undefined)
      return yield* new PublicReadFailed({ message: `${image}:${tag} has no version label` });
    return version;
  });

/** The version the tap's formula for `channel` names, or undefined when it has none yet. */
export const publishedFormulaVersion = (at: Endpoints, tap: string, channel: ReleaseChannel) =>
  get(at, `${at.raw}/${tap}/HEAD/Formula/${formulaName(channel)}.rb`).pipe(
    Effect.map((text) => (text === undefined ? undefined : (formulaVersion(text) ?? "no version"))),
  );

/** The version each of `channel`'s desktop feed files names; undefined for a file not there yet. */
export const feedVersions = (at: Endpoints, repository: string, channel: ReleaseChannel) =>
  Effect.forEach(feedFiles(channel), (name) =>
    get(at, `${at.github}/${repository}/releases/download/${desktopUpdateFeed.tag}/${name}`).pipe(
      Effect.flatMap((text) =>
        text === undefined
          ? Effect.succeed(undefined)
          : json(Schema.Struct({ version: Schema.String }), text, name).pipe(
              Effect.map((info) => info.version),
            ),
      ),
      Effect.map((version) => ({ name, version })),
    ),
  );

/**
 * The public GitHub release for `tag`: whether it is a draft and how many assets it holds, or
 * undefined when the token (or, without one, the public) cannot see it. Only a token sees drafts.
 */
export const githubRelease = (
  at: Endpoints,
  repository: string,
  tag: string,
  token: string | undefined,
) =>
  get(
    at,
    `${at.githubApi}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    token === undefined || token === "" ? {} : { authorization: `Bearer ${token}` },
  ).pipe(
    Effect.flatMap((text) =>
      text === undefined
        ? Effect.succeed(undefined)
        : json(
            Schema.Struct({
              draft: Schema.Boolean,
              assets: Schema.Array(Schema.Unknown),
              target_commitish: Schema.optional(Schema.String),
            }),
            text,
            `the release ${tag}`,
          ).pipe(
            Effect.map((found) => ({
              draft: found.draft,
              assets: found.assets.length,
              target: found.target_commitish,
            })),
          ),
    ),
  );
