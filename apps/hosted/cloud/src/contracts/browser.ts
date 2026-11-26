import { parseCookies } from "better-auth/cookies";
import { hostCookieName } from "@executor-js/hosted-server/browser/contracts";
import { cloudDevelopmentOrigin } from "./development.ts";
import { LoopbackOrigin } from "@executor-js/utils/url-policy";
import { Schema } from "effect";

export const cloudSessionCookiePrefix = (origin: string): string => {
  if (origin === cloudDevelopmentOrigin) return "executor-cloud-dev";
  if (!Schema.is(LoopbackOrigin)(origin)) return hostCookieName(origin, "executor-hosted");
  const url = new URL(origin);
  const port = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
  return hostCookieName(origin, `executor-cloud-dev-${port}`);
};

export const builtApiOrigin = "https://executor.invalid";

export const servesBuiltApiDocument = (origin: string) =>
  new URL(origin).protocol === "https:" &&
  cloudSessionCookiePrefix(origin) === cloudSessionCookiePrefix(builtApiOrigin);

export const hasSessionCookie = (headers: Headers, cookiePrefix: string): boolean =>
  Boolean(parseCookies(headers.get("cookie") ?? "").get(`${cookiePrefix}.session_token`));
