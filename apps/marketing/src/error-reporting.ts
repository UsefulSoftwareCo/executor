/** Error-only reporting for public pages, without capability URLs or request data. */
import * as Sentry from "@sentry/browser";
const pathOnly = (value: string) => {
  const url = URL.parse(value, location.origin);
  if (url === null) return "";
  url.search = "";
  url.hash = "";
  return url.href;
};
/** Initialize once from a public surface's bundled entry. Unconfigured builds emit nothing. */
export const startPublicErrorReporting = (
  surface: "marketing" | "docs",
  settings: {
    readonly dsn?: string;
    readonly tunnel?: string;
    readonly environment?: string;
    readonly release?: string;
  },
) => {
  if (!settings.dsn) return;
  if (!settings.tunnel || !/^\/api\/[a-f0-9]{16}\/submit$/.test(settings.tunnel))
    throw new Error("Sentry tunnel path is missing from this build");
  Sentry.init({
    ...settings,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    initialScope: { tags: { product_version: "v2", surface } },
    beforeBreadcrumb: (crumb) => {
      for (const key of ["from", "to", "url"])
        if (typeof crumb.data?.[key] === "string") crumb.data[key] = pathOnly(crumb.data[key]);
      return crumb;
    },
    beforeSend: (event) => {
      if (event.request) {
        delete event.request.headers;
        delete event.request.cookies;
        delete event.request.data;
        if (event.request.url) event.request.url = pathOnly(event.request.url);
      }
      return event;
    },
  });
};
