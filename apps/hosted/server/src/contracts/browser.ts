import { Option, Schema } from "effect";
import { OrganizationId } from "./organization.ts";
import type { ResourceOrigins } from "@executor-js/mcp-auth";

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
const isControl = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
};

export const browserReturnTo = (value: unknown): string => {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.includes("\\") || [...value].some(isControl)) return "/";
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
  const path = target.pathname + target.search + target.hash;
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
};

export interface HostedDocumentContext {
  readonly session: BrowserSession;
  readonly lastOrganization: LastOrganization | null;
  readonly resourceOrigins: ResourceOrigins;
}

export const LastOrganization = Schema.Struct({
  user: Schema.String,
  organization: OrganizationId,
});
export type LastOrganization = typeof LastOrganization.Type;

export const lastOrganizationCookie = (host: string) => {
  const port = new URL(`http://${host}`).port;
  return `executor-org${port === "" ? "" : `-${port}`}`;
};

export const readLastOrganization = (
  value: string | undefined,
  session: BrowserSession,
): LastOrganization | null => {
  if (value === undefined || session === null) return null;
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(LastOrganization))(value);
  return Option.isSome(parsed) && parsed.value.user === session.user.id ? parsed.value : null;
};
