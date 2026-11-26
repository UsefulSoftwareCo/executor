/** Readable addresses derived only from the current app name. Immutable IDs own storage identity. */
import { Schema } from "effect";

const reserved = new Set(["search", "constructor", "prototype", "then"]);
/** DNS-safe label, unique per owner. Reserved interpreter roots cannot be app addresses. */
export const AppSlug = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u),
  Schema.makeFilter((value) => !reserved.has(value)),
).pipe(Schema.brand("AppSlug"));
/** Validated configured-app address. */
export type AppSlug = typeof AppSlug.Type;

/** The longest address: a DNS label. */
const maxLength = 63;

/** A name's whole address, before it is cut to `maxLength`. */
const label = (name: string) => {
  const normalized = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length === 0
    ? "app"
    : reserved.has(normalized)
      ? `app-${normalized}`
      : normalized;
};

/** Derive a DNS-safe address without consulting other apps or allocating suffixes. */
export const appSlug = (name: string): AppSlug =>
  Schema.decodeUnknownSync(AppSlug)(label(name).slice(0, maxLength).replace(/-+$/g, ""));

/**
 * Whether `name`'s address holds all of it. A longer name's address is cut short, so names that
 * differ only after the cut, such as by a suffix that numbers them, share one address.
 */
export const appSlugFits = (name: string) => label(name).length <= maxLength;
