import { HostedProfiles } from "./profiles.ts";
import { HostedResourceAccess } from "./resource-access.ts";
import { HostedSchedules } from "./schedules.ts";
import { HostedAppAccess, HostedAppManagementApi } from "./app-management.ts";
export { HostedAppManagementApi } from "./app-management.ts";
/** Common hosted contracts. Product reads require a hosted session. */
import { CatalogEntry, CatalogUnavailable } from "@executor-js/catalog/contracts";
import { Context, Schema } from "effect";
import { HostedGroups } from "./groups.ts";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { AuthenticationUnavailable, Principal, RequireUser, Unauthorized } from "./auth.ts";
import {
  HostedOrganization,
  OrganizationForbidden,
  OrganizationId,
  OrganizationRole,
  RequireOrganization,
} from "./organization.ts";
import { HostedApps } from "./apps.ts";
import { HostedAccounts } from "./accounts.ts";
import { HostedAppData } from "./app-data.ts";
import { HostedWebhookSetup } from "./webhook-setup.ts";
import { HostedWorkflows } from "./workflows.ts";
import { HostedWebhooks } from "./webhooks.ts";
import { HostedTools } from "./tools.ts";
import { HostedSkills } from "./skills.ts";

/** Process liveness only; this does not probe integrations.sh or future storage. */
export const Health = Schema.Struct({ status: Schema.Literal("ok") });

/** The Effect snapshot's OpenAPI types omit OAuth2; hosted documents retain that standard scheme explicitly. */
export interface HostedApiDocument extends Omit<OpenApi.OpenAPISpec, "components"> {
  readonly components: Omit<OpenApi.OpenAPISpec["components"], "securitySchemes"> & {
    readonly securitySchemes: Record<
      string,
      | OpenApi.OpenAPISecurityScheme
      | {
          readonly type: "oauth2";
          readonly flows: {
            readonly authorizationCode: {
              readonly authorizationUrl: string;
              readonly tokenUrl: string;
              readonly scopes: Record<string, string>;
            };
          };
        }
    >;
  };
}

/** Generate the complete product document; security follows the middleware that serves each endpoint. */
export const hostedApiDocument = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  origin: string,
  cookiePrefix: string,
): HostedApiDocument => {
  const security = new Map<string, Array<OpenApi.OpenAPISecurityRequirement>>();
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint, group, middleware, mergedAnnotations }) => {
      if (Context.get(mergedAnnotations, OpenApi.Exclude))
        throw new Error("Product API endpoints must appear in OpenAPI.");
      const id = Context.getOrElse(endpoint.annotations, OpenApi.Identifier, () =>
        group.topLevel ? endpoint.identifier : `${group.identifier}.${endpoint.identifier}`,
      );
      if (security.has(id)) throw new Error(`Duplicate product API operation: ${id}`);
      security.set(
        id,
        [...middleware].some((service) => service.key === RequireUser.key)
          ? [{ browserSession: [] }]
          : [...middleware].some(
                (service) =>
                  service.key === RequireOrganization.key || service.key === HostedAppAccess.key,
              )
            ? [{ oauth: ["executor"] }, { browserSession: [] }]
            : [],
      );
    },
  });
  const document = OpenApi.fromApi(api);
  let count = 0;
  const paths = Object.fromEntries(
    Object.entries(document.paths).map(([path, item]) => [
      path,
      {
        ...item,
        ...Object.fromEntries(
          (["get", "post", "put", "patch", "delete", "head", "options", "trace"] as const).flatMap(
            (method) => {
              const operation = item[method];
              if (operation === undefined) return [];
              const required = security.get(operation.operationId);
              if (required === undefined)
                throw new Error(`Undeclared product API operation: ${operation.operationId}`);
              count++;
              return [
                [
                  method,
                  { ...operation, security: required.length === 0 ? operation.security : required },
                ],
              ];
            },
          ),
        ),
      },
    ]),
  );
  if (count !== security.size) throw new Error("Product API and OpenAPI operation counts differ.");
  return {
    ...document,
    components: {
      ...document.components,
      securitySchemes: {
        ...document.components.securitySchemes,
        browserSession: {
          type: "apiKey",
          in: "cookie",
          name: `${new URL(origin).protocol === "https:" ? "__Secure-" : ""}${cookiePrefix}.session_token`,
          description:
            "Browser-managed session. Sign in through this deployment; bearer credentials cannot call session-only endpoints.",
        },
        oauth: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "/api/auth/oauth2/authorize",
              tokenUrl: "/api/auth/oauth2/token",
              scopes: { executor: "Use Executor in the selected organization" },
            },
          },
        },
      },
    },
    paths,
  };
};

/** Common API contract; each host extends it with its own groups. */
export const HostedApi = HttpApi.make("executor-hosted")
  .add(
    HostedProfiles,
    HostedWebhookSetup,
    HostedWebhooks,
    HostedWorkflows,
    HostedApps,
    HostedSkills,
    HostedSchedules,
    HostedAccounts,
    HostedTools,
    HostedOrganization,
    HostedGroups,
    HostedResourceAccess,
    HostedAppData,
  )
  .add(
    HttpApiGroup.make("context").add(
      HttpApiEndpoint.get("get", "/api/context", {
        success: Schema.Struct({
          organization: OrganizationId,
          slug: Schema.NonEmptyString,
          role: OrganizationRole,
        }),
        error: [Unauthorized, OrganizationForbidden, AuthenticationUnavailable],
      }).annotate(OpenApi.Override, { security: [{ oauth: ["executor"] }] }),
    ),
  )
  .add(HttpApiGroup.make("health").add(HttpApiEndpoint.get("get", "/health", { success: Health })))
  .add(
    HttpApiGroup.make("viewer")
      .add(HttpApiEndpoint.get("get", "/api/viewer", { success: Principal }))
      .middleware(RequireUser),
  )
  .add(
    HttpApiGroup.make("catalog")
      .add(
        HttpApiEndpoint.get("list", "/api/catalog", {
          success: Schema.Array(CatalogEntry),
          error: CatalogUnavailable,
        }),
      )
      .middleware(RequireUser),
  )
  .addHttpApi(HostedAppManagementApi);
