import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Public system API — unauthenticated status endpoints served under /api.
//
//   GET /api/health        readiness probe (used by the container healthcheck)
//   GET /api/setup-status  whether the instance still needs first-run setup, so
//                          the pre-login SPA can route a fresh operator to /setup
//
// Both are deliberately unauthenticated and return only booleans/status — no
// sensitive data — so they can be read before anyone has signed in.
// ---------------------------------------------------------------------------

export class SystemError extends Schema.TaggedErrorClass<SystemError>()(
  "SystemError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

export const HealthResponse = Schema.Struct({ status: Schema.String });
export const SetupStatusResponse = Schema.Struct({ needsSetup: Schema.Boolean });

export const SystemApi = HttpApiGroup.make("system")
  .add(
    HttpApiEndpoint.get("health", "/health", {
      success: HealthResponse,
      error: [SystemError],
    }),
  )
  .add(
    HttpApiEndpoint.get("setupStatus", "/setup-status", {
      success: SetupStatusResponse,
      error: [SystemError],
    }),
  );

export const SystemHttpApi = HttpApi.make("executor-self-host-system").add(SystemApi);
