import * as React from "react";

// The active WorkOS organization for org-scoped hosts (the cloud app). Local and
// desktop aren't org-scoped, so they leave it unset and consumers fall back to
// unscoped behaviour. This is purely a UI hint (e.g. which org to pin in an MCP
// install URL); access is always enforced server-side.
const OrganizationContext = React.createContext<string | null>(null);

export function OrganizationProvider(
  props: React.PropsWithChildren<{ readonly organizationId: string | null }>,
) {
  return (
    <OrganizationContext.Provider value={props.organizationId}>
      {props.children}
    </OrganizationContext.Provider>
  );
}

/** Returns the active organization id, or `null` when the host isn't org-scoped. */
export function useOrganizationId(): string | null {
  return React.useContext(OrganizationContext);
}
