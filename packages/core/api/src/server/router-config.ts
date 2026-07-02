import { HttpRouter } from "effect/unstable/http";
import { Layer } from "effect";

// ---------------------------------------------------------------------------
// Shared `HttpRouter.RouterConfig`. Raises `maxParamLength` past the default
// so long path params (scope ids, execution ids, etc.) match instead of being
// truncated at the router's default limit. Every host serves the same routes,
// so they all use this single config.
// ---------------------------------------------------------------------------

export const RouterConfigLive = Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 });
