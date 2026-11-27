---
title: Organizations and access
description: "Hosted and self-host group people into organizations. An organization owns its accounts, apps and versions, and each member holds one role."
---

An **organization** is the boundary that owns accounts, apps, and versions on **Cloud** and **Self-host**. Everything you connect or deploy belongs to one. **Local** Executor has no organizations; it is one person on one machine. Open **Apps** (`/org/<slug>/apps`) to review an app's audience and sharing settings.

## Members and roles

Every person in an organization is a member with one role:

| Role | Can do |
| --- | --- |
| `member` | Create apps, connect accounts, use their own apps and what is shared with them, and manage what they created. |
| `admin` | A member's rights, plus invite and remove people, manage groups and OAuth clients, view organization-wide activity, manage Cloud billing, publish apps on Cloud (when the app has editable source), and manage app access and editable apps. |
| `owner` | An admin's rights, plus delete the organization on Cloud. |

Roles decide who manages things, not who uses them. Using an app, including calling its tools through MCP, follows the app's audience (configured in the app's **Settings** tab from **Apps**):

- **Only me** when you created the app, or **Only the creator** when you manage someone else's app. Only the creator can use it.
- **Everyone in the organization** for all current members.
- **Selected groups** for members of the chosen groups. A member can share only with groups they belong to; admins and owners can pick any group.

Personal account management checks who connected the account, including for admins. To give everyone access to one credential through an app's tools, link it as an app account as described below.

Admins and owners can manage private apps and read their source and Git history. Editing or deploying requires an editable app and edit authority. Tool use follows the app's audience. User tool calls resolve the caller's own linked accounts, and a [scoped connection](/docs/mcp-clients#scoped-connections) can narrow an agent's access further.

An app can also require accounts of its own, such as a team's service key. People who can edit the app link their own accounts to **App accounts** for everyone. Everyone who can use the app then uses that linked account through the app's tools (and the app uses it for app-scope background work) without direct management access to the account itself. Editing the app does not let anyone link somebody else's account. After unlinking an app account or removing its owner from the organization, new tool calls no longer resolve that link. See [Providers and accounts](/docs/concepts/providers-and-accounts#app-accounts).

## Joining and signing in

- **Cloud:** Standard sign-in methods include Google, GitHub, passkeys, and verified email codes (subject to organization SSO routing). People join by invitation, or — on an Enterprise organization with SAML or OIDC SSO configured for its verified domain — can be provisioned when signing in through the identity provider (subject to seat limits; a valid pending invitation still needs acceptance). One verified exact-domain match routes the email form to SSO (multiple matches stop discovery; no match uses an email code). The **Single sign-on** card in **Settings** is shown to Enterprise owners and admins.
- **Self-host:** First-run setup creates one organization (initial slug `executor`) and its owner. After that, password registration requires an invitation. If your Self-host administrator configures OIDC SSO (HTTPS discovery, client ID, secret, and allowed domains), it can also admit new users with verified email addresses in the exact allowed domains without an invitation; existing password users link SSO from **Account settings → Security**. Password sign-in remains available if OIDC discovery fails. Self-host does not offer the Cloud Google and GitHub buttons.

A login is not an account. Signing in with Google does not create a Google account an app can use, and no tool receives your browser login session. See [Providers and accounts](/docs/concepts/providers-and-accounts).

## Slugs

Organization slugs use up to 45 lowercase letters or digits, with single hyphens between segments. Dashboard URLs are built from the slug as `/org/<slug>/...`. On **Cloud**, an automatically generated onboarding slug can receive a short random suffix if taken (a manually requested taken slug is rejected rather than renamed); **Self-host** setup starts with `executor`. Changing a slug does not leave a redirect behind, so update your links.

## Access is never implicit

Being in an organization is what grants access. There is no ambient "current organization" that decides it: the organization you are looking at in the dashboard is a display preference and nothing more.

That matters most for agents. An MCP connection is approved for one organization, and the grant records it. Switching organization in the dashboard afterwards does not retarget the connection, including after the token refreshes. To reach a second organization, connect again and approve it separately. An API call whose URL names a different organization than the grant is refused, even when you belong to both.

Subsequent requests revalidate your membership; losing membership prevents further access in that organization.

## What is coming later

- Workspaces: a grouping inside an organization for installing apps and sharing accounts with a smaller set of people.

## Related

- [Members and roles](/docs/organizations/members)
- [Groups and sharing](/docs/organizations/groups)
- [Organization settings](/docs/organizations/settings)
- [Plans and billing](/docs/cloud/billing)
- [How Executor protects credentials](/docs/security/credentials)
