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
export { desktop } from "./implementation/desktop.ts";
export {
  DesktopUnavailable,
  DesktopPermissionDenied,
  ShortcutTaken,
  DesktopInvalidInput,
  SystemAudioBlocked,
  type DesktopError,
} from "./contracts/desktop-errors.ts";
export {
  desktopBadgeMaximum,
  desktopMaximumWindows,
  desktopMenuBarTitleMaxLength,
  desktopPermissions,
  desktopWindowSize,
  type DesktopPermission,
  type DesktopPermissionState,
  type DesktopWindowOptions,
} from "./contracts/desktop.ts";
