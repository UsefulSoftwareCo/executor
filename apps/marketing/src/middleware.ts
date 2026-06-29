import type { MiddlewareHandler } from "astro";

// PostHog reverse proxy — the browser SDK targets a first-party path and we
// forward to PostHog's ingest + asset hosts. Keeps events flowing past
// adblockers that match *.posthog.com. See
// https://posthog.com/docs/advanced/proxy/cloudflare
//
// The path MUST sit under a prefix that the cloud worker's edge forwards to
// this worker. On the production apex (executor.sh) the cloud worker owns the
// custom domain and only proxies an allow-list to executor-marketing; `/api/*`
// stays in cloud (it has its own posthog proxy on a randomized path), so a
// top-level `/api/...` path here 404s. `/_astro` IS forwarded, so we ride it.
const POSTHOG_INGEST_HOST = "us.i.posthog.com";
const POSTHOG_ASSETS_HOST = "us-assets.i.posthog.com";
const POSTHOG_PROXY_PATH = "/_astro/_ph";

export const onRequest: MiddlewareHandler = async (context, next) => {
  const { pathname } = new URL(context.request.url);
  if (pathname !== POSTHOG_PROXY_PATH && !pathname.startsWith(`${POSTHOG_PROXY_PATH}/`)) {
    return next();
  }

  const url = new URL(context.request.url);
  url.hostname = pathname.startsWith(`${POSTHOG_PROXY_PATH}/static/`)
    ? POSTHOG_ASSETS_HOST
    : POSTHOG_INGEST_HOST;
  url.protocol = "https:";
  url.port = "";
  url.pathname = pathname.slice(POSTHOG_PROXY_PATH.length) || "/";

  const upstream = new Request(url, context.request);
  upstream.headers.delete("cookie");
  return fetch(upstream);
};
