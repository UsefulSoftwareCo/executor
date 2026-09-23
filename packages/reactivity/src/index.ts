/** Reactive database queries shared by the SDK, dashboard, and authored apps. */
export { QueryId, SubscriptionDescriptor } from "./contracts/store.ts";
export type {
  QuerySnapshot,
  TrackedQuerySnapshot,
  ReactiveStore,
  StoreChange,
} from "./contracts/store.ts";
export { makeReactiveStore } from "./implementation/store.ts";
