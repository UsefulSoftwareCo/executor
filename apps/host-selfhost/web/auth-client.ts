import { createAuthClient } from "better-auth/react";

// Better Auth browser client. Talks to the self-host server's /api/auth (same
// origin); the session cookie it sets is what the shared AuthProvider's
// /account/me query and all API calls authenticate with. Only the login form
// and sign-out use this — auth STATE comes from the shared AuthProvider.
export const authClient = createAuthClient({
  baseURL: `${window.location.origin}/api/auth`,
});
