import type { ScopeDbHandle } from "./seams/scope-db";
import type { StandardSchemaV1 } from "./standard-schema";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type ToolSchema<TOutput = unknown> = StandardSchemaV1<unknown, TOutput> | JsonObject;

export interface IntegrationDeclaration<Slug extends string = string> {
  readonly integration: Slug;
}

export type ToolHandlerContext<
  TIntegrations extends Readonly<Record<string, IntegrationDeclaration>> | undefined,
> = {
  readonly db: ScopeDbHandle;
} & {
  readonly [K in keyof NonNullable<TIntegrations>]: unknown;
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
  TIntegrations extends Readonly<Record<string, IntegrationDeclaration>> | undefined = undefined,
> {
  readonly description: string;
  readonly integrations?: TIntegrations;
  readonly input: TInputSchema;
  readonly output?: TOutputSchema;
  readonly annotations?: {
    readonly readOnly?: boolean;
    readonly destructive?: boolean;
    readonly requiresApproval?: boolean;
  };
  readonly handler: (
    input: InferToolInput<TInputSchema>,
    context: ToolHandlerContext<TIntegrations>,
  ) =>
    | Promise<TOutputSchema extends ToolSchema ? InferToolOutput<TOutputSchema> : unknown>
    | (TOutputSchema extends ToolSchema ? InferToolOutput<TOutputSchema> : unknown);
}

export const integration = <Slug extends string>(slug: Slug): IntegrationDeclaration<Slug> => ({
  integration: slug,
});

export const defineTool = <
  TInputSchema extends ToolSchema,
  TOutputSchema extends ToolSchema | undefined = undefined,
  TIntegrations extends Readonly<Record<string, IntegrationDeclaration>> | undefined = undefined,
>(
  definition: DefineToolOptions<TInputSchema, TOutputSchema, TIntegrations>,
): DefineToolOptions<TInputSchema, TOutputSchema, TIntegrations> => definition;
