import { Schema } from "effect";

/** Display identity only; session tokens and organization preferences never cross this boundary. */
export const BrowserSession = Schema.NullOr(
  Schema.Struct({
    user: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      email: Schema.String,
      image: Schema.NullOr(Schema.String),
      role: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
    session: Schema.optionalKey(
      Schema.Struct({ impersonatedBy: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
    ),
  }),
);
export type BrowserSession = typeof BrowserSession.Type;
/** A C0 or C1 control character is stripped during URL parsing and can change the result. */
const isControl = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
};

/** Preserve same-origin page destinations without allowing an auth or API redirect loop. */
export const browserReturnTo = (value: unknown): string => {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  // A backslash, a control character or an encoded slash can all normalize into an
  // authority, which `window.location.replace` would follow to another origin.
  if (value.includes("\\") || [...value].some(isControl)) return "/";
  // Only the path may not hide a separator; a signed MCP query legitimately carries
  // an encoded redirect_uri.
  const [inputPath] = value.split(/[?#]/);
  if (inputPath !== undefined && /%2f|%5c/i.test(inputPath)) return "/";
  const target = URL.parse(value, "https://executor.invalid");
  if (
    target === null ||
    target.origin !== "https://executor.invalid" ||
    target.pathname === "/login" ||
    target.pathname.startsWith("/login/") ||
    target.pathname === "/api" ||
    target.pathname.startsWith("/api/")
  )
    return "/";
  // `/..//evil.test` parses inside the sentinel origin but normalizes to `//evil.test`.
  // Re-assert the single-slash invariant on the result, not only on the input.
  const path = target.pathname + target.search + target.hash;
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
};
