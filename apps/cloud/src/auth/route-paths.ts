// Route sets shared between the SSR auth gate (server) and the root
// AuthGate (client) — one source of truth so the two layers can't disagree
// about which pages a given auth state may see. Pure data, safe in both
// bundles.

/** Pages that render for SIGNED-OUT visitors (the gate lets them through). */
export const PUBLIC_PATHS = new Set(["/login"]);

/** Pages an authenticated-but-org-less user is FOR (everything else redirects to onboarding). */
export const ONBOARDING_PATHS = new Set(["/create-org", "/setup-mcp"]);
