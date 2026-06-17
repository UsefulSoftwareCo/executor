import { Context, Effect, Option } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { isValidOrgSlug } from "../account/org-slug";

export class TenantScope extends Context.Service<
  TenantScope,
  {
    readonly selector: string;
  }
>()("@executor-js/api/TenantScope") {}

export const currentTenantSelector = Effect.map(Effect.serviceOption(TenantScope), (scope) =>
  Option.match(scope, {
    onNone: () => null,
    onSome: (value) => value.selector,
  }),
);

export const tenantApiMountPrefix = "/:tenant/api" as const;

export const tenantApiPath = (tenant: string, apiPath = ""): string =>
  `/${tenant}/api${apiPath.startsWith("/") ? apiPath : apiPath ? `/${apiPath}` : ""}`;

export const tenantFromApiPath = (pathname: string): string | null => {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2 || segments[1] !== "api") return null;
  const tenant = segments[0];
  return tenant && isValidOrgSlug(tenant) ? tenant : null;
};

export const isTenantApiPath = (pathname: string): boolean => tenantFromApiPath(pathname) !== null;

export const TenantScopeMiddleware = HttpRouter.middleware<{ provides: TenantScope }>()(
  (httpEffect) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const tenant = params.tenant;
      if (!tenant || !isValidOrgSlug(tenant)) {
        return HttpServerResponse.text("Not found", { status: 404 });
      }
      return yield* Effect.provideService(httpEffect, TenantScope, { selector: tenant });
    }),
);
