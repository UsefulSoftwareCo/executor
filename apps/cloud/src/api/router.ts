import { Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";

import {
  RouterConfigLive,
  requestScopedMiddleware,
  type MemberDirectory,
} from "@executor-js/api/server";

import { UserStoreService } from "../auth/context";
import { WorkOsMirror } from "../auth/workos-mirror";
import { DbService } from "../db/db";
import { makeAccountApiLive } from "../account/account-api";
import { AdminMfaRoutes } from "../auth/admin-mfa-routes";

import { AutumnRoutesLive } from "../extensions/billing/route";
import { CloudDocsLive } from "../extensions/docs";
import { ApiErrorLoggingLive } from "../observability/error-logging";
import {
  BootSharedServices,
  RequestScopedServicesLive,
  makeOrgApiLive,
  makeNonProtectedApiLive,
} from "./layers";
import { makeProtectedApiLive } from "./protected";

// Dynamic plugin handler layers intentionally erase their concrete request
// marker union at this composition boundary. HttpRouter supplies those
// markers while building each route; the web handler itself therefore has no
// caller context requirement.
type CloudApiLayer = Layer.Layer<
  never,
  unknown,
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Requires", never>
  | HttpRouter.Request<"GlobalRequires", never>
  | HttpRouter.Request<"Error", never>
  | HttpRouter.Request<"GlobalError", never>
>;

// One router. Each sub-API contributes its routes via `HttpApiBuilder.layer`,
// which calls `HttpRouter.use(...)` under the hood. Autumn's catch-all proxy
// is added as a plain `HttpRouter.add` route. They all merge into the same
// routing table; there is no outer-then-inner router stacking.
//
// The per-request `DbService` + `UserStoreService` wiring is threaded
// through each sub-API's factory. Boot-scoped services come in here via
// `Layer.provideMerge`. `requestScopedLive` is exposed as a parameter
// so tests can substitute a counting fake for `DbService.Live` and
// assert per-request semantics — see
// `apps/cloud/src/api.request-scope.node.test.ts`.
export const makeApiLive = (
  requestScopedLive: Layer.Layer<DbService | UserStoreService | WorkOsMirror | MemberDirectory>,
): CloudApiLayer => {
  const BillingRoutesLive = AutumnRoutesLive.pipe(
    Layer.provide(requestScopedMiddleware(requestScopedLive).layer),
  );
  const appLayer = Layer.mergeAll(
    AdminMfaRoutes.pipe(Layer.provide(requestScopedMiddleware(requestScopedLive).layer)),
    makeNonProtectedApiLive(requestScopedLive),
    makeOrgApiLive(requestScopedLive),
    makeAccountApiLive(requestScopedLive),
    CloudDocsLive,
    makeProtectedApiLive(requestScopedLive),
    BillingRoutesLive,
    ApiErrorLoggingLive,
  ).pipe(Layer.provideMerge(RouterConfigLive), Layer.provideMerge(BootSharedServices));
  return appLayer as CloudApiLayer;
};

export const ApiLive = makeApiLive(RequestScopedServicesLive);

export const handleApiRequest = HttpRouter.toWebHandler(ApiLive).handler;
