/** OpenAPI helpers over normalized operation metadata; no optional dependency is needed. */
import { protocolRouter, type OperationKinds } from "./implementation/protocol-operations.ts";
import { Effect, Schema } from "effect";
import type { OpenapiToolsOptions } from "./contracts/openapi.ts";
import { JsonObject } from "./contracts/schema.ts";
import { openapiToolsEffect } from "./implementation/openapi.ts";
import { compiledOperationNames } from "./implementation/openapi-compile.ts";
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

/** One operation a document declares, as `openapiOperationNames` lists it. */
export interface OpenapiDeclaredOperation {
  /** The tool name `liveOpenapiRouter` gives the operation. */
  readonly name: string;
  /** The HTTP method, such as `GET`. */
  readonly method: string;
  /** The path as the document declares it. */
  readonly path: string;
}

/**
 * Every operation a document declares, in document order, with the name `liveOpenapiRouter` gives
 * it, whether or not the router can import it. Unlike `planOperationNames`, it reads the document
 * as the router does, references included. It rejects with `OpenapiCompileError` when the
 * document is not one the router reads. The document is not modified.
 */
export const openapiOperationNames = (
  document: Readonly<Record<string, unknown>>,
): Promise<readonly OpenapiDeclaredOperation[]> =>
  Effect.runPromise(
    Effect.suspend(() =>
      compiledOperationNames(
        // A copy the reader can own, as a tree.
        Schema.decodeUnknownSync(JsonObject)(JSON.parse(JSON.stringify(document))),
      ),
    ),
  );
export {
  liveOpenapiRouter,
  prepareOpenapiImport,
  openapiToolNames,
  type OpenapiSourceOptions,
  type OpenapiToolNamesOptions,
} from "./implementation/openapi-source.ts";
