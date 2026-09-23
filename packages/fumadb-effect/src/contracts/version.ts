/**
 * Semantic version domain module.
 *
 * FumaDB schema versions are semver strings such as `1.0.0` or `1.0.0-with-admin`.
 * The prerelease part names a schema *variant*; schemas in the same variant form
 * one migration line. This module replaces the `semver` dependency used upstream
 * with exactly the operations the migrator needs.
 */
import { SchemaDefinitionError } from "./errors.ts";

/** A parsed semantic version. */
export interface Version {
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Prerelease identifiers, e.g. `["with-admin"]`. Empty for a release version. */
  readonly prerelease: ReadonlyArray<string | number>;
}

const pattern =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Parse a semver string, or `undefined` when it is not valid. */
export const parse = (raw: string): Version | undefined => {
  const match = pattern.exec(raw);
  if (match === null) return undefined;
  const prerelease =
    match[4] === undefined
      ? []
      : match[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  return {
    raw,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
};

/** Parse a semver string, raising a `SchemaDefinitionError` defect when it is invalid. */
export const parseOrThrow = (raw: string): Version => {
  const parsed = parse(raw);
  if (parsed === undefined) throw new SchemaDefinitionError(`the version ${raw} is invalid.`);
  return parsed;
};

/** Whether a string is a valid semantic version. */
export const isValid = (raw: string): boolean => parse(raw) !== undefined;

const compareIdentifiers = (a: string | number, b: string | number): number => {
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a === b ? 0 : a < b ? -1 : 1;
};

/** Semver precedence, matching `semver.compare`. */
export const compare = (a: Version, b: Version): number => {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const result = compareIdentifiers(
      a.prerelease[i] as string | number,
      b.prerelease[i] as string | number,
    );
    if (result !== 0) return result;
  }
  return a.prerelease.length === b.prerelease.length
    ? 0
    : a.prerelease.length < b.prerelease.length
      ? -1
      : 1;
};

/** Compare two raw version strings. Both must be valid. */
export const compareRaw = (a: string, b: string): number =>
  compare(parseOrThrow(a), parseOrThrow(b));

/** Whether two versions belong to the same variant (identical prerelease identifiers). */
export const sameVariant = (a: Version, b: Version): boolean =>
  a.prerelease.length === b.prerelease.length &&
  a.prerelease.every((id, i) => id === b.prerelease[i]);
