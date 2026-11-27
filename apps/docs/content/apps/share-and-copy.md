---
title: Share and copy apps
description: "Control who in your organization can use an app with Only me, Selected groups, or Everyone, and make independent copies with Make a copy or executor apps copy."
---

On **Self-host** and **Cloud**, **App access** on an app's **Settings** tab controls who in your organization can use an app: **Only me** (or **Only the creator**), **Selected groups**, or **Everyone in the organization**. On **Local**, **Self-host**, and **Cloud**, **Make a copy** (or `executor apps copy`) creates a separate app with fresh Git history from an existing app's active deployed source (or working source if never deployed), leaving connected-account links and stored app data with the original.

- **Available on:** **App access** is on Self-host and Cloud only; **Make a copy** is on Local, Self-host, and Cloud.
- **Prerequisites and permissions:** On hosted targets, the app creator and organization admins/owners can change **App access** or copy an app. For CLI copy on Local, make sure no hosted target is configured or remembered; on Cloud (`https://api.executor.sh`) or Self-host, sign in for app commands as described below. Use the `id` of the app you intend to copy as `APP_ID`.
- **Main CLI command (Local):**

```bash
executor apps copy --app "$APP_ID" --name "My app copy"
```

You'll know it worked when **App access** shows **Saved** (and a teammate in the audience sees the app under **Apps** → **Available to me**), when **Make a copy** opens the copy's **Source** tab, or when `executor apps copy` prints the new app's `id`, `slug`, and `copiedFrom`.

## Sharing an app (Cloud and Self-host)

New apps created by a signed-in user—and manual copies made with **Make a copy** or `executor apps copy`—start private to their creator (**Only me**), including for owners and admins. System-provisioned apps (such as the organization's built-in Executor app) start shared with **Everyone in the organization** and have no individual creator, so **Only me** is disabled for them.

### Changing app access

1. Open the app and click the **Settings** tab.
2. Under **App access**, pick one of the three audiences:
   - **Only me** (displayed as **Only the creator** when an admin views someone else's app): Only the app's creator can use the app. Organization admins keep manage access under **Filters** → **Manage apps**.
   - **Selected groups**: A member can run the app if they belong to a selected group. Even a creator or organization admin outside all selected groups keeps manage access under **Filters** → **Manage apps** rather than use access. Regular members can select only groups they belong to; owners and admins can select any group in the organization. If no groups are available to you, an owner or admin can choose **Open Groups** to create one (the form requires at least one group; the API accepts an empty group list that grants use to nobody).
   - **Everyone in the organization**: Every member of the organization can see and use the app.
3. Click **Save access** (or **Reset changes** to discard edits).

You'll know it worked when **Saved** appears next to the buttons and a user in the chosen audience sees the app under **Apps** → **Available to me**.

### What sharing grants (and does not grant)

- Callers with access run the active version and can access the shared app data exposed by its tools or UI.
- Each caller uses their own personal links for user-scoped requirements on the app's **Accounts** tab. Personal account management checks who connected the account, including for admins (sharing or managing an app does not expose another member's personal account inventory).
- A manager can link an account under **App accounts** for authorized callers to use through the app's tools.

## Making a copy of an app

A copy is a new app with fresh Git history:

- **What is copied:** Executor copies the active deployed source (even if the working head has newer edits) and deploys the copy automatically, or copies the saved working source as an undeployed draft if there has been no deployment. Any files bundled in that snapshot are included. **Copied from** on **Settings** records the source name and commit when available.
- **What stays with the original:** Executor creates fresh app storage and leaves connected-account links, stored app data, and prior Git history with the original.
- **Independence:** Editing, redeploying, or deleting the original app does not change the copy.

Copying is also the standard way to run two personal accounts side by side (for example, work and personal accounts for the same provider): copy the app and link one account to each copy.

### From the dashboard (Local, Self-host, and Cloud)

1. Open the app and click the **Settings** tab.
2. Click **Make a copy**.
3. In the **Make a copy** dialog, edit the new app's name (pre-filled as `<name> copy` when 115 characters or shorter) and click **Make a copy**.

You'll know it worked when Executor opens the new app's **Source** tab and **Settings** shows **Copied from**. If the original was deployed, check that the copy has an active version and run a tool you expect to work after linking any required accounts.

### From the CLI (`executor apps copy`)

#### Local

With no configured or remembered hosted target, find `APP_ID` with `executor apps list` and copy it:

```bash
executor apps copy --app "$APP_ID" --name "GitHub work"
```

#### Cloud and Self-host

Set `EXECUTOR_ORIGIN` to `https://api.executor.sh` for Cloud or to your Self-host origin. Run `executor apps login --host "$EXECUTOR_ORIGIN"`, choose the intended organization, and authorize **Executor API** under **Access**. Use an account with manage access to the source app.

List apps on the same host with `executor apps list --host "$EXECUTOR_ORIGIN"` to find an app you can use. To copy an app you manage without use access, open it through **Apps → Filters → Manage apps**, and set `APP_ID` to the ID from its dashboard URL.

```bash
read -r -p "Source app ID: " APP_ID
```

Copy that app:

```bash
executor apps copy --host "$EXECUTOR_ORIGIN" --app "$APP_ID" --name "GitHub work"
```

You'll know it worked when the CLI prints the new app's JSON record with its own top-level `id`, `slug`, and `copiedFrom`.

## Example

Create and deploy a Local app, copy it with `executor apps copy`, and run the copy's tool using the exact path returned by `executor search` (with no hosted target selected):

```bash
mkdir -p ./hello-source
FRAMEWORK_VERSION=$(executor apps framework | node -e 'const d = JSON.parse(require("node:fs").readFileSync(0, "utf8")); console.log(d.version);')

cat <<EOF > ./hello-source/package.json
{
  "name": "hello-source",
  "private": true,
  "dependencies": {
    "apps": "${FRAMEWORK_VERSION}"
  }
}
EOF

cat <<'EOF' > ./hello-source/index.ts
import { defineApp, object, query, router } from "apps";
const greet = query({ input: object({}) }, async () => "hello from copy");
export default defineApp({}, { tools: router({ greet }) });
EOF

APP_ID=$(executor apps create --name "hello-source" --files ./hello-source | node -e 'const d = JSON.parse(require("node:fs").readFileSync(0, "utf8")); console.log(d.id);')
executor apps deploy --app "$APP_ID" --files ./hello-source --message "Initial deploy"

executor apps copy --app "$APP_ID" --name "hello-copy"

COPY_TOOL=$(executor search "hello-copy" | node -e 'const d = JSON.parse(require("node:fs").readFileSync(0, "utf8")); console.log(d.items[0].path);')
executor call "$COPY_TOOL" --input '{}'
```

## Limits

- **Local has no App access:** Local Executor is single-user and does not display the **App access** section or groups.
- **Member group-sharing rule:** Regular organization members (`role: "member"`) can only select groups they are already members of; attempting to share with another group is rejected.
- **Concurrent access edits:** **App access** uses optimistic concurrency (`revision`); if the access settings change before you save, refresh and reapply your edits.
- **No automatic sync between copies:** Copies do not pull future updates from the original app.
- **Hosted CLI copy permissions:** On Self-host and Cloud, copying via API or CLI requires manage access on the source app, a manage-capable grant, and an all-apps policy on the app-management route.

## Related

- [Apps](/docs/apps)
- [Versions and deploying](/docs/apps/versions)
- [Apps and versions](/docs/concepts/apps-and-versions)
- [Organizations and access](/docs/concepts/organizations-and-access)
- [Providers and accounts](/docs/concepts/providers-and-accounts)
