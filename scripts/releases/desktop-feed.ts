/**
 * Build the desktop update channel files for this release from every platform's
 * electron-builder metadata. Usage: desktop-feed.ts <downloaded artifacts> <output> [<notes>].
 * Nothing is uploaded; the release workflow publishes the output after the
 * versioned GitHub release is public.
 *
 * `<notes>` is the JSON `scripts/releases/release-notes.ts --json` writes. Each channel file then
 * carries, as electron-updater's `releaseNotes` (`{ version, note }`, newest first), the notes of
 * this release and the ones before it that reach the desktop app, one per line, so an install
 * shows what changed between its version and this one from the file its updater already reads.
 * A release with none has a `null` note. The notes list only as far back as the notes script
 * could place every release, so the file also carries the notes' `since` as `releaseNotesSince`:
 * every release after it, up to this one, is listed, and an install says "since" only from there.
 * The notes script and the feed hold the notes to one rule (`notesHistoryProblem`).
 *
 * `desktop-feed.ts --check-notes <notes> [--version <version>]` reads `<notes>` as the feed would
 * for `--version` (by default this release's) and writes nothing. The release workflow runs it as
 * soon as the notes are written, before any build, and again in the publish job on the copy that
 * job downloaded, before it makes anything public, so notes the feed cannot carry stop the release
 * there rather than after everything else is public.
 */
import { createHash } from "node:crypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { parse } from "yaml";
import {
  compareReleaseVersions,
  desktopUpdateFeed,
  desktopUpdateFile,
  platforms,
  release,
  type Platform,
  ReleaseVersion,
  type ReleaseChannel,
} from "./config.ts";
import { NotesHistory, notesHistoryProblem } from "./notes-history.ts";

const UpdateFile = Schema.Struct({
  url: Schema.String,
  sha512: Schema.String,
  size: Schema.Number,
  blockMapSize: Schema.optional(Schema.Number),
  isAdminRightsRequired: Schema.optional(Schema.Boolean),
});
/** The notes the desktop shows: those for every install and for the CLI and desktop app. */
const desktopAreas = new Set(["All installs", "CLI and desktop"]);

const UpdateInfo = Schema.Struct({
  version: ReleaseVersion,
  files: Schema.NonEmptyArray(UpdateFile),
  releaseDate: Schema.String,
});

/**
 * The notes that reach the desktop app, from `release-notes.ts --json`'s file for `version`, and
 * the release after which they list every one, once `notesHistoryProblem` finds nothing wrong.
 */
