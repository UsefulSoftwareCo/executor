import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createHash } from "node:crypto";
import { Cause, Config, Console, Duration, Effect, FileSystem, Option } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/http";
import type { ReleaseChannel } from "./config.ts";
import {
  endpoints,
  feedVersions,
  formulaName,
  githubRelease,
  imageVersion,
  newerThan,
  npmArchive,
  npmTags,
  publishedFormulaVersion,
  type PublicReadFailed,
} from "./public-state.ts";

type Row = {
  readonly surface: string;
  readonly now: string;
  readonly done: boolean | undefined;
  readonly names?: string | undefined;
  readonly stray?: boolean;
};

const unread =
  (surface: string) =>
  (error: PublicReadFailed): Effect.Effect<Row> =>
    Effect.succeed({ surface, now: `could not read: ${error.message}`, done: undefined });

const none: Effect.Effect<ReadonlyArray<Row>> = Effect.succeed([]);

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const version = yield* Config.String("VERSION");
  const channel: ReleaseChannel =
    (yield* Config.String("CHANNEL")) === "latest" ? "latest" : "beta";
  const image = yield* Config.String("IMAGE");
  const repository = yield* Config.String("PUBLIC_REPOSITORY");
  const tag = yield* Config.String("RELEASE_TAG");
  const tap = yield* Config.String("TAP").pipe(Config.withDefault(""));
  const token = yield* Config.String("GH_TOKEN").pipe(Config.withDefault(""));
  const run = yield* Config.String("GITHUB_RUN_ID").pipe(Config.withDefault("<run>"));
  const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.option);
  const at = yield* endpoints;
  const launcher = yield* Config.String("LAUNCHER").pipe(
    Config.withDefault(`.local/releases/${version}/wrapper/executor-${version}.tgz`),
  );
  const built = (yield* fs.exists(launcher).pipe(Effect.orElseSucceed(() => false)))
    ? yield* fs.readFile(launcher).pipe(
        Effect.map((bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`),
        Effect.orElseSucceed(() => undefined),
      )
    : undefined;

  const channelRow = (surface: string, names: string | undefined): Row => ({
    surface,
    now: names ?? "nothing",
    done: names === version,
    names,
  });

  const feedRows = (feedChannel: ReleaseChannel, follows: boolean) =>
    feedVersions(at, repository, feedChannel).pipe(
      Effect.map((files) =>
        files.map((file): Row =>
          follows
            ? {
                surface: `desktop feed ${file.name} (beta installs follow)`,
                now: file.version ?? "nothing",
                done:
                  file.version !== undefined &&
                  (file.version === version || newerThan(file.version, version) === true),
              }
            : channelRow(`desktop feed ${file.name}`, file.version),
        ),
      ),
      Effect.catchTag("PublicReadFailed", (error) =>
        Effect.succeed([
          {
            surface: `desktop feed (${feedChannel})`,
            now: `could not read: ${error.message}`,
            done: undefined,
          } satisfies Row,
        ]),
      ),
    );

  const groupSeconds = yield* Config.Number("EXECUTOR_PUBLIC_REPORT_GROUP_SECONDS").pipe(
    Config.withDefault(150),
  );
  const bounded = (
    label: string,
    read: Effect.Effect<ReadonlyArray<Row>, never, HttpClient.HttpClient>,
  ): Effect.Effect<ReadonlyArray<Row>, never, HttpClient.HttpClient> =>
    read.pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(groupSeconds),
        orElse: () =>
          Effect.succeed([
            {
              surface: label,
              now: `could not read: no answer within ${groupSeconds} s`,
              done: undefined,
            } satisfies Row,
          ]),
      }),
    );
  const reads: ReadonlyArray<Effect.Effect<ReadonlyArray<Row>, never, HttpClient.HttpClient>> = [
    bounded(
      `GitHub release ${tag}`,
      githubRelease(at, repository, tag, token).pipe(
        Effect.map((found): ReadonlyArray<Row> => [
          found === undefined
            ? {
                surface: `GitHub release ${tag}`,
                now: token === "" ? "not public (a draft or absent)" : "absent",
                done: false,
              }
            : {
                surface: `GitHub release ${tag}`,
                now: `${found.draft ? "draft" : "public"}, ${found.assets} assets`,
                done: !found.draft,
              },
        ]),
        Effect.catchTag("PublicReadFailed", (error) =>
          unread(`GitHub release ${tag}`)(error).pipe(Effect.map((row) => [row])),
        ),
      ),
    ),
    bounded(
      `${image}:${version}`,
      imageVersion(at, image, version).pipe(
        Effect.map((found): ReadonlyArray<Row> => [
          {
            surface: `${image}:${version}`,
            now: found === undefined ? "absent" : `present (${found})`,
            done: found === version,
          },
        ]),
        Effect.catchTag("PublicReadFailed", (error) =>
          unread(`${image}:${version}`)(error).pipe(Effect.map((row) => [row])),
        ),
      ),
    ),
    bounded(
      `${image}:${channel}`,
      imageVersion(at, image, channel).pipe(
        Effect.map((names): ReadonlyArray<Row> => [channelRow(`${image}:${channel}`, names)]),
        Effect.catchTag("PublicReadFailed", (error) =>
          unread(`${image}:${channel}`)(error).pipe(Effect.map((row) => [row])),
        ),
      ),
    ),
    bounded(
      `npm executor@${version}`,
      npmArchive(at, "executor", version).pipe(
        Effect.flatMap((archive) =>
          Effect.gen(function* () {
            const row = (now: string, done: boolean, stray = false): ReadonlyArray<Row> => [
              { surface: `npm executor@${version}`, now, done, ...(stray ? { stray } : {}) },
            ];
            if (archive === undefined) return row("absent", false);
            if (built !== undefined)
              return archive.integrity === built
                ? row("published, this run's launcher", true)
                : row("npm serves a different archive under this version", false, true);
            const release = yield* githubRelease(at, repository, tag, token);
            return release === undefined || release.draft
              ? row(
                  `npm serves an archive this publication did not put there (no published release ${tag})`,
                  false,
                  true,
                )
              : row("published (not compared: this run built no launcher)", true);
          }),
        ),
        Effect.catchTag("PublicReadFailed", (error) =>
          unread(`npm executor@${version}`)(error).pipe(Effect.map((row) => [row])),
        ),
      ),
    ),
    bounded(
      `npm tag ${channel}`,
      npmTags(at, "executor").pipe(
        Effect.map((tags): ReadonlyArray<Row> => [
          channelRow(`npm tag ${channel}`, tags?.[channel]),
          ...(channel === "beta"
            ? [
                {
                  surface: "npm tag latest (a beta leaves it)",
                  now: tags?.latest ?? "nothing",
                  done: tags?.latest !== version,
                } satisfies Row,
              ]
            : []),
        ]),
        Effect.catchTag("PublicReadFailed", (error) =>
          unread(`npm tag ${channel}`)(error).pipe(Effect.map((row) => [row])),
        ),
      ),
    ),
    tap === ""
      ? none
      : bounded(
          `Homebrew ${formulaName(channel)}`,
          publishedFormulaVersion(at, tap, channel).pipe(
            Effect.map((names): ReadonlyArray<Row> => [
              channelRow(`Homebrew ${formulaName(channel)}`, names),
            ]),
            Effect.catchTag("PublicReadFailed", (error) =>
              unread(`Homebrew ${formulaName(channel)}`)(error).pipe(Effect.map((row) => [row])),
            ),
          ),
        ),
    bounded(`desktop feed (${channel})`, feedRows(channel, false)),
    channel === "latest"
      ? bounded("desktop feed (beta installs follow)", feedRows("beta", true))
      : none,
  ];
  const groups = yield* Effect.all(reads, { concurrency: "unbounded" });
  const rows = groups.flat();

  const newer = rows.filter(
    (row) => row.names !== undefined && newerThan(row.names, version) === true,
  );
  const stray = rows.some((row) => row.stray === true);
  const verdict = stray
    ? `Re-running cannot finish ${version}: npm already serves executor@${version} with an archive this publication did not build, and npm never accepts a version twice. This release needs another version number.`
    : newer.length > 0
      ? `Re-running would not finish ${version}: ${newer.map((row) => `${row.surface} names ${row.names}`).join(", ")}, newer than it. Leave this release; the channel guards stop any step that would move a channel back.`
      : rows.some((row) => row.done === undefined)
        ? `Some surfaces could not be read, so this cannot say whether \`gh run rerun ${run} --failed\` would finish ${version}. Read them by hand first.`
        : rows.every((row) => row.done === true)
          ? `Everything ${version} publishes is public. Nothing is left to finish; the failure came after the publication.`
          : `\`gh run rerun ${run} --failed\` should finish ${version}: a re-run resumes over what is public, and the steps whose work is done skip it or repeat it unchanged. It stops only where publish-npm.ts finds a different archive on npm, or a newer release has moved a channel since.`;

  const table = [
    `### What ${version} published`,
    "",
    "| Surface | Now | Done |",
    "| --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.surface} | ${row.now.replaceAll("|", "\\|")} | ${row.done === undefined ? "?" : row.done ? "done" : "not done"} |`,
    ),
    "",
    verdict,
    "",
  ].join("\n");
  yield* Console.log(table);
  if (Option.isSome(summary))
    yield* fs.writeFileString(summary.value, table, { flag: "a" }).pipe(Effect.ignore);
});

NodeRuntime.runMain(
  program.pipe(
    Effect.catchCause((cause) =>
      Console.log(`The publication report could not be completed:\n${Cause.pretty(cause)}`),
    ),
    Effect.provide([NodeServices.layer, FetchHttpClient.layer]),
  ),
);
