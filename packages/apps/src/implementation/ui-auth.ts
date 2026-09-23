/** Trusted bootstrap documents run before authored UI and never contain product credentials. */
import { HttpServerResponse } from "effect/unstable/http";

/** Private app responses must not leak authentication URLs through caches or referrers. */
export const appPrivateHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "frame-ancestors 'none'",
};

/** Serve only a fixed host script while authentication runs; the original URL remains available to that script. */
export const appSignInPage = () =>
  HttpServerResponse.text(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening app</title></head><body><p>Opening app…</p><a href="/" hidden>Try again</a><script src="/_executor/auth/browser.js"></script></body></html>`,
    {
      contentType: "text/html",
      headers: {
        ...appPrivateHeaders,
        "content-security-policy":
          "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      },
    },
  );

/** Preserve deep links, erase callback proofs before any request, and let the host set HttpOnly cookies. */
export const appSignInScript = () =>
  HttpServerResponse.text(
    `
const callback = location.pathname === "/_executor/auth/callback";
const parameters = new URLSearchParams(location.hash.slice(1));
const body = callback
  ? {request: parameters.get("request"), code: parameters.get("code")}
  : {returnTo: location.pathname + location.search + location.hash};
if (callback) history.replaceState(null, "", location.pathname);
fetch(callback ? "/_executor/auth/complete" : "/_executor/auth/start", {
  method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(body)
}).then(async response => {
  if (!response.ok) throw new Error();
  const result = await response.json();
  location.replace(callback ? result.returnTo : result.url);
}).catch(() => {
  document.querySelector("p").textContent = "Could not sign in to this app. Try opening it again.";
  document.querySelector("a").hidden = false;
});`,
    { contentType: "text/javascript", headers: appPrivateHeaders },
  );
