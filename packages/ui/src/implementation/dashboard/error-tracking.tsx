import { createContext, useContext, type ReactNode } from "react";
import type { UserFacingError } from "@executor-js/utils/user-facing-error";

const ErrorTrackingContext = createContext(false);

/** Hosts that record product failures for the Executor team enable the tracked-failure note. */
export function ErrorTrackingProvider({ children }: { readonly children: ReactNode }) {
  return <ErrorTrackingContext.Provider value={true}>{children}</ErrorTrackingContext.Provider>;
}

/** Tell the user that a failure the Executor team must fix was recorded with its evidence. */
export function ErrorTrackedNote({ error }: { readonly error: UserFacingError }) {
  const tracked = useContext(ErrorTrackingContext);
  if (!tracked || error.report === undefined) return null;
  return (
    <p className="col-span-2 col-start-1 mt-2 text-[13px] text-foreground/85">
      We’ve tracked this automatically and will investigate.
    </p>
  );
}
