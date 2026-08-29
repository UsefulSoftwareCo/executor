import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";

export class SystemError extends Schema.TaggedErrorClass<SystemError>()(
  "SystemError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

export const HealthResponse = Schema.Struct({ status: Schema.String });
export const SetupStatusResponse = Schema.Struct({ needsSetup: Schema.Boolean });
export const InviteStatusResponse = Schema.Struct({ valid: Schema.Boolean });

const InviteStatusParams = { code: Schema.String };

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
  )
  .add(
    HttpApiEndpoint.get("inviteStatus", "/invite-status/:code", {
      params: InviteStatusParams,
      success: InviteStatusResponse,
      error: [SystemError],
    }),
  );

export const SystemHttpApi = HttpApi.make("executor-self-host-system").add(SystemApi);
