import { getSessionCookie } from "better-auth/cookies";
import { cloudDevelopmentOrigin } from "./development.ts";
import { LoopbackOrigin } from "@executor-js/utils/url-policy";
import { Schema } from "effect";

/** Browsers share cookies across ports, so local cloud and self-host use different names. */
export const cloudSessionCookiePrefix = (origin: string): string => {
  if (origin === cloudDevelopmentOrigin) return "executor-cloud-dev";
  if (!Schema.is(LoopbackOrigin)(origin)) return "executor-hosted";
  const url = new URL(origin);
  const port = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
  return `executor-cloud-dev-${port}`;
};

/** A routing hint only: product pages and APIs still verify the live session. */
export const hasSessionCookie = (headers: Headers, cookiePrefix: string): boolean =>
  Boolean(getSessionCookie(headers, { cookiePrefix }));
