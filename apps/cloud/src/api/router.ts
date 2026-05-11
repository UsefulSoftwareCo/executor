import { Layer } from "effect";

import { UserStoreService } from "../auth/context";
import { DbService } from "../services/db";

import { AutumnRoutesLive } from "./autumn";
import { ApiErrorLoggingLive } from "./error-logging";
import {
  BootSharedServices,
  RequestScopedServicesLive,
  RouterConfig,
  makeNonProtectedApiLive,
  makeOrgApiLive,
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
export const makeApiLive = (requestScopedLive: Layer.Layer<DbService | UserStoreService>) =>
  Layer.mergeAll(
    makeNonProtectedApiLive(requestScopedLive),
    makeOrgApiLive(requestScopedLive),
    makeProtectedApiLive(requestScopedLive),
    AutumnRoutesLive,
    ApiErrorLoggingLive,
  ).pipe(Layer.provideMerge(RouterConfig), Layer.provideMerge(BootSharedServices));

export const ApiLive = makeApiLive(RequestScopedServicesLive);
