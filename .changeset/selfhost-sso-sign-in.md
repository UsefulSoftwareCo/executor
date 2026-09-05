---
"executor": patch
---

**Self-host: bring-your-own SSO (Google, Okta, any OIDC IdP) with a verified-domain allowlist**

Operators can enable a single OIDC sign-in provider on a self-hosted instance by setting `EXECUTOR_SSO_PROVIDER_ID`, `EXECUTOR_SSO_CLIENT_ID`, `EXECUTOR_SSO_CLIENT_SECRET`, and `EXECUTOR_SSO_ALLOWED_DOMAINS` (comma-separated email domains), plus `EXECUTOR_SSO_DISCOVERY_URL` for providers without a preset (`google` is preset; `EXECUTOR_SSO_PROVIDER_NAME` overrides the button label). The login page renders a "Continue with <provider>" button when configured (discovered through the new unauthenticated `GET /api/auth-config`, which returns provider id + display name only), and the MCP OAuth connect flow's login step gains the same option since it lands on the same page.

The domain allowlist replaces the invite code for SSO sign-ups: a sign-in whose IdP-verified email (`email_verified`) has an allowlisted domain auto-joins the instance organization as a member; unverified emails and any other domain are refused. Enabling the provider without an allowlist is refused at boot, as is a half-configured client id/secret pair, so SSO can never silently become open registration. Email/password sign-in and invite-based signup are unchanged. The end-to-end flow (discovery → redirect → consent → callback → membership) is exercised in tests against an emulated OIDC IdP from `@executor-js/emulate`.
