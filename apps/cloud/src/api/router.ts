import { Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";

import { RouterConfigLive, requestScopedMiddleware } from "@executor-js/api/server";

import { UserStoreService } from "../auth/context";
import { DbService } from "../db/db";
import { makeAccountApiLive } from "../account/account-api";

import { AutumnRoutesLive } from "../extensions/billing/route";
import { CloudDocsLive } from "../extensions/docs";
import { ApiErrorLoggingLive } from "../observability/error-logging";
import {
  BootSharedServices,
  OrgApiLive,
  RequestScopedServicesLive,
  makeNonProtectedApiLive,
} from "./layers";
import { makeProtectedApiLive } from "./protected";

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
export const makeApiLive = (requestScopedLive: Layer.Layer<DbService | UserStoreService>) => {
  const BillingRoutesLive = AutumnRoutesLive.pipe(
    Layer.provide(requestScopedMiddleware(requestScopedLive).layer),
  );
  return Layer.mergeAll(
    makeNonProtectedApiLive(requestScopedLive),
    OrgApiLive,
    makeAccountApiLive(requestScopedLive),
    CloudDocsLive,
    makeProtectedApiLive(requestScopedLive),
    BillingRoutesLive,
    ApiErrorLoggingLive,
  ).pipe(Layer.provideMerge(RouterConfigLive), Layer.provideMerge(BootSharedServices));
};

export const ApiLive = makeApiLive(RequestScopedServicesLive);

export const handleApiRequest = HttpRouter.toWebHandler(ApiLive).handler;
