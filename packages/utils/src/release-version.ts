/** Executor 2 release versions, shared by release scripts and installed update checks. */
import { Option, Schema } from "effect";

/** Reject arbitrary tags and unexpected prerelease channels. */
export const ReleaseVersion = Schema.String.check(
  Schema.isPattern(/^2\.\d+\.\d+(?:-beta\.\d+)?$/u),
);

/** Release channels; beta installs also receive newer stable releases. */
export type ReleaseChannel = "beta" | "latest";

/** The npm dist-tag and desktop channel a version publishes to. */
export const releaseChannel = (version: typeof ReleaseVersion.Type): ReleaseChannel =>
  version.includes("-beta.") ? "beta" : "latest";

/** Order release versions; a stable version follows its betas. */
export const compareReleaseVersions = (
  left: typeof ReleaseVersion.Type,
  right: typeof ReleaseVersion.Type,
): number => {
  const parse = (value: string) => {
    const [core = "", beta] = value.split("-beta.");
    return [...core.split(".").map(Number), beta === undefined ? Infinity : Number(beta)];
  };
  const a = parse(left);
  const b = parse(right);
  const index = a.findIndex((part, position) => part !== b[position]);
  return index === -1 ? 0 : Math.sign((a[index] ?? 0) - (b[index] ?? 0));
};

/** The npm registry Executor reads its releases from, unless a mirror is named. */
export const defaultNpmRegistry = "https://registry.npmjs.org";

/** The path of the `executor` package's dist-tags on an npm registry. */
export const distTagsPath = "/-/package/executor/dist-tags";

/**
 * The Executor 2 releases an npm dist-tags document names. npm `latest` still names Executor 1
 * until the v2 stable cutover, so a tag that is no v2 release version is ignored.
 */
export const releasesFromDistTags = (tags: unknown) => {
  const record = typeof tags === "object" && tags !== null ? (tags as Record<string, unknown>) : {};
  const release = (name: string) =>
    Schema.decodeUnknownOption(ReleaseVersion)(record[name]).pipe(Option.getOrUndefined);
  return { beta: release("beta"), latest: release("latest") };
};

/** The newest release an installation of `current` should move to, if any. */
export const newerRelease = (
  current: typeof ReleaseVersion.Type,
  known: {
    readonly beta?: typeof ReleaseVersion.Type | undefined;
    readonly latest?: typeof ReleaseVersion.Type | undefined;
  },
) => {
  // Beta installs move to a newer beta or a newer stable release; stable installs only to a newer
  // stable release, whichever tag names it: a `latest` tag that names a beta is not one.
  const beta = releaseChannel(current) === "beta";
  const [newer] = [known.latest, known.beta]
    .filter((version) => version !== undefined)
    .filter((version) => beta || releaseChannel(version) === "latest")
    .filter((version) => compareReleaseVersions(version, current) > 0)
    .sort((left, right) => compareReleaseVersions(right, left));
  return newer;
};
