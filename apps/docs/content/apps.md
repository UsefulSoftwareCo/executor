---
title: Apps
description: "Browse installed apps on the Apps page, navigate an app's ten tabs, and rename or delete apps in Local, Self-host, and Cloud."
---

Every service or custom toolset in Executor lives inside an **app** with its own source code, versions, stored data, and account requirements. Open the **Apps** page in the dashboard (`/apps` on **Local**; `/org/<slug>/apps` on **Self-host** and **Cloud**) to search, filter, and open an app card to inspect its available tabs.

- **Available on:** Local, Self-host, and Cloud.
- **Required permissions and prerequisites:** On Self-host and Cloud, any member with app access can use its tools, skills, workflows, and own schedules subject to the applicable account requirements, while only the **app creator** and **organization admins** (`owner` or `admin`) can read **Source** and **Versions**, rename, copy, change **App access**, or delete an app. On Cloud, organization **owners** and **admins** with app edit access can publish apps (Local has no **Publish** action; Self-host shows it disabled). On Local, every non-managed app can be renamed and deleted. For Local CLI commands below, make sure no hosted target is configured or remembered; on Cloud or Self-host, sign in first with `executor apps login --host "$EXECUTOR_ORIGIN"` (use `https://api.executor.sh` for Cloud).
- **Main CLI command (Local):**

```bash
executor apps list
```

You'll know it worked when the dashboard **Apps** page shows your apps and their linked account status, or when `executor apps list` prints your usable apps and their declared account requirements.

## The Apps page

The **Apps** page displays a card grid of apps you can access, with **Search apps…**, **Connect your agent**, and **Add app** controls in the header:

- Each card shows the app's name and linked account status: **Needs account** (a required account is missing), **No account required**, **No accounts linked**, or the names of linked accounts (with a warning icon if an account needs sign-in or is unavailable).
- On **Self-host** and **Cloud**, click **Filters** to narrow the list by **Group** or switch between **Available to me** (apps you can use) and **Manage apps** (apps you created or can manage as an organization admin, even if not shared with you for use). Click **Reset** or **Clear filters** to return to the default list.

## An app's page and its tabs

Open an app card to inspect the tabs available for your role. The header includes a back link to **Apps**, an open-UI action when the app serves a UI, and **Publish** on hosted dashboards (enabled on Cloud for organization owners and admins with app edit access; disabled on Self-host and for ordinary members; absent on Local). Below the header sit ten tabs:

| Tab | What it shows | Who can use it (Self-host & Cloud) |
| --- | --- | --- |
| **Overview** | Summary cards for **Accounts**, **Tools**, skills/workflows, and **Source** (or a **No version yet** prompt before first deploy) | Users with app access (source preview restricted to creator/admins) |
| **Accounts** | Connect and link user-scoped accounts (and app-scoped accounts for managers) | Users with app access |
| **Tools** | Browse tool schemas and run tools interactively (see [Tools tab](/docs/apps/tools)) | Users with app access |
| **Skills** | Read and edit skill documents shipped by the app | Users with app access (editing requires source-edit access) |
| **Workflows** | View workflow definitions, start runs, and view runs you are authorized to see | Users with app access |
| **Schedules** | View and configure scheduled runs | Use the app to configure your own schedules; app managers can configure app-wide schedules |
| **Webhooks** | View subscriptions and sources you are authorized to see | Manage your own subscriptions with the required account access. Inspecting app-wide or other users' subscriptions requires app manage access and applicable account access. |
| **Source** | Browse working Git files, view commit **History**, copy the **Clone** URL, and click **Deploy latest** | App creator and organization admins (may appear disabled for use-only members) |
| **Versions** | Inspect retained builds and switch active versions (see [Versions and deploying](/docs/apps/versions)) | App creator and organization admins (may appear disabled for use-only members) |
| **Settings** | **App name** (**Rename**), **Copied from** provenance, **Make a copy**, **Delete app**, **App access** (Self-host/Cloud), and desktop app settings | Viewable by users with app access; management actions require creator/admin |