const readNotes = Effect.fnUntraced(function* (
  notesFile: string,
  version: typeof ReleaseVersion.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const notes = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(NotesHistory))(
    yield* fs.readFileString(notesFile),
  );
  const problem = notesHistoryProblem(notes, version);
  if (problem !== undefined) return yield* Effect.die(new Error(`${notesFile} ${problem}`));
  const releaseNotes = notes.releases.map((entry) => {
    const lines = entry.notes
      .filter((note) => desktopAreas.has(note.area))
      .map((note) => note.text);
    return { version: entry.version, note: lines.length === 0 ? null : lines.join("\n") };
  });
  return { releaseNotes, since: notes.since };
});

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const argv = process.argv.slice(2);
  if (
    argv[0] === "--check-notes" &&
    argv[1] !== undefined &&
    (argv.length === 2 || (argv.length === 4 && argv[2] === "--version"))
  ) {
    const version = yield* Schema.decodeUnknownEffect(ReleaseVersion)(argv[3] ?? release.version);
    const checked = yield* readNotes(argv[1], version);
    return yield* Console.log(
      `${argv[1]}: notes for ${checked.releaseNotes.length} releases, from ${version}, every one since ${checked.since}`,
    );
  }
  const [input, output, notesFile] = argv;
  if (input === undefined || output === undefined)
    return yield* Effect.die(
      new Error(
        "Usage: desktop-feed.ts <artifacts> <output> [<notes>] | --check-notes <notes> [--version <version>]",
      ),
    );
  const notes = notesFile === undefined ? undefined : yield* readNotes(notesFile, release.version);
  const assetBase = `https://github.com/${release.repository}/releases/download/${encodeURIComponent(release.tag)}/`;

  // Every platform must describe this exact version and the installer bytes it ships.
  const describe = Effect.fnUntraced(function* (target: Platform) {
    const directory = path.join(
      input,
      `${release.version}-${target.platform}-${target.arch}`,
      "desktop-artifacts",
    );
    const source = path.join(directory, desktopUpdateFile(target, release.channel));
    const info = yield* Schema.decodeUnknownEffect(UpdateInfo)(
      parse(yield* fs.readFileString(source)),
    );
    if (info.version !== release.version)
      return yield* Effect.die(new Error(`${source} describes ${info.version}`));
    for (const file of info.files) {
      if (file.url !== path.basename(file.url))
        return yield* Effect.die(new Error(`${source} names a nested file ${file.url}`));
      const bytes = yield* fs.readFile(path.join(directory, file.url));
      const sha512 = createHash("sha512").update(bytes).digest("base64");
      if (bytes.byteLength !== file.size || sha512 !== file.sha512)
        return yield* Effect.die(new Error(`${file.url} does not match ${source}`));
    }
    return { target, info };
  });
  const described = yield* Effect.forEach(platforms, describe);

  // macOS arm64 and x64 share one file; electron-updater selects the entry for its architecture.
  const feeds = new Map<string, { readonly target: Platform; info: typeof UpdateInfo.Type }>();
  for (const { target, info } of described) {
    const key = desktopUpdateFile(target, release.channel);
    const existing = feeds.get(key);
    if (existing === undefined) feeds.set(key, { target, info });
    else if (info.files.some((file) => existing.info.files.some((seen) => seen.url === file.url)))
      return yield* Effect.die(new Error(`${target.platform} ${target.arch} repeats a file`));
    else existing.info = { ...existing.info, files: [...existing.info.files, ...info.files] };
  }

  const channels: ReadonlyArray<ReleaseChannel> =
    release.channel === "latest" ? ["latest", "beta"] : ["beta"];
  const http = yield* HttpClient.HttpClient;
  // A stable release also moves beta installs forward, but never behind a newer beta.
  const published = (name: string) =>
    http.get(`${desktopUpdateFeed.url}/${name}`).pipe(
      Effect.flatMap((response) =>
        response.status === 404
          ? Effect.succeed(undefined)
          : HttpClientResponse.filterStatusOk(response).pipe(
              Effect.flatMap((ok) => ok.text),
              Effect.flatMap((text) => Schema.decodeUnknownEffect(UpdateInfo)(parse(text))),
              Effect.map((info) => info.version),
            ),
      ),
      Effect.orDie,
    );
  yield* fs.makeDirectory(output, { recursive: true });
  for (const channel of channels)
    for (const { target, info } of feeds.values()) {
      const name = desktopUpdateFile(target, channel);
      if (channel !== release.channel) {
        const current = yield* published(name);
        if (current !== undefined && compareReleaseVersions(current, release.version) > 0) {
          yield* Console.log(`Keeping ${name} at ${current}`);
          continue;
        }
      }
      // Asset URLs are absolute, so the feed release never copies installers.
      const feed = {
        ...info,
        files: info.files.map((file) => ({ ...file, url: assetBase + file.url })),
        ...(notes === undefined
          ? {}
          : { releaseNotes: notes.releaseNotes, releaseNotesSince: notes.since }),
      };
      // JSON is valid YAML, and electron-updater parses these files as YAML.
      yield* fs.writeFileString(path.join(output, name), `${JSON.stringify(feed, null, 2)}\n`);
      yield* Console.log(`${name} → ${release.version}`);
    }
});

NodeRuntime.runMain(program.pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])));
