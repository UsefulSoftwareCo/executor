// Route sets shared between the SSR auth gate (server) and the root
// AuthGate (client) — one source of truth so the two layers can't disagree
// about which pages a given auth state may see. Pure data, safe in both
// bundles.

/** Pages that render for SIGNED-OUT visitors (the gate lets them through). */
export const PUBLIC_PATHS = new Set(["/login"]);

/**
 * The page a signed-in session with no organization is FOR: accepting a
 * pending invitation into an existing organization. Every other page sends an
 * org-less session on — here when it holds a pending invitation, else to
 * Executor v2, where new organizations are created.
 */
export const JOIN_PATH = "/join";

/**
 * v1's create-an-organization address. v1 creates no organizations: the
 * document auth gate answers it with v2's sign-up page, for every signed-in
 * session, so links to it are plain document navigations, never router links.
 */
export const CREATE_ORG_PATH = "/create-org";
