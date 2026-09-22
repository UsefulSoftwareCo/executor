import * as Sentry from "@sentry/react";
import { BrowserOperationFailure, browserPageId } from "@executor-js/telemetry/browser";
import { Schema, Option } from "effect";

/**
 * OAuth codes, MCP authorization parameters and invitation tokens all travel in
 * the query string or fragment of a first-visit URL. Nothing carrying one may
 * reach Sentry, from a request URL or from a navigation, fetch or xhr breadcrumb.
 */
export const strippedUrl = (value: string): string => {
  const url = URL.parse(value, "https://executor.invalid");
  if (url === null) return value;
  url.search = "";
  url.hash = "";
  return url.origin === "https://executor.invalid" ? url.pathname : url.href;
};

/** Breadcrumb URLs live in `data`; the SDK records them as relative paths with a query. */
export const strippedBreadcrumb = <A extends { data?: Record<string, unknown> | undefined }>(
  crumb: A,
): A => {
  const data = crumb.data;
  if (data === undefined) return crumb;
  for (const key of ["from", "to", "url"]) {
    const value = data[key];
    if (typeof value === "string") data[key] = strippedUrl(value);
  }
  return crumb;
};

/** Call once at the browser composition root; unconfigured local builds remain disabled. */
export const startErrorReporting = () => {
  const dsn: unknown = import.meta.env.VITE_SENTRY_DSN;
  if (typeof dsn !== "string" || dsn.length === 0) return;
  const tunnel: unknown = import.meta.env.VITE_SENTRY_TUNNEL;
  if (typeof tunnel !== "string" || !/^\/api\/[a-f0-9]{16}\/submit$/.test(tunnel))
    throw new Error("Sentry tunnel path is missing from this build");
  window.addEventListener("executor:operation-failed", (event) => {
    if (!(event instanceof CustomEvent)) return;
    const value = Schema.decodeUnknownOption(BrowserOperationFailure)(event.detail);
    if (Option.isSome(value))
      Sentry.captureException(new Error(value.value.error_type), {
        contexts: { trace: { trace_id: value.value.trace_id, span_id: value.value.span_id } },
        tags: { error_type: value.value.error_type, page_id: value.value.page_id },
      });
  });
  Sentry.init({
    tunnel,
    dsn,
    environment: import.meta.env.VITE_EXECUTOR_ENVIRONMENT,
    release: import.meta.env.VITE_EXECUTOR_RELEASE,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    initialScope: {
      tags: { product_version: "v2", surface: "dashboard", page_id: browserPageId() },
    },
    // Breadcrumbs are attached before this hook runs, so they are scrubbed here too.
    beforeBreadcrumb: (crumb) => strippedBreadcrumb(crumb),
    beforeSend: (event) => {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.headers;
        delete event.request.data;
        if (event.request.url) event.request.url = strippedUrl(event.request.url);
      }
      if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(strippedBreadcrumb);
      return event;
    },
  });
};

/** Boot failures are reported after early initialization, with no entry data attached. */
export const reportBootFailure = (error: unknown) => Sentry.captureException(error);
