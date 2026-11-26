import { useSyncExternalStore } from "react";

const unchanging = () => () => {};

export const useHydrated = () =>
  useSyncExternalStore(
    unchanging,
    () => true,
    () => false,
  );
