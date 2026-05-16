import { Effect, Layer } from "effect";

import { ApiKeyService } from "./api-keys";
import { ApiKeyManagementError } from "./api-key-errors";

export const ApiKeyServiceTestLayer = Layer.succeed(ApiKeyService)({
  validate: () => Effect.succeed(null),
  listUserKeys: () => Effect.succeed([]),
  createUserKey: () => Effect.fail(new ApiKeyManagementError({ cause: "unstubbed" })),
  revokeUserKey: () => Effect.void,
});
