/** Cloud's dashboard document adapter. Static assets stay on Cloudflare's asset server. */
import { dashboardDocument, type DashboardServer } from "@executor-js/dashboard-start/document";
import type { DocumentApi } from "@executor-js/dashboard-start/document-api";
import { hostedDocumentContext } from "@executor-js/hosted-server/document";
import type { ResourceOrigins } from "@executor-js/hosted-server";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { DashboardRenderer } from "../contracts/dashboard.ts";
import type { CloudEntryPage } from "../contracts/entry.ts";
import type { CloudDocumentContext } from "@executor-js/hosted-cloud-web/document";
import dashboardRoutes from "@executor-js/hosted-cloud-web/routes" with { type: "json" };

/** What every Cloud page needs to know about the deployment's hosts. */
export interface CloudPageHosts {
  readonly resourceOrigins: ResourceOrigins;
  /** The host whose passkeys stopped working when the dashboard moved off it, if it moved. */
  readonly formerPasskeyHost: string | null;
  /** Where the deployment serves its documentation, as an absolute URL ending in `/`. */
  readonly documentation: string;
}

/**
 * Cloud pages also receive the sign-in or setup data resolved for this request, if any, where
 * the deployment serves its MCP and API resources, and the host passkeys may have come from.
 */
export const cloudDocumentContext =
  (hosts: CloudPageHosts) => (entry: CloudEntryPage | null) => (api: DocumentApi) =>
    Effect.gen(function* () {
      const document = yield* hostedDocumentContext(hosts.resourceOrigins)(api);
      return {
        ...document,
        entry,
        formerPasskeyHost: hosts.formerPasskeyHost,
        documentation: hosts.documentation,
      };
    });

/**
 * Render dashboard documents in the Dashboard Worker. This Worker never uploads React: every
 * uploaded module is compiled when an isolate starts, and most requests are API requests. The
 * renderer's reads come back to this request's own pipeline, so they keep its identity and trace.
 */
export const cloudDashboard = (renderer: DashboardRenderer, hosts: CloudPageHosts) => {
  // The binding resolves from the Worker environment, so each render runs with the request's
  // services, which also parent its spans to the document request.
  const server = Effect.map(
    Effect.context<never>(),
    (services): DashboardServer<CloudDocumentContext> => ({
      fetch: (request, { context: { apiFetch, ...context } }) =>
        Effect.runPromiseWith(services)(
          renderer
            .render(request, context, (url, init) =>
              apiFetch(url, {
                method: init.method,
                headers: init.headers.map(([name, value]): [string, string] => [name, value]),
              }),
            )
            .pipe(Effect.tapCause((cause) => Effect.logError("Dashboard render failed", cause))),
        ),
    }),
  );
  /** Render one dashboard document for the current request. */
  return (entry: CloudEntryPage | null) =>
    dashboardDocument({ server, context: cloudDocumentContext(hosts)(entry) });
};

/**
 * Page routes the Worker renders directly. Sign-in and team setup are resolved first by the entry
 * handler. The router matches a trailing slash itself; only Cloudflare's list needs both forms.
 */
export const dashboardPageRoutes = dashboardRoutes.filter(
  (route): route is `/${string}` =>
    route.startsWith("/") &&
    !route.endsWith("/") &&
    !["/login", "/login/sso", "/create"].includes(route),
);

/**
 * An organization root opens its apps. The Worker answers it before any document work: the
 * redirect needs no session, because the destination checks it, so it costs one round trip
 * rather than a session lookup and a render. The router applies the same redirect in the browser.
 */
export const organizationRoot = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(request.url, "http://executor.internal");
  return HttpServerResponse.redirect(`${url.pathname.replace(/\/?$/, "/apps")}${url.search}`, {
    status: 307,
  });
});
