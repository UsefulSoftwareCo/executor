---
title: Single sign-on (SSO) on Executor Cloud
description: "Configure OpenID Connect or SAML 2.0 single sign-on with DNS domain verification on Executor Cloud Enterprise organizations."
---

Executor Cloud Enterprise supports organization single sign-on (SSO) with **OpenID Connect** or **SAML** 2.0. Verify the email domain in DNS before members use the connection. Organization owners and admins manage it from the **Single sign-on** card in **Settings** (`/org/<slug>/organization`, using **Add SSO connection**, **Show DNS record**, **Verify domain**, and **Test sign-in**); members sign in at `/login` or `/login/sso` (**Continue with SSO**). Organization-managed SSO is **Cloud** only (**Self-host** uses operator-configured OIDC environment variables—`SSO_DISCOVERY_URL`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, and `SSO_ALLOWED_DOMAINS`—and **Local** has no SSO).

**Key step:** save your connection, publish the TXT record from **Show DNS record**, and click **Verify domain**—members cannot sign in through the connection until the domain is verified.

**Prerequisites:** SSO is included in Executor Cloud **Enterprise** (select **Contact us** on the [pricing page](https://executor.sh/pricing) or **Contact sales** in dashboard billing to ask about Enterprise; the Cloud dashboard shows **Single sign-on** to **owners** and **admins** when their organization has Enterprise). You also need permission to configure an application in your identity provider and publish DNS TXT records for your email domain.

**You'll know it worked when…** the status badge reads `Domain verified` and **Test sign-in** completes through your identity provider using an account on the verified domain, returning you to organization settings.

## How to use it

### 1. Register an OpenID Connect or SAML connection

1. In the Cloud dashboard, open **Settings** (`/org/<slug>/organization`) as an owner or admin and click **Add SSO connection** in the **Single sign-on** card.
2. Choose **OpenID Connect** or **SAML**. Each setup form generates a unique provider ID and displays the callback values to register in your identity provider:
   - **OpenID Connect:** register the displayed **Sign-in redirect URI** (`https://app.executor.sh/api/auth/sso/callback/<providerId>`) in your identity provider. Fill in **Email domain**, **Issuer URL**, **Client ID**, and **Client secret**. The connection uses PKCE and requests the `openid`, `email`, and `profile` scopes.
   - **SAML:** register the displayed **Identifier (Entity ID)** (`https://app.executor.sh/api/auth/sso/saml2/sp/metadata?providerId=<providerId>`) and **Reply URL (ACS)** (`https://app.executor.sh/api/auth/sso/saml2/sp/acs/<providerId>`). Fill in **Email domain** and paste your identity provider's **Federation metadata XML** (it must include an HTTP-Redirect `SingleSignOnService` endpoint). Configure your identity provider to send signed assertions (with SHA-256 or stronger) containing a `NameID` for the user. Send an email address on the verified domain in `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`. If you omit that claim, use the verified-domain email as the `NameID`.
3. Click **Save connection**.

### 2. Verify domain ownership via DNS

1. On the saved connection card, click **Show DNS record**.
2. Add a DNS TXT record with the displayed **DNS record name (TXT)** (`_better-auth-token-<providerId>.<domain>`) and **DNS record value** (if your DNS provider automatically appends the zone name, enter only the relative record name).
3. Wait for DNS propagation and click **Verify domain**. Once verified, the status shows `Domain verified` and **Test sign-in** becomes available.
4. Click **Test sign-in** and complete sign-in with an identity provider user whose email is in the exact verified domain. A successful test returns you to organization settings.

### 3. Member sign-in, membership, and credential rotation

- **How members sign in:** enter your work email under **Email** on `/login` and select **Continue**, or open `/login/sso`, enter **Work email**, and select **Continue with SSO**. The main email form redirects you to your identity provider if exactly one verified SSO connection matches your email domain. If there is no verified match, it sends an email sign-in code. If multiple verified connections match, contact your organization administrator. Google, GitHub, and passkey sign-in options remain on the main sign-in page.
- **Automatic organization membership:** a successful SSO sign-in adds a new user to the organization as a member if a seat is available. Existing members keep their roles. If the user has a valid pending invitation (unexpired and from an inviter who can still invite), SSO leaves it pending. They join the organization when they accept it.
- **Rotate secrets or certificates:** organization owners and admins can click **Rotate client secret** (OIDC, **New client secret**) or **Update signing certificate** (SAML, **Updated federation metadata XML**), then click **Save credential**.
- **Remove a connection:** click **Remove SSO connection** and confirm with **Remove connection**.

## Example

Example values from the SAML setup form and **Show DNS record** for a connection with provider ID `sso-0123456789abcdef01234567` on `example.com`. Copy the values displayed in your own connection—each setup form generates a unique provider ID, and substituting this example ID into a real identity provider will fail:

```text
Identifier (Entity ID): https://app.executor.sh/api/auth/sso/saml2/sp/metadata?providerId=sso-0123456789abcdef01234567
Reply URL (ACS):        https://app.executor.sh/api/auth/sso/saml2/sp/acs/sso-0123456789abcdef01234567
DNS record name (TXT):  _better-auth-token-sso-0123456789abcdef01234567.example.com
```

Example values for an OpenID Connect connection with the same provider ID:

```text
Sign-in redirect URI:   https://app.executor.sh/api/auth/sso/callback/sso-0123456789abcdef01234567
```

## Limits

- **One connection per organization:** each Cloud organization can configure one SSO connection at a time.
- **Exact verified domain:** the email returned by your identity provider (and the email of an already-linked account) must match the exact verified domain—an address on a subdomain needs a matching verified connection (API callback code `SSO_EMAIL_DOMAIN_MISMATCH`). If two organizations verify the same domain, signing in by email cannot choose between them (discovery API code `SSO_DOMAIN_AMBIGUOUS`); ask an organization administrator for help.
- **SAML sign-in flow checks:** start SAML sign-in from Executor in the browser you will use to finish it (IdP-initiated login is disabled, and the flow verifies a signed `relay_state` browser cookie). Executor checks that the response matches the request (`InResponseTo`) and that the assertion has a valid time condition. Configure your identity provider to sign assertions with SHA-256 or stronger.
- **Encrypted configuration storage:** Executor Cloud encrypts OIDC and SAML provider configuration before storing it, including the OIDC client secret.
- **SSO-managed email addresses:** if your account is linked to an SSO connection, ask an organization administrator about changing your email address—account settings blocks self-service email changes (`SSO_MANAGED_EMAIL`).
- **Metadata size limit:** **Federation metadata XML** can be up to 102,400 bytes in UTF-8. The same limit applies when you update the signing certificate.

## Related

- [Organizations and access](/docs/concepts/organizations-and-access)
- [Quickstart](/docs/quickstart)
- [Self-host Executor](/docs/run/self-host)

Using Executor CLI 2.0.0-beta.79? For app management and Git, run `executor apps login --host <your origin>`. For tool commands and MCP, run `executor login --host <your origin>`.
