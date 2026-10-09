import { Option, Schema } from "effect";
import { OrganizationId } from "./organization.ts";
import type { ResourceOrigins } from "@executor-js/mcp-auth";

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

/** Server context for a hosted dashboard document, resolved before rendering starts. */
export interface HostedDocumentContext {
  /** The verified display identity; `null` is a confirmed missing or expired session. */
  readonly session: BrowserSession;
  /** Where this person last worked in this browser, when the saved memory is theirs. */
  readonly lastOrganization: LastOrganization | null;
  /**
   * The origins of MCP and API resources. Pages show MCP URLs at the first and accept a consent
   * for any of them.
   */
  readonly resourceOrigins: ResourceOrigins;
}

/**
 * The organization a person last opened in this browser, used only to choose where `/` goes.
 * It is navigation memory, never authority: every request still checks membership.
 */
export const LastOrganization = Schema.Struct({
  user: Schema.String,
  organization: OrganizationId,
});
export type LastOrganization = typeof LastOrganization.Type;

/** Cookies do not distinguish ports, so local cloud and self-host keep separate memories. */
export const lastOrganizationCookie = (host: string) => {
  const port = new URL(`http://${host}`).port;
  return `executor-org${port === "" ? "" : `-${port}`}`;
};

/** Parse the saved memory for this signed-in person; anything else is ignored. */
export const readLastOrganization = (
  value: string | undefined,
  session: BrowserSession,
): LastOrganization | null => {
  if (value === undefined || session === null) return null;
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(LastOrganization))(value);
  return Option.isSome(parsed) && parsed.value.user === session.user.id ? parsed.value : null;
};
