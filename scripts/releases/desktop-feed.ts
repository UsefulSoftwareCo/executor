/**
 * Build the desktop update channel files for this release from every platform's
 * electron-builder metadata. Usage: desktop-feed.ts <downloaded artifacts> <output>.
 * Nothing is uploaded; the release workflow publishes the output after the
 * versioned GitHub release is public.
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

const UpdateFile = Schema.Struct({
  url: Schema.String,
  sha512: Schema.String,
  size: Schema.Number,
  blockMapSize: Schema.optional(Schema.Number),
  isAdminRightsRequired: Schema.optional(Schema.Boolean),
});
const UpdateInfo = Schema.Struct({
  version: ReleaseVersion,
  files: Schema.NonEmptyArray(UpdateFile),
  releaseDate: Schema.String,
});

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [input, output] = process.argv.slice(2);
  if (input === undefined || output === undefined)
    return yield* Effect.die(new Error("Usage: desktop-feed.ts <artifacts> <output>"));
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
      };
      // JSON is valid YAML, and electron-updater parses these files as YAML.
      yield* fs.writeFileString(path.join(output, name), `${JSON.stringify(feed, null, 2)}\n`);
      yield* Console.log(`${name} → ${release.version}`);
    }
});

NodeRuntime.runMain(program.pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])));
