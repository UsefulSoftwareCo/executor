/** Native operation declarations. SQL access is an optional invocation capability. */
import type { Effect, Schema } from "effect";
import type { Approval } from "./approval.ts";
import type { BoundContext, AccountSlots } from "./app.ts";
import type { Sql, SqlReader } from "./sql.ts";
import type { ToolAnnotations } from "./tools.ts";
import type { JsonObject } from "./schema.ts";

/** Host-bound operation capabilities; the author declaration refines accounts and storage. */
export type OperationContext = BoundContext<AccountSlots> & {
  readonly sql?: SqlReader | Sql;
};
/** The host validates input, checks approval, then owns the transaction and output validation. */
export interface AppOperation<Input = unknown, Output = unknown> {
  readonly kind: "query" | "mutation";
  readonly description?: string;
  readonly title?: string;
  readonly annotations?: ToolAnnotations;
  readonly _meta?: JsonObject;
  readonly input: Schema.Decoder<Input>;
  /** Checks every value `run` returns and is the output schema the operation is described with. */
  readonly output?: Schema.Decoder<Output>;
  /**
   * An upstream protocol's description of the value `run` returns, used only when `output` is
   * absent. The host does not check it, so declare `output` when the result can be checked.
   */
  readonly outputSchema?: JsonObject;
  readonly approval?: Approval<Input>;
  readonly run: (context: OperationContext, input: Input) => Effect.Effect<Output, unknown>;
}
