/** Browser-safe live query API. Server operations are referenced using type-only imports. */
export { queryReference, mutationReference, liveQueryAtom } from "./implementation/live.ts";
export {
  AppQueryFailed,
  type OperationReference,
  type QueryDescriptor,
  type QueryTransport,
} from "./contracts/live.ts";
export { createAppClient } from "./implementation/ui-client.ts";

export type {
  AppMutation,
  OptimisticLocalStore,
  OptimisticUpdate,
} from "./contracts/optimistic.ts";
