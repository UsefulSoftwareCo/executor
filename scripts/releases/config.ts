import { Schema } from "effect";
import {
  ReleaseVersion,
  releaseChannel,
  type ReleaseChannel,
} from "@executor-js/utils/release-version";
import manifest from "../../apps/cli/package.json" with { type: "json" };
import { desktopDownloadTargets } from "../../packages/ui/src/contracts/desktop-download.ts";

export {
  compareReleaseVersions,
  ReleaseVersion,
  type ReleaseChannel,
} from "@executor-js/utils/release-version";

export const recoveryParts = 3;
export const platforms = [
  {
    platform: "darwin",
    arch: "arm64",
    cli: undefined,
    packagedTests: true,
    runner: "blacksmith-6vcpu-macos-15",
    desktopOs: "mac",
    extension: "dmg",
  },
  {
    platform: "darwin",
    arch: "x64",
    cli: undefined,
    packagedTests: false,
    runner: "blacksmith-6vcpu-macos-15",
    desktopOs: "mac",
    extension: "dmg",
  },
  {
    platform: "linux",
    arch: "x64",
    cli: { workers: 8, parts: 2, runner: "blacksmith-16vcpu-ubuntu-2404" },
    packagedTests: true,
    runner: "blacksmith-8vcpu-ubuntu-2404",
    desktopOs: "linux",
    extension: "AppImage",
  },
  {
    platform: "linux",
    arch: "arm64",
    cli: undefined,
    packagedTests: true,
    runner: "blacksmith-8vcpu-ubuntu-2404-arm",
    desktopOs: "linux",
    extension: "AppImage",
  },
  {
    platform: "win32",
    arch: "x64",
    cli: { workers: 8, parts: 2, runner: "blacksmith-16vcpu-windows-2025" },
    packagedTests: true,
    runner: "blacksmith-8vcpu-windows-2025",
    desktopOs: "win",
    extension: "exe",
  },
] as const;

export type Platform = (typeof platforms)[number];

const version = Schema.decodeUnknownSync(ReleaseVersion)(manifest.version);
const channel = releaseChannel(version);
const repository = "UsefulSoftwareCo/executor";
const tag = `executor@${version}`;
const nodeEngine = Schema.decodeUnknownSync(
  Schema.String.check(Schema.isPattern(/^>=\d+\.\d+\.\d+$/u)),
)(manifest.engines.node);

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

export const desktopUpdateFeed = {
  tag: "executor-v2-desktop-updates",
  url: `https://github.com/${repository}/releases/download/executor-v2-desktop-updates`,
  channel: (channel: ReleaseChannel) => `executor-v2-${channel}`,
} as const;

export const desktopUpdateFile = (target: Platform, channel: ReleaseChannel): string => {
  const name = desktopUpdateFeed.channel(channel);
  if (target.platform === "darwin") return `${name}-mac.yml`;
  if (target.platform === "win32") return `${name}.yml`;
  return target.arch === "x64" ? `${name}-linux.yml` : `${name}-linux-${target.arch}.yml`;
};

export const platformVersion = (target: Platform): string =>
  `${release.version}-${target.platform}-${target.arch}`;

export const platformArchive = (target: Platform): string =>
  `executor-${platformVersion(target)}.tgz`;

export const desktopAssetSuffix = (target: Platform): string => {
  const arch = target.extension === "AppImage" && target.arch === "x64" ? "x86_64" : target.arch;
  return `-${target.desktopOs}-${arch}.${target.extension}`;
};

const unlisted = platforms.filter(
  (target, index) =>
    desktopDownloadTargets[index]?.os !== `${target.desktopOs}-${target.arch}` ||
    desktopDownloadTargets[index]?.asset !== desktopAssetSuffix(target),
);
if (unlisted.length > 0 || desktopDownloadTargets.length !== platforms.length)
  throw new Error(
    "desktopDownloadTargets in packages/ui/src/contracts/desktop-download.ts must list each desktop platform's installer in the order of platforms.",
  );

export const desktopAsset = (target: Platform): string =>
  `${release.desktop.artifactPrefix}-${release.version}${desktopAssetSuffix(target)}`;

export const desktopDownloads = {
  releasesApi: `https://api.github.com/repos/${repository}/releases?per_page=100`,
  releasesPage: `https://github.com/${repository}/releases`,
  tagPrefix: `executor@${version.split(".")[0]}.`,
  stableOnly: channel === "latest",
} as const;

export const nativePlatform = (platform: string, arch: string): Platform => {
  const target = platforms.find((target) => target.platform === platform && target.arch === arch);
  if (target === undefined) throw new Error(`Unsupported Executor platform: ${platform}/${arch}`);
  return target;
};
