/** OpenAPI helpers over normalized operation metadata; no optional dependency is needed. */
import { protocolOperations, type OperationKinds } from "./implementation/protocol-operations.ts";
import { Effect } from "effect";
import type { OpenapiToolsOptions } from "./contracts/openapi.ts";
import { openapiToolsEffect } from "./implementation/openapi.ts";
export {
  OpenapiError,
  isOpenapiTextMedia,
  openapiBinaryResultSchema,
  OpenapiErrorResponse,
  type OpenapiToolsOptions,
  type OpenapiOperation,
  type CredentialBinding,
  OpenapiParameter,
  OpenapiRequestBody,
  openapiMediaKind,
} from "./contracts/openapi.ts";

/** Discover operations for the selected account. Kinds override uncertain upstream read-only hints. */
export const openapiOperations = (options: OpenapiToolsOptions, kinds: OperationKinds = {}) =>
  Effect.runPromise(
    openapiToolsEffect(options).pipe(
      Effect.map((operations) => protocolOperations(operations, kinds)),
    ),
    options.signal === undefined ? {} : { signal: options.signal },
  );

export type { OperationKinds } from "./implementation/protocol-operations.ts";

export * from "./contracts/openapi-compile.ts";
export {
  liveOpenapiOperations,
  type OpenapiSourceOptions,
} from "./implementation/openapi-source.ts";
