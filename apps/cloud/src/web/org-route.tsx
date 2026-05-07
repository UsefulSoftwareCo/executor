import React, { createContext, useContext } from "react";

// ---------------------------------------------------------------------------
// OrgRouteContext — provided by the `/$org` layout, consumed by descendants
// that need to know the URL-active organization. The handle drives all link
// generation; the id flows to API calls when one slips outside the URL prefix.
// ---------------------------------------------------------------------------

export type OrgRouteValue = {
  readonly orgId: string;
  readonly orgName: string;
  readonly orgHandle: string;
};

export const OrgRouteContext = createContext<OrgRouteValue | null>(null);

export const OrgRouteProvider = (props: { value: OrgRouteValue; children: React.ReactNode }) => (
  <OrgRouteContext.Provider value={props.value}>{props.children}</OrgRouteContext.Provider>
);

export const useOrgRoute = (): OrgRouteValue => {
  const value = useContext(OrgRouteContext);
  if (!value) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: React hook invariant
    throw new Error("useOrgRoute must be used within an OrgRouteProvider");
  }
  return value;
};

/** Optional variant for code rendered both inside and outside the org layout. */
export const useOrgRouteOptional = (): OrgRouteValue | null => useContext(OrgRouteContext);
