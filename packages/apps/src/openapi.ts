/** OpenAPI helpers over normalized operation metadata; no optional dependency is needed. */
import { protocolRouter, type OperationKinds } from "./implementation/protocol-operations.ts";
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

/**
 * Discover a document's operations as a router for the selected account. Kinds override uncertain
 * upstream read-only hints. Mount it under a key, or override its metadata with `router(...)`.
 */
export const openapiRouter = (options: OpenapiToolsOptions, kinds: OperationKinds = {}) =>
  Effect.runPromise(
    openapiToolsEffect(options).pipe(Effect.map((operations) => protocolRouter(operations, kinds))),
    options.signal === undefined ? {} : { signal: options.signal },
  );

export type { OperationKinds } from "./implementation/protocol-operations.ts";

export * from "./contracts/openapi-compile.ts";
/**
 * The names `liveOpenapiRouter` gives a document's operations, from each operation's
 * operationId, first tag, method and path alone. It reads no document and compiles nothing.
 */
export { planOperationNames, type OperationNameInput } from "./implementation/openapi-names.ts";
export {
  liveOpenapiRouter,
  openapiToolNames,
  type OpenapiSourceOptions,
  type OpenapiToolNamesOptions,
} from "./implementation/openapi-source.ts";
