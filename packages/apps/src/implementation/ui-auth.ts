/** Host responses around app sign-in. They carry no script and never contain product credentials. */
import { HttpServerResponse } from "effect/http";
import { appSignInCallbackPath, type AppSignInId } from "../contracts/ui-auth.ts";

/** Private app responses must not leak authentication URLs through caches or referrers. */
export const appPrivateHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "frame-ancestors 'none'",
};

/** Every sign-in hop is a server redirect, so the browser paints nothing until the app itself. */
export const appRedirect = (url: string) =>
  HttpServerResponse.redirect(url, { status: 302, headers: appPrivateHeaders });

/**
 * The callback URL carries the code in its query. It exists only as a redirect `Location`, never as
 * a rendered document, and redeeming it also requires the attempt's HttpOnly cookie.
 */
export const appSignInCallback = (origin: string, request: AppSignInId, code: string) => {
  const callback = new URL(appSignInCallbackPath, origin);
  callback.searchParams.set("request", request);
  callback.searchParams.set("code", code);
  return callback.href;
};

/** A failed callback explains itself without script; reopening the app URL starts a new attempt. */
export const appSignInFailed = () =>
  HttpServerResponse.text(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Could not open app</title></head><body><p>Could not sign in to this app. Try opening it again.</p><a href="/">Try again</a></body></html>`,
    {
      status: 401,
      contentType: "text/html",
      headers: {
        ...appPrivateHeaders,
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      },
    },
  );
