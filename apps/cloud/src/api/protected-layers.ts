// Protected-side API wiring. Kept separate from `./layers.ts` so tests
// can import the protected API + shared services without dragging in
// non-protected/org handlers (which transitively import
// `@tanstack/react-start`, unresolvable in the Workers test runtime).

import { env } from "cloudflare:workers";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { Layer } from "effect";

import { observabilityMiddleware } from "@executor-js/api";
import { CoreHandlers, composePluginApi, composePluginHandlerLayer } from "@executor-js/api/server";

import { cloudPlugins } from "./cloud-plugins";
import { UserStoreService } from "../auth/context";
import { WorkOSAuth } from "../auth/workos";
import { AutumnService } from "../services/autumn";
import { DbService } from "../services/db";
import { ErrorCaptureLive } from "../observability";

// `ProtectedCloudApi` deliberately does NOT declare `.middleware(OrgAuth)`
// — auth + per-request execution stack construction live in a single
// `HttpRouter` middleware (`ExecutionStackMiddleware` in `./protected.ts`)
// which has the right ordering to provide `AuthContext` AND the executor
// services to handlers. Putting auth on the API as `HttpApiMiddleware` ran
// it INSIDE the router middleware (wrong order), and added a second auth
// pass on top of the existing one in `protected.ts`'s outer effect. The
// router-middleware approach folds both into one place.
//
// `composePluginApi(cloudPlugins)` returns a precisely typed `HttpApi`
// — the group union is derived from `typeof cloudPlugins` via the
// plugin spec's `TGroup` generic. Test harness clients type via
// `HttpApiClient.ForApi<typeof ProtectedCloudApi>` directly, with no
// per-plugin Group imports at the host.
export const ProtectedCloudApi = composePluginApi(cloudPlugins);

const ObservabilityLive = observabilityMiddleware(ProtectedCloudApi);

type TestEnv = typeof env & {
  readonly EXECUTOR_TEST_DIRECT_PGLITE?: string;
};

const DbLive =
  (env as TestEnv).EXECUTOR_TEST_DIRECT_PGLITE === "true"
    ? DbService.TestDirectPglite
    : DbService.Production;
const UserStoreLive = UserStoreService.Live.pipe(Layer.provide(DbLive));

export const SharedServices = Layer.mergeAll(
  DbLive,
  UserStoreLive,
  WorkOSAuth.Default,
  AutumnService.Default,
  HttpServer.layerServices,
);

export const RouterConfig = Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 });

// Every handler the ProtectedCloudApi routes to. Plugin handler layers
// are late-binding — they require their plugin's `extensionService`
// Tag, which the per-request `ExecutionStackMiddleware` satisfies via
// `providePluginExtensions`. The test harness mirrors this; nothing
// else needs to know which plugins are wired.
export const ProtectedCloudApiHandlers = Layer.mergeAll(
  CoreHandlers,
  composePluginHandlerLayer(cloudPlugins),
);

// `ErrorCaptureLive` is provided above the handler + middleware layers
// so the `withCapture` translation path (typed-channel `StorageError →
// InternalError(traceId)`) AND the observability middleware's defect
// catchall both see the same Sentry-backed implementation.
export const ProtectedCloudApiLive = HttpApiBuilder.layer(ProtectedCloudApi).pipe(
  Layer.provide(Layer.mergeAll(ProtectedCloudApiHandlers, ObservabilityLive)),
  Layer.provide(ErrorCaptureLive),
);
