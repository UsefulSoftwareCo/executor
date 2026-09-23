/** Readable addresses derived only from the current app name. Immutable IDs own storage identity. */
import { Schema } from "effect";

const reserved = new Set(["search", "constructor", "prototype", "then"]);
/** DNS-safe label, unique per owner. Reserved interpreter roots cannot be app addresses. */
export const AppSlug = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  Schema.makeFilter((value) => !reserved.has(value)),
).pipe(Schema.brand("AppSlug"));
/** Validated configured-app address. */
export type AppSlug = typeof AppSlug.Type;

/** Derive a DNS-safe address without consulting other apps or allocating suffixes. */
export const appSlug = (name: string): AppSlug => {
  const normalized = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const label =
    normalized.length === 0 ? "app" : reserved.has(normalized) ? `app-${normalized}` : normalized;
  const base = label.slice(0, 63).replace(/-+$/g, "");
  return Schema.decodeUnknownSync(AppSlug)(base);
};
