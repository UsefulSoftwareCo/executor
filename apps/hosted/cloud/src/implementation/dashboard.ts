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

export interface CloudPageHosts {
  readonly resourceOrigins: ResourceOrigins;
  readonly formerPasskeyHost: string | null;
  readonly documentation: string;
}

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

export const cloudDashboard = (renderer: DashboardRenderer, hosts: CloudPageHosts) => {
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
  return (entry: CloudEntryPage | null) =>
    dashboardDocument({ server, context: cloudDocumentContext(hosts)(entry) });
};

export const dashboardPageRoutes = dashboardRoutes.filter(
  (route): route is `/${string}` =>
    route.startsWith("/") &&
    !route.endsWith("/") &&
    !["/login", "/login/sso", "/create"].includes(route),
);

export const organizationRoot = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(request.url, "http://executor.internal");
  return HttpServerResponse.redirect(`${url.pathname.replace(/\/?$/, "/apps")}${url.search}`, {
    status: 307,
  });
});
