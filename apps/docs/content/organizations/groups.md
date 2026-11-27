---
title: Groups and sharing
description: "Organize members into groups and share apps or manual OAuth clients with selected groups or everyone in your organization."
---

**Groups** let you share apps and manual OAuth clients with a specific set of teammates instead of only yourself or the entire organization. From **Groups** (`/org/<slug>/groups`), owners and admins click **Create group**, select members, and then pick that group under an app's **Settings → App access** or a manual OAuth client's sharing menu.

Available on **Self-host** and **Cloud** with identical steps. Local Executor runs for one person on one machine and has no groups.

**Prerequisites:** You must be an organization **owner** or **admin** to create, edit, or delete groups, or to register and share OAuth clients. To change who can use an app, you must be the app's creator, an **admin**, or an **owner**.

**You'll know it worked when:** Opening a group's detail page (`/org/<slug>/groups/<group-id>`) lists its teammates under **Members** (and lists shared apps available in your own directory under **Apps**, including org-wide apps). A member of that group can find the shared app in **Apps** and run a deployed tool they have the required accounts for — and reach it through MCP on a connection whose scope includes that app and tool.

## Who can see groups

- **Owners and admins** see every group in the organization and every member in each group.
- **Members** see only the groups they belong to and the rosters of those groups in **Groups**. They cannot create, rename, edit, or delete groups.

## Create and manage groups

1. Open **Groups** (`/org/<slug>/groups`) from the sidebar.
2. Click **Create group**.
3. Enter **Group name** (1–80 characters, unique case-insensitively in the organization) and, optionally, **Description (optional)** (up to 240 characters).
4. Select the teammates to include in the form and click **Create group**.

From a group's detail page (`/org/<slug>/groups/<group-id>`), owners and admins can also:

- Click **Edit group** to change the name or description, check or uncheck members, and click **Save group**. (In an empty group, you can also start with **Add members**.)
- Click **Delete group** and confirm with **Delete group** to remove the group and its membership list. Organization members and apps are kept; apps that were shared only with that group stop being available to its former members.

## Share an app with groups

Apps you create start as **Only me**. To change who can use an app:

1. Open the app and go to its **Settings** tab.
2. Under **App access** (**Who can use this app?**), choose an audience:
   - **Only me** when you created the app, or **Only the creator** when you manage someone else's app. Only the creator can use it.
   - **Selected groups**: pick one or more groups. Regular members who created the app can only pick groups they belong to; admins and owners can pick any group in the organization.
   - **Everyone in the organization**: every current member can use the app.
3. Click **Save access** (or **Reset changes** to discard edits).

Sharing an app grants permission to see and run its tools (subject to deployment, connection tool scope, and required accounts). It never shares your personal accounts — each teammate connects and links their own accounts unless the app declares app-scoped accounts linked by an editor.

## Share an OAuth client with groups

Organization owners and admins can register manual OAuth clients and control which members may sign in with them when connecting accounts.

To register a new manual OAuth client:

1. First add an app that exposes an eligible OAuth sign-in service.
2. Open **Accounts** (`/org/<slug>/accounts`) and click **OAuth clients**.
3. Click **Register client**.
4. Select **Service**, copy **Redirect URL** into the service's OAuth settings, and enter **Client ID** and **Client secret (optional)** when needed.
5. Set **Who can use this client?** (**Only me**, **Selected groups**, or **Everyone in the organization**) and click **Register**.

To edit an existing manual OAuth client:

1. Open the client's menu in **Accounts → OAuth clients** and click **Edit**.
2. Update the credentials or **Who can use this client?** (**Only the creator**, **Selected groups**, or **Everyone in the organization**). The client stays tied to its registered **Service**.
3. Click **Save**.

Only manual OAuth clients have editable sharing. Existing accounts keep the OAuth details they used to sign in. Changing who can use a manual client also affects reconnects and any OAuth flow that is still in progress — a member who loses access to the client may need to choose another client to reconnect.

## Example

The organization HTTP API exposes group creation and app sharing with optimistic concurrency via `revision`. As an owner or admin with a [personal access token](/docs/api-keys), set `EXECUTOR_API_ORIGIN` to `https://api.executor.sh` on Cloud or your deployment's origin on Self-host, set `ORG_ID` and `APP_ID` to your organization and app IDs, and set `EXECUTOR_API_KEY` to your token:

```sh
# 1. Read organization members to pick a member ID for the group
curl "$EXECUTOR_API_ORIGIN/api/organizations/$ORG_ID/groups" \
  --header "Authorization: Bearer $EXECUTOR_API_KEY"
# Set MEMBER_ID from an entry in .members[].id

# 2. Create a group with that member (note the returned .id as GROUP_ID)
curl -X POST "$EXECUTOR_API_ORIGIN/api/organizations/$ORG_ID/groups" \
  --header "Authorization: Bearer $EXECUTOR_API_KEY" \
  --header 'Content-Type: application/json' \
  --data "{\"name\":\"Support\",\"description\":\"Customer support engineers\",\"memberIds\":[\"$MEMBER_ID\"]}"

# 3. Read the app's current access revision (note .revision as REVISION)
curl "$EXECUTOR_API_ORIGIN/api/organizations/$ORG_ID/apps/$APP_ID/access" \
  --header "Authorization: Bearer $EXECUTOR_API_KEY"

# 4. Share the app with the new group (creator, admin, or owner)
curl -X PATCH "$EXECUTOR_API_ORIGIN/api/organizations/$ORG_ID/apps/$APP_ID/access" \
  --header "Authorization: Bearer $EXECUTOR_API_KEY" \
  --header 'Content-Type: application/json' \
  --data "{\"audience\":{\"kind\":\"groups\",\"groups\":[\"$GROUP_ID\"]},\"revision\":\"$REVISION\"}"
```

Expect the `PATCH` response to show `"audience":{"kind":"groups","groups":["<GROUP_ID>"]}` with a new `revision`. To verify end to end, have the included member open the app in **Apps** and run a deployed tool they have the required accounts for.

## Limits

- **Accounts are never shared via groups:** Groups apply to apps and manual OAuth clients only. Personal account management checks who connected the account, including for admins. A group-shared app can still use app-scoped accounts linked by an editor through the app's tools without exposing those accounts directly.
- **Name and size caps:** Group names must be 1–80 characters and unique case-insensitively within the organization (`name_taken`). Descriptions are up to 240 characters. A group holds up to 10,000 distinct current organization member IDs; an app or OAuth client audience accepts up to 1,000 distinct group IDs.
- **Member sharing restriction:** A non-admin app creator can only share with groups they belong to; choosing another group returns `403`.
- **Only the creator:** Use **Only the creator** only when the creator is still a member and should have exclusive access. If the creator is missing from the record (for example, a deleted user or a system-created app), Executor rejects **Only the creator** (`creator_unavailable`); choose **Selected groups** or **Everyone in the organization**.
- **Concurrent edits:** Group and access updates check a `revision` token and refuse stale writes with `409`: `changed` for a stale revision, `members_changed` when a group edit includes a user who is no longer a member, and `groups_changed` when an access edit references a removed or inaccessible group.
- **OAuth client secrets:** Saved client secrets are never returned by the client management UI or OAuth client API after registration or update (responses expose only `hasSecret`).

## Related

- [Organizations and access](/docs/concepts/organizations-and-access)
- [Members and roles](/docs/organizations/members)
- [Providers and accounts](/docs/concepts/providers-and-accounts)
- [Connect an account](/docs/connect-an-account)
- [Organization settings](/docs/organizations/settings)
