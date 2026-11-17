/**
 * Refuse to move a release channel backwards. Each step of the publish job that moves a channel
 * runs this first, for its own surface:
 *
 *   node scripts/releases/channel-guard.ts image          # IMAGE:CHANNEL on GHCR
 *   node scripts/releases/channel-guard.ts npm            # npm's CHANNEL dist-tag for executor
 *   node scripts/releases/channel-guard.ts homebrew <tap> # the cloned tap's formula for CHANNEL
 *   node scripts/releases/channel-guard.ts desktop-feed   # each executor-v2-CHANNEL*.yml
 *   node scripts/releases/channel-guard.ts preflight      # all four, before anything moves
 *
 A channel that names a version newer than VERSION (`2.0.0-beta.10` is newer than `2.0.0-beta.9`;
 * `2.0.0` is newer than its betas) stops it, exit 1, saying which channel names what, before
 * anything changes: that is what re-running an old publication after a newer one would find. The
 * same version, an older one or nothing yet lets it go on.
 *
 * A moving step's own check, in the middle of a publication, reads patiently (public-state.ts:
 * about two minutes) and stops when it still cannot read the channel or cannot order what it
 * names. A stop is loud and re-running the failed jobs finishes it; a backward move is silent.
 *
 * `preflight` is the publish job's first step after setup, so a stale run stops before anything
 * moves and says why at once:
 * - It refuses when any surface it could read names a newer version. A newer release that was
 *   half published shows on the image first, so npm alone is not enough.
 * - npm decides whether to go on at all: it is read patiently, and a publication stops when npm
 *   cannot be read or names what cannot be ordered, since its npm step would fail later, after the
 *   release is public and the image moved.
 * - The image, the formula the tap publishes (TAP; the tap is not cloned yet) and the feed are
 *   read quickly. One that cannot be read or names what cannot be ordered is a `::warning` naming
 *   the surface and what was seen, and the publication goes on: its own step checks it again.
 *
 * - Before anything else: a version npm already holds is refused unless this is the resume of the
 *   same publication, which finds a published release for RELEASE_TAG (see the code for how the
 *   draft step and the launcher check make that exact). The message names the version, when npm
 *   published it and whether it is deprecated, and says the release needs another number.
 *
 *   node scripts/releases/channel-guard.ts launcher <archive> # after release:wrapper
 *
 * `launcher` refuses when npm already holds VERSION with an archive other than this run's launcher,
 * before the upload, the image and the release's publication; npm holding nothing, or this very
 * launcher (a resumed publication), lets the job go on.
 *
 * A first publication under a new image name is a warning in the preflight and a stop at the image
 * step: see public-state.ts for why and what to do.
 *
 * VERSION's own channel must be CHANNEL: a beta never moves the stable channel, whose tag, formula
 * and feed files a beta's steps never name, and a stable release never moves only the beta one.
 *
 * Reads VERSION, CHANNEL, IMAGE and PUBLIC_REPOSITORY, as the publish job sets them, and changes
 * nothing anywhere (public-state.ts).
 */
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
      // A missing tap is a missing input, not a channel that names nothing yet: stop.
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

  /** What npm holds as `executor@VERSION`, read patiently; a read that fails stops the step. */
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
    // After release:wrapper, before the upload, the image and the release's publication: npm must
    // not already hold this version with another archive. On a version npm does not hold this is
    // one read; on a resumed publication npm holds this very launcher.
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
    // Two causes, told apart by the release: a published release for this tag that targets this
    // run's export commit means this release was published from this source, so the likely cause
    // is a re-run of the whole workflow, whose rebuilt archives differ from the ones it published;
    // anything else means npm's archive is not this source's, and the version cannot be used.
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
    // In the middle of a publication: read patiently, and stop when it cannot read or order what
    // the channel names. A stop is loud and a re-run finishes it; a backward move is silent.
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

  // Before anything moves, and before anything else is read: a version npm already holds is only
  // published again as the resume of this same publication. A publication makes its release
  // public before npm gets the launcher, so a resume finds a published release for RELEASE_TAG;
  // the draft step then checks that release targets this run's export commit, and the launcher
  // step that npm's archive is this build's. Without a published release, npm's archive is not
  // this pipeline's, and npm never accepts a version twice.
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

  // npm decides whether to go on: it is read patiently, and a publication whose npm step
  // would fail later, after the release is public and the image moved, stops here instead.
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
  // The others are read quickly. One that cannot be read, or names what cannot be ordered, is a
  // warning: its own step checks it again, patiently, before moving it.
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
  // Any channel it could read naming a newer version refuses: a newer release half published
  // shows on the image first.
  const newer = readable.filter(
    (seen) => seen.current !== undefined && newerThan(seen.current, version) === true,
  );
  if (newer.length > 0) return yield* new ChannelGuardFailed({ message: newerMessage(newer) });
  for (const seen of readable) yield* forward(seen);
});

NodeRuntime.runMain(program.pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])));
