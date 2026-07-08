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

export type IntegrationMode = "one" | "many";

export interface IntegrationDeclaration<
  Slug extends string = string,
  Mode extends IntegrationMode = IntegrationMode,
> {
  readonly kind: "integration";
  readonly slug: Slug;
  readonly mode: Mode;
  readonly description?: string;
  /**
   * Ask the caller to choose a set of connections. Future author-chosen binding modes should not
   * project optional caller fields: optional fields are suggestions, and model callers under-fill
   * them.
   */
  readonly array: () => IntegrationDeclaration<Slug, "many">;
  readonly describe: (text: string) => IntegrationDeclaration<Slug, Mode>;
}

export type IntegrationClients<TIntegrations> =
  TIntegrations extends Readonly<Record<string, IntegrationDeclaration>>
    ? {
        readonly [K in keyof TIntegrations]: TIntegrations[K] extends {
          readonly mode: "many";
        }
          ? readonly AppIntegrationClient[]
          : AppIntegrationClient;
      }
    : Record<string, never>;

export type IntegrationDeclarations = Readonly<Record<string, IntegrationDeclaration>>;

interface IntegrationDeclarationState<
  Slug extends string = string,
  Mode extends IntegrationMode = IntegrationMode,
> {
  readonly slug: Slug;
  readonly mode: Mode;
  readonly description?: string;
}

export interface SerializedIntegrationDeclaration {
  readonly slug: string;
  readonly mode: IntegrationMode;
  readonly description?: string;
}

const makeIntegrationDeclaration = <Slug extends string, Mode extends IntegrationMode>(
  state: IntegrationDeclarationState<Slug, Mode>,
): IntegrationDeclaration<Slug, Mode> => {
  const declaration = {
    kind: "integration" as const,
    slug: state.slug,
    mode: state.mode,
    ...(state.description !== undefined ? { description: state.description } : {}),
    array: () => makeIntegrationDeclaration({ ...state, mode: "many" as const }),
    describe: (text: string) => makeIntegrationDeclaration({ ...state, description: text }),
  };
  return Object.freeze(declaration);
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
  TIntegrations extends IntegrationDeclarations | undefined = undefined,
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
    context: IntegrationClients<TIntegrations>,
  ) =>
    | Promise<TOutputSchema extends ToolSchema ? InferToolOutput<TOutputSchema> : unknown>
    | (TOutputSchema extends ToolSchema ? InferToolOutput<TOutputSchema> : unknown);
}

export interface DefinedTool<
  TInputSchema extends ToolSchema = ToolSchema,
  TOutputSchema extends ToolSchema | undefined = ToolSchema | undefined,
  TIntegrations extends IntegrationDeclarations | undefined = IntegrationDeclarations | undefined,
> extends DefineToolOptions<TInputSchema, TOutputSchema, TIntegrations> {
  readonly "~executorAppTool": true;
}

export const integration = <Slug extends string>(slug: Slug): IntegrationDeclaration<Slug, "one"> =>
  makeIntegrationDeclaration({ slug, mode: "one" as const });

export const defineTool = <
  TInputSchema extends ToolSchema,
  TOutputSchema extends ToolSchema | undefined = undefined,
  TIntegrations extends IntegrationDeclarations | undefined = undefined,
>(
  definition: DefineToolOptions<TInputSchema, TOutputSchema, TIntegrations>,
): DefinedTool<TInputSchema, TOutputSchema, TIntegrations> => ({
  ...definition,
  "~executorAppTool": true,
});
