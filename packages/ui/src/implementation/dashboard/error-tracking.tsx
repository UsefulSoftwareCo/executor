import { createContext, useContext, type ReactNode } from "react";
import type { UserFacingError } from "@executor-js/utils/user-facing-error";

const ErrorTrackingContext = createContext(false);

export function ErrorTrackingProvider({ children }: { readonly children: ReactNode }) {
  return <ErrorTrackingContext.Provider value={true}>{children}</ErrorTrackingContext.Provider>;
}

export function ErrorTrackedNote({
  error,
  className = "col-span-2 col-start-1 mt-2 text-[13px] text-foreground/85",
}: {
  readonly error: UserFacingError;
  readonly className?: string;
}) {
  const tracked = useContext(ErrorTrackingContext);
  if (!tracked || error.report === undefined) return null;
  return <p className={className}>We’ve tracked this automatically and will investigate.</p>;
}
