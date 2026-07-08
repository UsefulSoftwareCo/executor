import { z } from "zod";

import type { StandardSchemaV1 } from "./standard-schema";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type ToolSchema<TOutput = unknown> = StandardSchemaV1<unknown, TOutput> | JsonObject;

export type AppIntegrationClient = {
  readonly [key: string]: AppIntegrationClient;
} & ((...args: readonly unknown[]) => Promise<unknown>);

export const EXECUTOR_INTEGRATION_META = "~executor";

export interface IntegrationMarker<Slug extends string = string> {
  readonly kind: "integration";
  readonly slug: Slug;
}

export type IntegrationSchema<Slug extends string = string> = z.ZodType<AppIntegrationClient> & {
  readonly [EXECUTOR_INTEGRATION_META]?: IntegrationMarker<Slug>;
};

type InferToolInput<TSchema> = TSchema extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<TSchema>
  : unknown;

type InferToolOutput<TSchema> = TSchema extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<TSchema>
  : unknown;

export interface DefineToolOptions<
  TInputSchema extends ToolSchema,
  TOutputSchema extends ToolSchema | undefined = undefined,
> {
  readonly description: string;
  readonly input: TInputSchema;
  readonly output?: TOutputSchema;
  readonly annotations?: {
    readonly readOnly?: boolean;
    readonly destructive?: boolean;
    readonly requiresApproval?: boolean;
  };
  readonly handler: (
    input: InferToolInput<TInputSchema>,
    context: Record<string, never>,
  ) =>
    | Promise<TOutputSchema extends ToolSchema ? InferToolOutput<TOutputSchema> : unknown>
    | (TOutputSchema extends ToolSchema ? InferToolOutput<TOutputSchema> : unknown);
}

export interface DefinedTool<
  TInputSchema extends ToolSchema = ToolSchema,
  TOutputSchema extends ToolSchema | undefined = ToolSchema | undefined,
> extends DefineToolOptions<TInputSchema, TOutputSchema> {
  readonly "~executorAppTool": true;
}

export const integration = <Slug extends string>(slug: Slug): IntegrationSchema<Slug> => {
  const schema = z.custom<AppIntegrationClient>().meta({
    [EXECUTOR_INTEGRATION_META]: { kind: "integration", slug },
  }) as IntegrationSchema<Slug>;
  Object.defineProperty(schema, EXECUTOR_INTEGRATION_META, {
    value: { kind: "integration", slug },
    enumerable: false,
  });
  return schema;
};

export const defineTool = <
  TInputSchema extends ToolSchema,
  TOutputSchema extends ToolSchema | undefined = undefined,
>(
  definition: DefineToolOptions<TInputSchema, TOutputSchema>,
): DefinedTool<TInputSchema, TOutputSchema> => ({
  ...definition,
  "~executorAppTool": true,
});
