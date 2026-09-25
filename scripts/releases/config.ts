/** One release identity shared by builders, publishers, infrastructure and install links. */
import { Schema } from "effect";
import manifest from "../../apps/cli/package.json" with { type: "json" };

/** Conservative compressed archive budget, checked before npm receives any upload. */
export const npmArchiveBudgetBytes = 180 * 1024 * 1024;

/** Native platforms supported by the packaged runtime. */
export const platforms = [
  {
    platform: "darwin",
    arch: "arm64",
    cliWorkers: 4,
    runner: "blacksmith-6vcpu-macos-15",
    desktopOs: "mac",
    extension: "dmg",
  },
  {
    platform: "darwin",
    arch: "x64",
    runner: "macos-15-intel",
    // Two cold PGlite processes starve each other on the native Intel runner.
    cliWorkers: 1,
    desktopOs: "mac",
    extension: "dmg",
  },
  {
    platform: "linux",
    arch: "x64",
    cliWorkers: 4,
    runner: "blacksmith-16vcpu-ubuntu-2404",
    desktopOs: "linux",
    extension: "AppImage",
  },
  {
    platform: "linux",
    arch: "arm64",
    cliWorkers: 4,
    runner: "blacksmith-16vcpu-ubuntu-2404-arm",
    desktopOs: "linux",
    extension: "AppImage",
  },
  {
    platform: "win32",
    arch: "x64",
    cliWorkers: 4,
    runner: "blacksmith-16vcpu-windows-2025",
    desktopOs: "win",
    extension: "exe",
  },
] as const;

/** A supported native build target. */
export type Platform = (typeof platforms)[number];

/** Reject arbitrary tags and unexpected prerelease channels before creating artifacts. */
export const ReleaseVersion = Schema.String.check(Schema.isPattern(/^2\.\d+\.\d+(?:-beta\.\d+)?$/));

const version = Schema.decodeUnknownSync(ReleaseVersion)(manifest.version);
const channel = version.includes("-beta.") ? "beta" : "latest";
const repository = "UsefulSoftwareCo/executor";
const tag = `executor@${version}`;

/** Durable v2 identities stay fixed when the version moves from beta to stable. */
export const release = {
  version,
  channel,
  repository,
  tag,
  npmPackage: "executor",
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

/** Immutable npm version for one native runtime, aliased by the launcher package. */
export const platformVersion = (target: Platform): string =>
  `${release.version}-${target.platform}-${target.arch}`;

/** npm alias name installed under the wrapper's node_modules. */
export const platformPackage = (target: Platform): string =>
  `executor-${target.platform}-${target.arch}`;

/** The actual platform archive filename produced by npm pack. */
export const platformArchive = (target: Platform): string =>
  `executor-${platformVersion(target)}.tgz`;

/** Primary downloads follow electron-builder's target-specific architecture names. */
export const desktopAsset = (target: Platform): string => {
  const arch = target.extension === "AppImage" && target.arch === "x64" ? "x86_64" : target.arch;
  return `${release.desktop.artifactPrefix}-${release.version}-${target.desktopOs}-${arch}.${target.extension}`;
};

/** Public download for this exact release, never the legacy latest release. */
export const desktopDownload = (target: Platform): string =>
  `https://github.com/${release.repository}/releases/download/${encodeURIComponent(release.tag)}/${desktopAsset(target)}`;

/** Fail at the build boundary if the host cannot produce a supported native artifact. */
export const nativePlatform = (platform: string, arch: string): Platform => {
  const target = platforms.find((target) => target.platform === platform && target.arch === arch);
  if (target === undefined) throw new Error(`Unsupported Executor platform: ${platform}/${arch}`);
  return target;
};
