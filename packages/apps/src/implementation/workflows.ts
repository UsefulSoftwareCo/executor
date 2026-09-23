/** Ordinary async workflow declarations, adapted once into native Effect handlers. */
import { Effect, type Schema as EffectSchema } from "effect";
import type { AppWorkflow, WorkflowContext } from "../contracts/workflows.ts";
import { decoderOf, type Schema } from "./schema.ts";

const NativeWorkflow = Symbol("apps.Workflow");
declare const HandlerContext: unique symbol;
/** A workflow declaration retains input/output inference and required context compatibility. */
export interface Workflow<Input, Output, Context extends WorkflowContext = WorkflowContext> {
  readonly [HandlerContext]?: (context: Context) => void;
  readonly [NativeWorkflow]: AppWorkflow<Input, Output>;
}
/** Composition view erases input only after retaining its runtime decoder. */
export interface WorkflowDeclaration<Context extends WorkflowContext> {
  readonly [HandlerContext]?: (context: Context) => void;
  readonly [NativeWorkflow]: Omit<AppWorkflow<never>, "input"> & {
    readonly input: EffectSchema.Decoder<unknown>;
  };
}
/** Declare durable orchestration without starting a run or performing I/O. */
export const workflow = <Input, Output, Context extends WorkflowContext = WorkflowContext>(
  options: {
    readonly input: Schema<Input, boolean>;
    readonly output?: Schema<Output, boolean>;
    readonly description?: string;
  },
  run: (context: Context, input: Input) => Promise<Output>,
): Workflow<Input, Output, Context> => ({
  [NativeWorkflow]: {
    input: decoderOf(options.input),
    ...(options.output === undefined ? {} : { output: decoderOf(options.output) }),
    ...(options.description === undefined ? {} : { description: options.description }),
    run: (context, input) =>
      Effect.tryPromise({
        // SAFETY: defineApp checks required context; the host supplies the pinned run's capabilities.
        try: () => run(context as Context, input),
        catch: (error) => error,
      }),
  },
});
/** Only this module creates the private declaration symbol; input is decoded before invocation. */
export const nativeWorkflow = (value: unknown): AppWorkflow | undefined => {
  if (typeof value !== "object" || value === null || !(NativeWorkflow in value)) return undefined;
  // SAFETY: declaration constructors preserve the callback/decoder pairing behind this symbol.
  return value[NativeWorkflow] as AppWorkflow;
};
