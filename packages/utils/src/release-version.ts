import { Option, Schema } from "effect";

export const ReleaseVersion = Schema.String.check(
  Schema.isPattern(/^2\.\d+\.\d+(?:-beta\.\d+)?$/u),
);

export type ReleaseChannel = "beta" | "latest";

export const releaseChannel = (version: typeof ReleaseVersion.Type): ReleaseChannel =>
  version.includes("-beta.") ? "beta" : "latest";

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

export const defaultNpmRegistry = "https://registry.npmjs.org";

export const distTagsPath = "/-/package/executor/dist-tags";

export const releasesFromDistTags = (tags: unknown) => {
  const record = typeof tags === "object" && tags !== null ? (tags as Record<string, unknown>) : {};
  const release = (name: string) =>
    Schema.decodeUnknownOption(ReleaseVersion)(record[name]).pipe(Option.getOrUndefined);
  return { beta: release("beta"), latest: release("latest") };
};

export const newerRelease = (
  current: typeof ReleaseVersion.Type,
  known: {
    readonly beta?: typeof ReleaseVersion.Type | undefined;
    readonly latest?: typeof ReleaseVersion.Type | undefined;
  },
) => {
  const beta = releaseChannel(current) === "beta";
  const [newer] = [known.latest, known.beta]
    .filter((version) => version !== undefined)
    .filter((version) => beta || releaseChannel(version) === "latest")
    .filter((version) => compareReleaseVersions(version, current) > 0)
    .sort((left, right) => compareReleaseVersions(right, left));
  return newer;
};
