/** Convex-style temporary query projections; server operations remain authoritative. */
import type { OperationReference } from "./live.ts";

/** Read or replace mounted queries during a synchronous optimistic update. Never mutate returned values. */
export interface OptimisticLocalStore {
  /** Read the projected result, or undefined if this query is not loaded in this client. */
  getQuery<Input, Output>(
    reference: OperationReference<Input, Output, "query">,
    input: NoInfer<Input>,
  ): Output | undefined;
  /** Read all mounted argument variants of an operation, including loading queries. */
  getAllQueries<Input, Output>(
    reference: OperationReference<Input, Output, "query">,
  ): readonly { readonly input: Input; readonly value: Output | undefined }[];
  /** Replace a mounted query's projected result. The query's output schema validates the new value. */
  setQuery<Input, Output>(
    reference: OperationReference<Input, Output, "query">,
    input: NoInfer<Input>,
    value: NoInfer<Output>,
  ): void;
}

/** Pure synchronous projection. Replayed over current data; create temporary IDs before invoking the mutation. */
export type OptimisticUpdate<Input> = (store: OptimisticLocalStore, input: Input) => undefined;

/** A callable mutation. Success means the write was acknowledged; its overlay stays until fresh reads finish. */
export interface AppMutation<Input, Output> {
  (input: Input): Promise<Output>;
  /** Return a new mutation handle with this projection. Failures remove only this invocation's changes. */
  withOptimisticUpdate(update: OptimisticUpdate<Input>): AppMutation<Input, Output>;
}
