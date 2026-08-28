---
"executor": patch
---

**Self-host: bring-your-own Google sign-in with a domain allowlist**

Operators can enable Google as a login provider on a self-hosted instance by setting `EXECUTOR_GOOGLE_CLIENT_ID`, `EXECUTOR_GOOGLE_CLIENT_SECRET`, and `EXECUTOR_GOOGLE_ALLOWED_DOMAINS` (comma-separated email domains). The login page renders a "Continue with Google" button when the provider is configured (discovered through the new unauthenticated `GET /api/auth-config`, which returns provider ids only), and the MCP OAuth connect flow's login step gains the same option since it lands on the same page.

The domain allowlist replaces the invite code for social sign-ups: a Google sign-in whose email domain is on the list auto-joins the instance organization as a member, and any other domain is refused. Enabling the provider without an allowlist is refused at boot, as is a half-configured client id/secret pair, so Google sign-in can never silently become open registration. Email/password sign-in and invite-based signup are unchanged.
