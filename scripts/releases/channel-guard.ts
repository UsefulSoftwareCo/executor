import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createHash } from "node:crypto";
import { Config, Console, Effect, FileSystem, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { releaseChannel, ReleaseVersion } from "@executor-js/utils/release-version";
import {
  type Endpoints,
  endpoints,
  feedVersions,
  formulaName,
  formulaVersion,
  imageVersion,
  newerThan,
  npmArchive,
  npmPublishedAt,
  npmTags,
  githubRelease,
  patiently,
  publishedFormulaVersion,
} from "./public-state.ts";

class ChannelGuardFailed extends Schema.TaggedError<ChannelGuardFailed>()("ChannelGuardFailed", {
  message: Schema.String,
}) {}

const surfaces = ["image", "npm", "homebrew", "desktop-feed", "preflight", "launcher"] as const;
type Surface = (typeof surfaces)[number];
const isSurface = (value: string | undefined): value is Surface =>
  surfaces.some((surface) => surface === value);

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [surface, tap] = process.argv.slice(2);
  if (!isSurface(surface))
    return yield* new ChannelGuardFailed({
      message: `Usage: channel-guard.ts <${surfaces.join("|")}> [tap directory | launcher archive]`,
    });
  const version = yield* Config.String("VERSION");
  if (!Schema.is(ReleaseVersion)(version))
    return yield* new ChannelGuardFailed({ message: `${version} is not a release version.` });
  const channel = yield* Config.String("CHANNEL");
  if (channel !== releaseChannel(version))
    return yield* new ChannelGuardFailed({
      message: `${version} publishes to ${releaseChannel(version)}, not ${channel}: a beta never moves the stable channel. Nothing was changed.`,
    });
  const at = yield* endpoints;
  const patient = patiently(at);

  type Seen = { readonly where: string; readonly current: string | undefined };
  const image = (from: Endpoints) =>
    Effect.gen(function* () {
      const name = yield* Config.String("IMAGE");
      return [{ where: `${name}:${channel}`, current: yield* imageVersion(from, name, channel) }];
    });
  const npm = (from: Endpoints) =>
    npmTags(from, "executor").pipe(
      Effect.map((tags) => [{ where: `npm's executor@${channel}`, current: tags?.[channel] }]),
    );
  const feed = (from: Endpoints) =>
    Effect.gen(function* () {
      const repository = yield* Config.String("PUBLIC_REPOSITORY");
      return (yield* feedVersions(from, repository, channel)).map((file) => ({
        where: `the desktop feed's ${file.name}`,
        current: file.version,
      }));
    });
  const clonedFormula = (directory: string) =>
    Effect.gen(function* () {
      const tapExists = yield* fs.stat(directory).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
      if (!tapExists)
        return yield* new ChannelGuardFailed({
          message: `The tap directory ${directory} does not exist. Nothing was changed; clone the tap there first.`,
        });
      const file = path.join(directory, "Formula", `${formulaName(channel)}.rb`);
      const current = (yield* fs.exists(file))
        ? (formulaVersion(yield* fs.readFileString(file)) ?? "no version")
        : undefined;
      return [{ where: `the ${formulaName(channel)} formula`, current }];
    });
  const publishedFormula = (from: Endpoints) =>
    Effect.gen(function* () {
      const name = yield* Config.String("TAP").pipe(Config.withDefault(""));
      if (name === "") return [];
      return [
        {
          where: `${name}'s ${formulaName(channel)} formula`,
          current: yield* publishedFormulaVersion(from, name, channel),
        },
      ];
    });

  const newerMessage = (seen: ReadonlyArray<Seen>) =>
    `${seen.map(({ where, current }) => `${where} names ${current}`).join("; ")}: newer than ${version}. Nothing was changed: a newer release already moved this channel, and ${version} must not move it back. Do not re-run this publication.`;
  const unorderedMessage = ({ where, current }: Seen) =>
    `${where} names ${current}, which cannot be ordered against ${version}, so moving it cannot be shown to go forward.`;
  const forward = ({ where, current }: Seen) =>
    Console.log(
      current === undefined
        ? `${where} names nothing yet; ${version} may move it.`
        : `${where} names ${current}; ${version} may move it.`,
    );

  const held = npmArchive(patient, "executor", version).pipe(
    Effect.catchTag("PublicReadFailed", (error) =>
      Effect.fail(
        new ChannelGuardFailed({
          message: `Cannot read whether npm holds executor@${version} (${error.message}). Nothing was changed; re-run the failed jobs once npm answers.`,
        }),
      ),
    ),
  );
  const deprecation = (archive: { readonly deprecated: string | undefined }) =>
    archive.deprecated === undefined ? "not deprecated" : `deprecated: "${archive.deprecated}"`;

  if (surface === "launcher") {
    if (tap === undefined)
      return yield* new ChannelGuardFailed({ message: "launcher needs the launcher archive" });
    const bytes = yield* fs.readFile(tap);
    const built = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const archive = yield* held;
    if (archive === undefined)
      return yield* Console.log(
        `npm does not hold executor@${version} yet; this launcher may be published.`,
      );
    if (archive.integrity === built)
      return yield* Console.log(
        `npm already serves this launcher as executor@${version}, byte for byte: a resumed publication.`,
      );
    const repository = yield* Config.String("PUBLIC_REPOSITORY");
    const tag = yield* Config.String("RELEASE_TAG");
    const token = yield* Config.String("GH_TOKEN").pipe(Config.withDefault(""));
    const exportFile = yield* Config.String("PUBLIC_EXPORT_COMMIT_FILE").pipe(
      Config.withDefault(""),
    );
    const exported =
      exportFile !== "" && (yield* fs.exists(exportFile))
        ? (yield* fs.readFileString(exportFile)).trim()
        : undefined;
    const release = yield* githubRelease(patient, repository, tag, token).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const ours =
      release !== undefined &&
      !release.draft &&
      exported !== undefined &&
      release.target === exported;
    const remedy = ours
      ? `The release ${tag} is published and targets this run's export commit (${exported}), so the likely cause is a re-run of the whole workflow, whose rebuilt archives differ from the ones that release published: re-run the failed jobs of the original run instead, not the whole workflow.`
      : `${repository} has no published release ${tag} from this run's export commit, so npm's archive is not this source's, and npm never accepts a version twice: this release needs another version number.`;
    return yield* new ChannelGuardFailed({
      message: `npm serves a different archive as executor@${version} (${archive.integrity}, ${deprecation(archive)}), not the launcher this run built (${built}). ${remedy} Nothing public was changed: the upload, the image and the release's publication come after this step.`,
    });
  }

  if (surface !== "preflight") {
    const named: ReadonlyArray<Seen> = yield* Effect.gen(function* () {
      switch (surface) {
        case "image":
          return yield* image(patient);
        case "npm":
          return yield* npm(patient);
        case "desktop-feed":
          return yield* feed(patient);
        case "homebrew":
          if (tap === undefined)
            return yield* new ChannelGuardFailed({ message: "homebrew needs the tap directory" });
          return yield* clonedFormula(tap);
      }
    }).pipe(
      Effect.catchTag("PublicReadFailed", (error) =>
        Effect.fail(
          new ChannelGuardFailed({
            message: `Cannot read what ${surface}'s ${channel} channel names after about two minutes of asking (${error.message}). Nothing was changed; re-run the failed jobs once it answers.`,
          }),
        ),
      ),
    );
    for (const seen of named) {
      if (seen.current !== undefined) {
        const newer = newerThan(seen.current, version);
        if (newer === undefined)
          return yield* new ChannelGuardFailed({
            message: `${unorderedMessage(seen)} Nothing was changed; inspect it.`,
          });
        if (newer) return yield* new ChannelGuardFailed({ message: newerMessage([seen]) });
      }
      yield* forward(seen);
    }
    return;
  }

  const stray = yield* held;
  if (stray !== undefined) {
    const repository = yield* Config.String("PUBLIC_REPOSITORY");
    const tag = yield* Config.String("RELEASE_TAG");
    const token = yield* Config.String("GH_TOKEN").pipe(Config.withDefault(""));
    const release = yield* githubRelease(patient, repository, tag, token).pipe(
      Effect.catchTag("PublicReadFailed", (error) =>
        Effect.fail(
          new ChannelGuardFailed({
            message: `npm already serves executor@${version}, and the release ${tag} cannot be read (${error.message}), so this cannot tell a resumed publication from a version npm holds from elsewhere. Nothing was changed; re-run the failed jobs once GitHub answers.`,
          }),
        ),
      ),
    );
    if (release === undefined || release.draft) {
      const published = yield* npmPublishedAt(at, "executor", version).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      return yield* new ChannelGuardFailed({
        message: `npm already serves executor@${version} (published ${published ?? "at a time npm does not say"}, ${deprecation(stray)}), and this is not a resumed publication of it: ${repository} has no published release ${tag}, which a publication makes public before npm gets the launcher. npm never accepts a version twice, so this release needs another version number. Nothing was changed.`,
      });
    }
    yield* Console.log(
      `npm already serves executor@${version} and ${repository} has published ${tag}: a resumed publication. The draft step checks that release is this run's export, and the launcher step that npm's archive is this build's.`,
    );
  }

  const npmSeen = yield* npm(patient).pipe(
    Effect.catchTag("PublicReadFailed", (error) =>
      Effect.fail(
        new ChannelGuardFailed({
          message: `Cannot read npm's dist-tags (${error.message}). Nothing was changed: the npm step would fail later, after the release is public. Re-run the failed jobs once npm answers.`,
        }),
      ),
    ),
  );
  for (const seen of npmSeen)
    if (seen.current !== undefined && newerThan(seen.current, version) === undefined)
      return yield* new ChannelGuardFailed({
        message: `${unorderedMessage(seen)} Nothing was changed; inspect it.`,
      });
  const warn = (line: string) => Console.log(`::warning title=Channel guard::${line}`);
  const others: Array<Seen> = [];
  const tryRead = <E, R>(label: string, read: Effect.Effect<ReadonlyArray<Seen>, E, R>) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(read);
      if (result._tag === "Success") return others.push(...result.success);
      const failure: unknown = result.failure;
      const text = failure instanceof Error ? failure.message : String(failure);
      yield* warn(
        `Cannot read ${label} (${text}); going on, and its step checks it again before moving it.`,
      );
    });
  yield* tryRead("the image", image(at));
  yield* tryRead("the published formula", publishedFormula(at));
  yield* tryRead("the desktop feed", feed(at));
  const readable: Array<Seen> = [];
  for (const seen of [...npmSeen, ...others]) {
    if (seen.current !== undefined && newerThan(seen.current, version) === undefined) {
      yield* warn(`${unorderedMessage(seen)} Going on; its step checks it again before moving it.`);
      continue;
    }
    readable.push(seen);
  }
  const newer = readable.filter(
    (seen) => seen.current !== undefined && newerThan(seen.current, version) === true,
  );
  if (newer.length > 0) return yield* new ChannelGuardFailed({ message: newerMessage(newer) });
  for (const seen of readable) yield* forward(seen);
});

NodeRuntime.runMain(program.pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])));
