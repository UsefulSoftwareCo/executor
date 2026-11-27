---
title: Members and roles
description: "Invite people to an Executor organization, assign Member or Admin roles, remove members, and understand the Free plan's three-member limit."
---

An organization's **Members** list controls who belongs to your workspace and what they can manage. From **Settings** (`/org/<slug>/organization`), owners and admins click **Add member** to invite teammates, change a member's role between **Member** and **Admin**, or remove people who no longer need access.

Available on **Self-host** and **Cloud**. Local Executor runs for one person on one machine and has no organizations or members.

**Prerequisites:** You must hold the **owner** or **admin** role in the organization. On **Cloud**, your own email address must be verified before you can send invitations, and an organization on the **Free** plan must have fewer than three members.

**You'll know it worked when:** After you invite someone, they appear under pending invitations with an **Invited** badge. Once they open the link and complete **Accept invitation**, they move into the **Members** list with their assigned role.

## Roles and permissions

Every member holds one role:

| Role | What they can do |
| --- | --- |
| **Member** (`member`) | Create apps, connect their own accounts, use apps they created or that are shared with them, and manage apps they created. |
| **Admin** (`admin`) | Everything a member can do, plus invite and remove members, change member roles between **Member** and **Admin**, manage groups, manage OAuth clients, view organization-wide activity, manage app access and editable apps, publish apps on Cloud (when the app has editable source), and manage Cloud billing. |
| **Owner** (`owner`) | Everything an admin can do, plus delete the organization on Cloud. |

Roles control management access, not which tools someone can call or whose accounts they can use. Owners and admins can manage app access (including private apps), while whether they can run an app's tools depends on its audience. Personal account management checks who connected the account, including for admins. An app can also use app-scoped accounts linked by an editor.

## Invite a member

Open **Settings** (`/org/<slug>/organization`) and go to the **Members** card. Owners and admins can use **Add member** and see pending invitations. Regular members see **Add member** disabled and do not see pending invitations.

### Cloud

1. Click **Add member**.
2. Enter the teammate's **Email** and choose a **Role** (**Member** or **Admin**).
3. Click **Send invitation**.
4. Executor emails the invitation and shows **Invitation sent** with **Or share the invite link directly** (input **Invitation link**, `/invite?invitation=<id>`). Click **Copy link** to share it directly, **Invite another** to send another invitation, or **Done** to close the dialog.

For a pending invitation, use the row's **Resend** button or the **Revoke invitation** trash icon.

### Self-host

Self-hosted instances create shareable invite links rather than sending email.

1. Click **Add member**.
2. Enter the teammate's **Email** and choose a **Role** (**Member** or **Admin**).
3. Click **Create invite link**.
4. Executor displays **Invite link ready** with **Invite link** (input **Invitation link**, `/invite?invitation=<id>`). Click **Copy link** and send the link to your teammate.

For a pending invitation, use the row's **Get invite link** button or the **Revoke invitation** trash icon.

Use **Resend** on Cloud or **Get invite link** on Self-host to renew or recover the invitation. Resending can keep the same link and role. To invalidate a link or change a pending recipient's role, select the trash icon, confirm **Revoke invitation** in the dialog, then create a new invitation with the desired role.

### Accept an invitation

- **Cloud:** Open the link (`/invite?invitation=<id>`), sign in with the invited email address, then select **Accept invitation** on **Join an organization**.
- **Self-host (existing account):** Open the link, sign in with the invited email address, then select **Accept invitation** on **Join an organization**.
- **Self-host (new account):** Open the link and choose **Join with this invitation** from the sign-in form. On **Join Executor**, enter **Your name**, the invited **Email**, and a **Password**, then select **Accept invitation** to register, accept the invitation, and sign in.

Email address matching is case-insensitive. If you are already signed in and open an invitation link you previously used, Executor displays **Join an organization**; selecting **Accept invitation** again shows **You're already in this organization** with a **Continue** button.

## Change roles and remove members

On the **Members** card in **Settings**:

- **Change a role:** Open the role menu on a member's row and switch between **Member** and **Admin**. The change applies to subsequent requests.
- **Remove a member:** Select the row's **Remove member** trash icon, then confirm with **Remove member**. Removal ends the person's organization access for subsequent requests. Their personal account links stop being usable. App calls stop using app-scoped accounts they connected, even if the links still appear to app editors.

## Free plan member limit (Cloud)

On **Cloud**, organizations on the **Free** plan can have up to **3 members** (see [pricing](https://executor.sh/pricing)). Owners and admins see the current seat count (`X of 3`) next to the **Members** heading.

Once an organization on the Free plan has 3 members:

- Clicking **Add member** or **Resend** opens the **Member limit reached** dialog with an **Upgrade plan** button linking to **Billing** (`/org/<slug>/billing`).
- At the Free limit, an owner or admin's direct invite request returns `403 ORGANIZATION_MEMBERSHIP_LIMIT_REACHED`. The invited person must use the matching email. Acceptance also checks the member limit.

Active or trialing **Team** and **Enterprise** plans lift the Free membership cap.

## Example

The invitation link path is `/invite?invitation=<id>` on both Cloud (`https://app.executor.sh`) and Self-host (`<your-origin>`):

```text
https://app.executor.sh/invite?invitation=inv_01example
```

To verify your organization membership and current role with a [personal access token](/docs/api-keys), set `EXECUTOR_API_ORIGIN` to `https://api.executor.sh` on Cloud or your deployment's origin on Self-host, set `ORG_ID` to your organization ID, and set `EXECUTOR_API_KEY` to an active token that can access the organization:

```sh
curl "$EXECUTOR_API_ORIGIN/api/organizations/$ORG_ID/access" \
  --header "Authorization: Bearer $EXECUTOR_API_KEY"
```

The response returns your `organization` ID, current `role` (`owner`, `admin`, or `member`), and `owner` (an internal Executor storage owner reference derived from the organization).

After removing a member, Executor revokes their personal access tokens scoped to this organization: requests with a revoked token return `401`. Requests that target the organization with a still-valid browser session or **Full account** token return `403`. An MCP connection authorized for the organization also loses access.

## Limits

- **Owner rows cannot be edited here:** You cannot demote or remove an organization **owner** from the **Members** list.
- **No self-removal:** Admins cannot remove themselves from the **Members** list (`You cannot remove yourself here.`).
- **Pending invitations are tied to their inviter:** If an admin is demoted to **Member** or removed from the organization, Executor automatically cancels pending invitations currently attributed to them (resending an invitation can reassign its inviter).
- **Invited email match:** Accepting an invitation checks that the email matches the invited address (case-insensitively). On Self-host, a new recipient can register and accept in one step through **Join with this invitation**.
- **Expired invitations:** Pending invitations that pass their expiry show an **Expired invite** badge and must be resent or recreated.

## Related

- [Organizations and access](/docs/concepts/organizations-and-access)
- [Groups and sharing](/docs/organizations/groups)
- [Organization settings](/docs/organizations/settings)
- [Plans and billing](/docs/cloud/billing)
- [Account settings](/docs/account)
