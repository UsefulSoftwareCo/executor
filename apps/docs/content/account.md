---
title: Account settings
description: "Update your Executor profile, change your Cloud email, add passkeys or change your Self-host password, manage active sessions, delete your Cloud account, or unsubscribe from optional emails."
---

On **Cloud** or **Self-host**, open your account menu in the sidebar footer and select **Account settings → Profile** (`/account/profile`). Edit **Name** and select **Save** — the updated name appears in the sidebar and **Saved** appears next to the button. Use **Security** for sign-in methods and active sessions, and **Tokens** for personal access tokens. Local Executor has no hosted user accounts.

Changing your email, managing passkeys, deleting your account, and unsubscribing from optional emails are **Cloud** only. Changing a password and linking an OIDC identity provider from Security are **Self-host** only.

## Profile

Sign in to Executor in a browser and open **Account settings → Profile** (`/account/profile`).

### Display name and organizations (Cloud and Self-host)

1. Edit **Name** (up to 120 characters, non-blank). This name is shown to members of your organizations.
2. Select **Save**. **Saved** appears next to the button and your name updates in the sidebar.

Below your profile fields, the **Organizations** card lists every organization you belong to with an **Open** button linking to `/org/<slug>/apps`.

### Change email (Cloud only)

**Prerequisites:** You must have access to both your current and new email inboxes. Accounts linked to an organization SSO connection cannot change their email here (`SSO_MANAGED_EMAIL`) and must ask their organization. Both 6-digit codes expire after 5 minutes (up to 3 attempts).

On **Self-host**, the **Email** field is read-only. On **Cloud**:

1. In the **Email** card, select **Change email**.
2. Enter your **New email** and select **Continue**. Executor sends a 6-digit code to your current email.
3. Enter the 6-digit **Approval code** (select **Resend code** if needed) and select **Continue**. Executor sends a second 6-digit code to your new email.
4. Enter the 6-digit **Confirmation code** and select **Change email**.

If the confirmation code does not arrive, another Executor account may already use that email address.

## Security

Sign in to Executor in a browser and open **Account settings → Security** (`/account/security`).

### Cloud: Passkeys and active sessions

- **Passkeys:** On a supported browser, device, or password manager, select **Add passkey** and follow its prompt. Registered passkeys show whether they are **Synced** or **Device-bound** and the date added; select **Remove** to delete one. To use a passkey on a compatible device, choose **Sign in with a passkey** on the sign-in screen. Registering a passkey does not disable email-code sign-in.
- **Active sessions:** Lists your current Executor browser sign-ins, showing client information, IP address (when recorded), **Last active**, and **Signed in**. Your current browser is labeled **This browser**. Select **Sign out** on any other session, or **Sign out other sessions** to revoke all other sessions at once.

### Self-host: Password, SSO, and active sessions

- **Password:** Requires an existing credential password (an SSO-only user may have joined without setting one). Enter **Current password** and a **New password** (8–128 characters), then select **Change password**.
- **Single sign-on:** Appears when your Self-host administrator configures OIDC. If you haven't linked your identity, select **Connect SSO** and use a verified email at an allowed domain. After linking, the card shows **Connected.** and you can sign in with SSO or your password.
- **Active sessions:** Lists your current Executor browser sign-ins and lets you revoke individual sessions or select **Sign out other sessions**.

Manage MCP OAuth grants under **Connections → Connected agents** and personal access tokens under **Account settings → Tokens** (`/account/tokens`). Signing out a browser session leaves personal access tokens active.

## Delete your account (Cloud only)

Deleting your account is permanent and available from **Account settings → Profile** (`/account/profile`) on **Cloud** only.

Before you confirm, the **Delete account** card previews what happens to each organization you belong to:

| Your membership in the organization | Outcome |
| --- | --- |
| You are the only member | **Deleted, with everything in it** — the organization and all its apps, accounts, and credentials are deleted. |
| Other members exist, and another owner exists (or you are a member/admin) | **You leave; your personal accounts there are deleted** — the organization stays, your membership ends, and your personal accounts in it are deleted. |
| Other members exist, and you are the only owner | **You are its only owner. Delete it first** — account deletion is blocked until you delete that organization from its **Settings** page. |

**Prerequisites:** Resolve any organization listed as blocked. If Executor reports a queued or running workflow or a webhook subscription still using something deletion would remove, wait for the work to finish or stop the subscription and retry.

1. Scroll to **Delete account** on `/account/profile` and select **Delete account**.
2. In **Delete your account?**, type your exact email address into **Confirm your email**.
3. Select **Delete account**.

Account deletion removes your sign-in methods, sessions, passkeys, API keys, MCP connections, and personal accounts and their saved credentials. Executor signs you out, redirects to `/`, and starts background deletion of organizations where you were the only member.

## Unsubscribe from optional emails (Cloud only)

Optional Cloud emails support one-click unsubscribe in email clients. You can also follow these steps while signed out.

1. Open the unsubscribe link from your latest optional Executor email.
2. On **Unsubscribe from optional emails?**, select **Unsubscribe**.
3. Executor confirms **You’re unsubscribed**.

Unsubscribing stops optional emails only. You can still request sign-in codes and receive essential account emails.

## Example

When a Cloud user belongs to two organizations — a personal workspace where they are the sole member (`members === 1`) and a team workspace where they are a regular member — opening `/account/profile` previews both outcomes before deletion:

```text
Personal workspace  -> Deleted, with everything in it
Team workspace      -> You leave; your personal accounts there are deleted
```

If that user is instead the only owner of a team workspace with two members, the **Delete account** button stays disabled with a **Settings** link to `/org/<slug>/organization`, and direct removal requests fail with `UserRemovalBlocked`.

## Limits

- **Display name:** Non-blank, maximum 120 characters.
- **Email change (Cloud):** Requires 6-digit codes from both the current and new email addresses (each expires in 5 minutes, up to 3 attempts). Not available on Self-host, and blocked for accounts linked to an organization SSO connection (`SSO_MANAGED_EMAIL`).
- **Self-host password:** 8–128 characters; requires an existing password.
- **Sessions vs. tokens:** Selecting **Sign out** or **Sign out other sessions** does not revoke personal access tokens.
- **Account deletion (Cloud only):** A sole owner of an organization with other members gets `UserRemovalBlocked`. Queued or running workflows and active webhook subscriptions can also block deletion while they use resources that would be removed.

## Related

- [API keys](/docs/api-keys)
- [Organizations and access](/docs/concepts/organizations-and-access)
- [Organization settings](/docs/organizations/settings)
- [Members and roles](/docs/organizations/members)
- [Plans and billing](/docs/cloud/billing)
