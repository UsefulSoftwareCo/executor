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

export const patiently = (at: Endpoints): Endpoints => ({ ...at, patience: "patient" });

const repeats = (
  at: Endpoints,
): { readonly schedule: Schedule.Schedule<unknown>; readonly times: number } =>
  at.patience === "patient"
    ? { schedule: Schedule.exponential(Duration.seconds(at.retrySeconds * 2.5), 2), times: 4 }
    : { schedule: Schedule.spaced(Duration.seconds(at.retrySeconds)), times: 3 };

const orderable = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/u;

export const newerThan = (current: string, version: string): boolean | undefined =>
  orderable.test(current) && orderable.test(version)
    ? compareReleaseVersions(current, version) > 0
    : undefined;

export const formulaName = (channel: ReleaseChannel) =>
  channel === "beta" ? "executor-beta" : "executor";

export const formulaVersion = (formula: string) => /^\s*version "([^"]+)"/mu.exec(formula)?.[1];

export const feedFiles = (channel: ReleaseChannel) => [
  ...new Set(platforms.map((target) => desktopUpdateFile(target, channel))),
];

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

const get = (at: Endpoints, url: string, headers: Readonly<Record<string, string>> = {}) =>
  getOnce(url, headers).pipe(Effect.retry(repeats(at)));

const json = <S extends Schema.Top>(schema: S, text: string, what: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError(() => new PublicReadFailed({ message: `${what} answered unreadably` })),
  );

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

export const publishedFormulaVersion = (at: Endpoints, tap: string, channel: ReleaseChannel) =>
  get(at, `${at.raw}/${tap}/HEAD/Formula/${formulaName(channel)}.rb`).pipe(
    Effect.map((text) => (text === undefined ? undefined : (formulaVersion(text) ?? "no version"))),
  );

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
