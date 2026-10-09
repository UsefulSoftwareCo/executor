/** Executor 2 release versions, shared by release scripts and installed update checks. */
import { Schema } from "effect";

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
