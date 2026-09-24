/** Evaluate normalized metadata into ordinary tools, with account-specific security filtering. */
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { OpenapiError, OpenapiToolsOptions, type OpenapiTools } from "../contracts/openapi.ts";
import { jsonSchemaDecoder } from "./schema.ts";
import { createRequest } from "./openapi-request.ts";

/** Decode retained metadata and expose only operations supported by the selected account. */
export const openapiToolsEffect = (
  options: OpenapiToolsOptions,
): Effect.Effect<OpenapiTools, OpenapiError> =>
  Effect.gen(function* () {
    const config = yield* Schema.decodeUnknownEffect(OpenapiToolsOptions)(options).pipe(
      Effect.mapError(() => new OpenapiError({ reason: "invalid_definition" })),
    );
    const request = createRequest(config);
    const entries = yield* Effect.forEach(
      config.operations.filter((op) => request.available(op, config.account)),
      (op) =>
        Effect.gen(function* () {
          const input = yield* jsonSchemaDecoder(op.input).pipe(
            Effect.mapError(() => new OpenapiError({ reason: "invalid_definition" })),
          );
          const errors = yield* Effect.forEach(op.errorResponses ?? [], (response) =>
            jsonSchemaDecoder(response.schema).pipe(
              Effect.map((decoder) => ({ ...response, decoder })),
              Effect.mapError(() => new OpenapiError({ reason: "invalid_definition" })),
            ),
          );
          const tool: OpenapiTools[string] = {
            description: op.description,
            readOnly: ["GET", "HEAD", "OPTIONS"].includes(op.method),
            input,
            ...(op.outputSchema === undefined ? {} : { outputSchema: op.outputSchema }),
            run: (_context, value) =>
              Schema.decodeUnknownEffect(input)(value).pipe(
                Effect.mapError(() => new OpenapiError({ reason: "invalid_input" })),
                Effect.flatMap((parsed) =>
                  request
                    .call(op, parsed, config.account, errors)
                    .pipe(
                      Effect.provideService(
                        FetchHttpClient.Fetch,
                        config.fetch ?? globalThis.fetch,
                      ),
                    ),
                ),
              ),
          };
          return [op.name, tool] as const;
        }),
    );
    return Object.fromEntries(entries);
  });
