import { parseCookies } from "better-auth/cookies";
import { hostCookieName } from "@executor-js/hosted-server/browser/contracts";
import { cloudDevelopmentOrigin } from "./development.ts";
import { LoopbackOrigin } from "@executor-js/utils/url-policy";
import { Schema } from "effect";

/** Browsers share cookies across ports, so local cloud and self-host use different names. */
export const cloudSessionCookiePrefix = (origin: string): string => {
  if (origin === cloudDevelopmentOrigin) return "executor-cloud-dev";
  if (!Schema.is(LoopbackOrigin)(origin)) return hostCookieName(origin, "executor-hosted");
  const url = new URL(origin);
  const port = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
  return hostCookieName(origin, `executor-cloud-dev-${port}`);
};

/** The origin the build generates the API document for, to hash it; see `servesBuiltApiDocument`. */
export const builtApiOrigin = "https://executor.invalid";

/**
 * Whether the API at `origin` serves the document the build hashed. The origin enters the document
 * only through the session cookie's name, which every HTTPS origin outside development shares.
 */
export const servesBuiltApiDocument = (origin: string) =>
  new URL(origin).protocol === "https:" &&
  cloudSessionCookiePrefix(origin) === cloudSessionCookiePrefix(builtApiOrigin);

/** A routing hint only: product pages and APIs still verify the live session. */
export const hasSessionCookie = (headers: Headers, cookiePrefix: string): boolean =>
  Boolean(parseCookies(headers.get("cookie") ?? "").get(`${cookiePrefix}.session_token`));
