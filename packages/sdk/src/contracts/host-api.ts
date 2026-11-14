/** How an invocation of an app that reads this host's API is bound to one revision of it. */
import type { HostApiCheck } from "@executor-js/app-data/host-api";

/** See `HostApi`: the data supervisor binds a facet's network with the same check. */
export { HostApiCheck } from "@executor-js/app-data/host-api";

/**
 * Where an invocation's app cache lives: its build, or its build and the host API revision its
 * code reads. Kept tool listings are keyed by the same value.
 */
export const appCacheNamespace = (build: string, hostApi: HostApiCheck | undefined) =>
  hostApi === undefined ? build : `${build}:${hostApi.revision}`;

/**
 * The `code` of the rejection an app's `fetch` gets when Executor's network refuses it the host
 * API's document of another revision, as it does while a deploy changes the API. The rejection
 * crosses back from the app's isolate as the app's own failure, so its presentation says that the
 * app reported it.
 */
export const hostApiChangingCode = "EXECUTOR_API_CHANGING";
