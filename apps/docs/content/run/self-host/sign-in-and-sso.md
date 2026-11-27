---
title: Sign-in and OIDC SSO
description: "Complete self-host first-run administrator setup, invite members with passwords, and configure OpenID Connect SSO with allowed email domains for new SSO users."
---

Self-hosted Executor supports email-and-password accounts (by invitation after initial setup) and OpenID Connect (OIDC) single sign-on where new SSO users join by verified email domain without an invitation (**Self-host** only; **Local** uses a local API key and **Cloud** manages sign-in).

On first boot, keep access restricted to you and complete **Set up Executor** at the configured origin. To turn on SSO, set `SSO_DISCOVERY_URL`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, and `SSO_ALLOWED_DOMAINS`, and register `<BETTER_AUTH_URL>/api/auth/callback/sso` in your identity provider.

**Prerequisites:** A running self-host container ([Self-host with Docker](/docs/run/self-host)) with `BETTER_AUTH_URL` matching the exact origin users open. For OIDC SSO, you need an OIDC identity provider with a final HTTPS discovery document URL and administrator access to register a redirect URI.

**You'll know it worked when** you can sign in to the dashboard as the organization owner, and (when SSO is configured) clicking **Continue with SSO** on `/login` completes sign-in with a test account at an allowed domain.

## First-run setup

The first successful setup creates the organization and its owner without a pre-existing setup secret. Keep access restricted to you until setup finishes. See [Deploy, proxy, and tune self-host](/docs/run/self-host/deploy) for deployment steps.

1. Open `<BETTER_AUTH_URL>` in your browser. Until setup completes, Executor shows **Set up Executor** ("Create your administrator account and organization").
2. Enter:
   - **Organization name**
   - **Your name**
   - **Email**
   - **Password**
3. Click **Create administrator account**.

The browser opens **Connect your assistant**. Complete onboarding to open the dashboard. After setup, `GET /api/auth/self-host/config` reports `setup: false`.

You'll know it worked when onboarding finishes in the dashboard and `curl -sf http://127.0.0.1:4400/api/auth/self-host/config` returns `{"setup":false,...}`.

## Passwords and invitations

After first-run setup, new password users need an invitation.

To add teammates with password accounts:

1. As an organization `owner` or `admin`, open **Members → Add member**, enter the recipient's email, choose a role (**Member** or **Admin**), and click **Create invite link**, then **Copy link**.
2. The recipient opens the link:
   - If already signed in, they click **Accept invitation** on **Join an organization**.
   - If not signed in, they click **Join with this invitation** on the sign-in page, fill **Your name**, **Email**, and **Password** on **Join Executor**, and click **Accept invitation**.

## OIDC SSO and allowed domains

Configure OIDC SSO with four environment variables on the self-host container:

| Variable | Required when SSO is on | Purpose |
| --- | --- | --- |
| `SSO_DISCOVERY_URL` | Yes (triggers SSO when non-empty) | Final absolute `https://` URL of your IdP's `.well-known/openid-configuration` document (must not rely on HTTP redirects). Leave unset or empty to keep SSO off. |
| `SSO_CLIENT_ID` | Yes | OIDC client ID from your identity provider. |
| `SSO_CLIENT_SECRET` | Yes | OIDC client secret from your identity provider. |
| `SSO_ALLOWED_DOMAINS` | Yes | Comma-separated list of exact email domains for verified addresses of new SSO users. |

Register this exact callback URL in your identity provider:

```text
<BETTER_AUTH_URL>/api/auth/callback/sso
```

When you restart the container with all four variables set:

1. Executor fetches discovery with a 10-second timeout and follows no redirects. Discovery must advertise HTTPS endpoints and ID-token signing algorithms.
2. Executor requests scopes `openid`, `email`, and `profile` and verifies the ID token.
3. After setup, `/login` shows **Continue with SSO** when SSO is configured. Complete a sign-in with an allowed-domain test account to verify discovery and the callback.
4. New SSO users must have a **verified email** at an exact domain in `SSO_ALLOWED_DOMAINS` and can join without an invitation. The allowlist applies to new SSO users. Manage existing memberships in **Members**.
5. To link SSO to an existing password account, sign in with your password and use **Account → Security → Connect SSO**.

You'll know it worked when container logs show no `SSO is unavailable:` discovery errors, `/login` displays **Continue with SSO** after setup, and clicking **Continue with SSO** completes sign-in with an allowed-domain test account. (`GET /api/auth/self-host/config` can return `"sso":true` even if discovery failed.)

## Session secret and origin

- `BETTER_AUTH_URL` must match the exact scheme, host, and port users open; a mismatch can break browser sign-in or redirect to the wrong origin.
- `BETTER_AUTH_SECRET` overrides the auto-generated `/app/data/auth-secret.key` session secret (must be at least 32 characters). Rotating `BETTER_AUTH_SECRET` invalidates current session cookies.

## Dashboard cookie migration

Every HTTPS hosted deployment now uses `__Host-executor-hosted.<cookie>` for Better Auth cookies, including session and plugin cookies. The browser requires `Secure`, `Path=/` and no Domain attribute for these names. An app on a sibling origin cannot inject a parent-domain cookie under the dashboard's new name.

This applies even when embedding is off. Existing HTTPS browser sessions require one sign-in after upgrading because Executor no longer reads the old `__Secure-executor-hosted.<cookie>` names. Database sessions and bearer credentials are unchanged. Self-host deployments served over HTTP retain their existing unprefixed cookie names and do not require re-sign-in for this migration.

Last-organization memory, time-zone preferences, passkey enrollment and anonymous visitor cookies also become host-only on HTTPS. Anonymous signup attribution no longer crosses subdomains; same-origin attribution remains available.

## Example

Replace `https://executor.example.com` with your browser-facing HTTPS origin. Route it to the loopback container through a TLS reverse proxy, and restrict access to yourself until setup finishes. Register that origin's `/api/auth/callback/sso` URL with your IdP. Replace the discovery URL, client ID, client secret, and allowed domains before starting the container:

```bash
docker run -d --name executor-v2 --init --restart unless-stopped \
  -p 127.0.0.1:4400:4400 -v executor-v2-data:/app/data \
  -e BETTER_AUTH_URL=https://executor.example.com \
  -e SSO_DISCOVERY_URL=https://idp.example.com/.well-known/openid-configuration \
  -e SSO_CLIENT_ID=your-oidc-client-id \
  -e SSO_CLIENT_SECRET=your-oidc-client-secret \
  -e SSO_ALLOWED_DOMAINS=example.com,subsidiary.example.com \
  ghcr.io/usefulsoftwareco/executor-selfhost:2.0.0-beta.79
```

Check startup health, inspect container logs for any discovery errors, and confirm the SSO variables are loaded:

```bash
curl -sf http://127.0.0.1:4400/health
docker logs executor-v2 2>&1 | grep -i sso || true
curl -sf http://127.0.0.1:4400/api/auth/self-host/config
# {"setup":true,"sso":true} (reports that SSO variables are set)
```

After completing first-run setup, open `/login`, click **Continue with SSO**, and complete a sign-in with a test account to verify discovery and the IdP callback end to end.

## Limits

- Password sign-in remains available if discovery fails.
- Set all four SSO variables when enabling OIDC.

## Related

- [Self-host with Docker](/docs/run/self-host)
- [Deploy, proxy, and tune self-host](/docs/run/self-host/deploy)
- [Operator OAuth clients](/docs/run/self-host/oauth-clients)
- [Storage, backups, and updates](/docs/run/self-host/storage-and-updates)
- [Organizations and access](/docs/concepts/organizations-and-access)
