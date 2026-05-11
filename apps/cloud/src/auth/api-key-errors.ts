import { Schema } from "effect";

export class ApiKeyManagementError extends Schema.TaggedErrorClass<ApiKeyManagementError>()(
  "ApiKeyManagementError",
  { cause: Schema.Unknown },
  { httpApiStatus: 500 },
) {}
