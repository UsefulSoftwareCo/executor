/** Native operation declarations. Database access is an optional invocation capability. */
import type { Effect, Schema } from "effect";
import type { Approval } from "./approval.ts";
import type { BoundContext, AccountSlots } from "./app.ts";
import type { Database, DatabaseReader, Tables } from "./storage.ts";
import type { ToolAnnotations } from "./tools.ts";
import type { JsonObject } from "./schema.ts";

/** Host-bound operation capabilities; the author declaration refines accounts and storage. */
export type OperationContext = BoundContext<AccountSlots> & {
  readonly db?: DatabaseReader<Tables> | Database<Tables>;
};
/** The host validates input, checks approval, then owns the transaction and output validation. */
export interface AppOperation<Input = unknown, Output = unknown> {
  readonly kind: "query" | "mutation";
  readonly description?: string;
  readonly title?: string;
  readonly annotations?: ToolAnnotations;
  readonly _meta?: JsonObject;
  readonly input: Schema.Decoder<Input>;
  readonly output?: Schema.Decoder<Output>;
  /** Upstream protocol result metadata; the protocol adapter validates its own result envelope. */
  readonly outputSchema?: JsonObject;
  readonly approval?: Approval<Input>;
  readonly run: (context: OperationContext, input: Input) => Effect.Effect<Output, unknown>;
}

/** Agent tool names carry the operation kind; catalogs may reuse the same local name. */
export const OperationToolPrefixes = { query: "queries.", mutate: "mutations." } as const;
