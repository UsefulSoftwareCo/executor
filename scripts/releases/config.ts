/** One release identity shared by builders, publishers, infrastructure and install links. */
import { Schema } from "effect";
import {
  ReleaseVersion,
  releaseChannel,
  type ReleaseChannel,
} from "@executor-js/utils/release-version";
import manifest from "../../apps/cli/package.json" with { type: "json" };

export {
  compareReleaseVersions,
  ReleaseVersion,
  type ReleaseChannel,
} from "@executor-js/utils/release-version";

/** Conservative compressed archive budget, checked before npm receives any upload. */
export const npmArchiveBudgetBytes = 180 * 1024 * 1024;

/**
 * Native platforms supported by the packaged runtime. The full CLI suite runs against the packaged
 * archive on linux x64 and on Windows, which no other workflow tests; CI runs it from source on
 * every push to main. The other targets run only the checks specific to them: the OS credential
 * store and the desktop app. Intel macOS builds under Rosetta on an Apple Silicon runner and gets
 * a start-up smoke test, since GitHub's Intel runners take most of an hour for the suite.
 */
export const platforms = [
  {
    platform: "darwin",
    arch: "arm64",
    cliWorkers: 0,
    packagedTests: true,
    runner: "blacksmith-6vcpu-macos-15",
    desktopOs: "mac",
    extension: "dmg",
  },
  {
    platform: "darwin",
    arch: "x64",
    cliWorkers: 0,
    packagedTests: false,
    runner: "blacksmith-6vcpu-macos-15",
    desktopOs: "mac",
    extension: "dmg",
  },
  {
    platform: "linux",
    arch: "x64",
    cliWorkers: 4,
    packagedTests: true,
    runner: "blacksmith-16vcpu-ubuntu-2404",
    desktopOs: "linux",
    extension: "AppImage",
  },
  {
    platform: "linux",
    arch: "arm64",
    cliWorkers: 0,
    packagedTests: true,
    runner: "blacksmith-16vcpu-ubuntu-2404-arm",
    desktopOs: "linux",
    extension: "AppImage",
  },
  {
    platform: "win32",
    arch: "x64",
    cliWorkers: 4,
    packagedTests: true,
    runner: "blacksmith-16vcpu-windows-2025",
    desktopOs: "win",
    extension: "exe",
  },
] as const;

/** A supported native build target. */
export type Platform = (typeof platforms)[number];

const version = Schema.decodeUnknownSync(ReleaseVersion)(manifest.version);
const channel = releaseChannel(version);
const repository = "UsefulSoftwareCo/executor";
const tag = `executor@${version}`;
const nodeEngine = Schema.decodeUnknownSync(
  Schema.String.check(Schema.isPattern(/^>=\d+\.\d+\.\d+$/u)),
)(manifest.engines.node);

/** Durable v2 identities stay fixed when the version moves from beta to stable. */
export const release = {
  version,
  channel,
  repository,
  tag,
  npmPackage: "executor",
  minimumNodeVersion: nodeEngine.slice(2),
  npmInstall: `npm i -g executor${channel === "beta" ? "@beta" : ""}`,
  image: "ghcr.io/usefulsoftwareco/executor-selfhost",
  imageTag: version,
  cloudOrigin: manifest.homepage,
  desktop: {
    appId: "com.usefulsoftware.executor.v2",
    productName: "Executor 2",
    dataName: "Executor v2",
    artifactPrefix: "executor-desktop",
    executableName: "executor-v2",
  },
} as const;

/**
 * Executor 1 reads GitHub's release list in the same public repository, so v2
 * never uses its feed file names. One published prerelease holds the current
 * update metadata per channel, pointing at the versioned release assets.
 */
export const desktopUpdateFeed = {
  tag: "executor-v2-desktop-updates",
  url: `https://github.com/${repository}/releases/download/executor-v2-desktop-updates`,
  channel: (channel: ReleaseChannel) => `executor-v2-${channel}`,
} as const;

/** electron-updater's metadata file name for one channel on one platform. */
export const desktopUpdateFile = (target: Platform, channel: ReleaseChannel): string => {
  const name = desktopUpdateFeed.channel(channel);
  if (target.platform === "darwin") return `${name}-mac.yml`;
  if (target.platform === "win32") return `${name}.yml`;
  return target.arch === "x64" ? `${name}-linux.yml` : `${name}-linux-${target.arch}.yml`;
};

/** Immutable npm version for one native runtime, aliased by the launcher package. */
export const platformVersion = (target: Platform): string =>
  `${release.version}-${target.platform}-${target.arch}`;

/** npm alias name installed under the wrapper's node_modules. */
export const platformPackage = (target: Platform): string =>
  `executor-${target.platform}-${target.arch}`;

/** The actual platform archive filename produced by npm pack. */
export const platformArchive = (target: Platform): string =>
  `executor-${platformVersion(target)}.tgz`;

/** The version-free end of a primary download, following electron-builder's architecture names. */
export const desktopAssetSuffix = (target: Platform): string => {
  const arch = target.extension === "AppImage" && target.arch === "x64" ? "x86_64" : target.arch;
  return `-${target.desktopOs}-${arch}.${target.extension}`;
};

export const desktopAsset = (target: Platform): string =>
  `${release.desktop.artifactPrefix}-${release.version}${desktopAssetSuffix(target)}`;

/**
 * The website resolves desktop downloads in the browser from the public
 * release list, as GitHub only lists a release once it is published. A merged
 * version bump therefore never links to installers that are not public yet.
 * GitHub's `latest` release belongs to Executor 1 and skips prereleases, so the
 * list is filtered by this major version's tag prefix instead.
 */
export const desktopDownloads = {
  releasesApi: `https://api.github.com/repos/${repository}/releases?per_page=100`,
  releasesPage: `https://github.com/${repository}/releases`,
  tagPrefix: `executor@${version.split(".")[0]}.`,
  stableOnly: channel === "latest",
} as const;

/** Fail at the build boundary if the host cannot produce a supported native artifact. */
export const nativePlatform = (platform: string, arch: string): Platform => {
  const target = platforms.find((target) => target.platform === platform && target.arch === arch);
  if (target === undefined) throw new Error(`Unsupported Executor platform: ${platform}/${arch}`);
  return target;
};
