import { SchemaDefinitionError } from "./errors.ts";

export interface Version {
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string | number>;
}

const pattern =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

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

export const parseOrThrow = (raw: string): Version => {
  const parsed = parse(raw);
  if (parsed === undefined) throw new SchemaDefinitionError(`the version ${raw} is invalid.`);
  return parsed;
};

export const isValid = (raw: string): boolean => parse(raw) !== undefined;

const compareIdentifiers = (a: string | number, b: string | number): number => {
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a === b ? 0 : a < b ? -1 : 1;
};

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

export const compareRaw = (a: string, b: string): number =>
  compare(parseOrThrow(a), parseOrThrow(b));

export const sameVariant = (a: Version, b: Version): boolean =>
  a.prerelease.length === b.prerelease.length &&
  a.prerelease.every((id, i) => id === b.prerelease[i]);
