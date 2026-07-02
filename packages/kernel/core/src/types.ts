import type { StandardSchemaV1 } from "@standard-schema/spec";
import type * as Cause from "effect/Cause";
import type * as Effect from "effect/Effect";

import type { CodeExecutionError } from "./effect-errors";

/** Branded tool path */
export type ToolPath = string & { readonly __toolPath: unique symbol };

export const asToolPath = (value: string): ToolPath => value as ToolPath;

/** Standard Schema alias */
export type StandardSchema<Input = unknown, Output = unknown> = StandardSchemaV1<Input, Output>;

/** A tool that can be invoked */
export interface Tool {
  readonly path: ToolPath;
  readonly description?: string;
  readonly inputSchema: StandardSchema;
  readonly outputSchema?: StandardSchema;
  readonly execute: (input: unknown) => unknown | Promise<unknown>;
}

/** Invoke a tool by path from inside a sandbox */
export interface SandboxToolInvoker {
  invoke(input: { path: string; args: unknown }): Effect.Effect<unknown, unknown, never>;
}

/** User-visible output accumulated by sandbox helpers. */
export type ExecuteOutputItem =
  | {
      readonly type: "file";
      readonly file: unknown;
    }
  | {
      readonly type: "content";
      readonly content: unknown;
    };

/** Result of executing code in a sandbox */
export type ExecuteResult = {
  result: unknown;
  output?: ExecuteOutputItem[];
  error?: string;
  logs?: string[];
};

/**
 * Executes code in a sandboxed runtime with tool access.
 *
 * Error channel is constrained to Effect's `YieldableError` (the base
 * shape `Data.TaggedError(...)` produces) so callers always get a
 * structurally tagged error, never untyped `unknown`. Defaults to
 * `CodeExecutionError`; runtimes can parameterize with their own
 * `Data.TaggedError` subclass — e.g. `CodeExecutor<WorkerLoaderError>`.
 */
export interface CodeExecutor<E extends Cause.YieldableError = CodeExecutionError> {
  execute(code: string, toolInvoker: SandboxToolInvoker): Effect.Effect<ExecuteResult, E>;
}

/** Accept-anything schema for tools with no input validation */
export const unknownInputSchema: StandardSchema = {
  "~standard": {
    version: 1,
    vendor: "@executor-js/codemode-core",
    validate: (value: unknown) => ({
      value,
    }),
  },
};