Before required accounts are linked, **Tools**, **Skills**, and **Workflows** show a prompt with a **Go to Accounts** button.

## Renaming an app

Renaming an app updates its display name and derives a lowercase DNS slug (a case or punctuation-only change can leave the slug unchanged). The name must contain at least one non-whitespace character and fit within 120 characters; both the scoped name and normalized slug must stay unique within the owner (your local server or your organization).

### Cloud and Self-host

1. Prerequisites: You must be the app creator or an organization admin.
2. Open the app, click the **Settings** tab, and click **Rename** next to **App name**.
3. In the **Rename app** dialog, enter the new **App name** and click **Save name**.

You'll know it worked when the header displays the new name. If the derived slug changed, sign in with `executor login` for Cloud or `executor login --host "$EXECUTOR_ORIGIN"` for Self-host, run `executor search` again, and copy the exact new tool path (search emits bracket notation such as `tools["my-app"].tool` when a slug requires quoting).

### Local

1. Open the app at `/apps/<app-id>`, click **Settings**, and click **Rename**. (The built-in Executor app is managed by Executor and cannot be renamed.)
2. Enter the new name and click **Save name**.

You'll know it worked when the app card on `/apps` shows the new name and `executor search` returns the exact tool path for the updated slug if it changed.

## Deleting an app

Deleting removes the app from the workspace and ends access to its source, versions, and app data through that app. There is no undo in the dashboard. Connected accounts and independent copies are kept. Stop active webhook subscriptions and wait for queued or running workflows to finish before deleting.

### Cloud and Self-host

1. Prerequisites: You must be the app creator or an organization admin.
2. Open the app's **Settings** tab and click **Delete app**.
3. In the **Delete app?** dialog, verify the app name and click **Delete app** to confirm (or **Cancel**).

You'll know it worked when Executor redirects you to `/org/<slug>/apps` and the deleted app no longer appears in the list.

### Local

1. Open the app's **Settings** tab and click **Delete app**. (Managed local apps such as the built-in Executor app cannot be deleted.)
2. On the `/apps/<app-id>/delete` confirmation page (**Delete app?**), click **Delete app**.

You'll know it worked when Executor redirects you to `/apps` and the app is no longer listed.

## Example

List apps from the CLI (`2.0.0-beta.79`) against Local (with no configured or remembered hosted target):

```bash
executor apps list
```

List apps on Cloud (`https://api.executor.sh`) or Self-host (replace `EXECUTOR_ORIGIN` with your server's origin):

```bash
EXECUTOR_ORIGIN="https://api.executor.sh"
executor apps login --host "$EXECUTOR_ORIGIN"
executor apps list --host "$EXECUTOR_ORIGIN"
```

## Limits

- **App name length and uniqueness:** 1 to 120 characters with at least one non-whitespace character; both the name and derived slug must stay unique within the local server or organization.
- **Managed built-in apps:** On Local, Executor-managed apps display `"This app is managed by Executor and cannot be renamed or deleted."` on **Settings**.
- **Delete preconditions and no undo:** Stop active webhook subscriptions and wait for queued or running workflows to finish before deleting; deleting removes workspace access to the app, its source, versions, and app data with no undo in the dashboard.
- **Source and Versions access:** On Self-host and Cloud, sharing tool access alone leaves **Source** and **Versions** under manage permissions (creator, admin, owner); members who lack manage access may see those tab labels disabled.
- **Publishing is Cloud-only:** Only Cloud organization owners and admins with app edit access can publish; Self-host displays **Publish** disabled and Local omits it.
- **Slug changes affect callers:** If renaming changes the derived slug, re-run `executor search` and update scripts that reference the old path.

## Related

- [Tools tab](/docs/apps/tools)
- [Versions and deploying](/docs/apps/versions)
- [Share and copy apps](/docs/apps/share-and-copy)
- [Apps and versions](/docs/concepts/apps-and-versions)
- [Connect an account](/docs/connect-an-account)
- [Desktop apps](/docs/desktop-apps)
