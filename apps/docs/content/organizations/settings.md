---
title: Organization settings
description: "Rename an organization, change its URL slug or icon, switch between organizations, create another on Cloud, or permanently delete one."
---

**Organization settings** (`/org/<slug>/organization`, opened from **Settings** in the sidebar) lets owners and admins update an organization's **Organization name**, **Organization icon**, and **Organization URL** (slug), and lets Cloud owners permanently **Delete organization**. You can switch organizations from the sidebar switcher without affecting active MCP connections.

Available on **Self-host** and **Cloud**. Creating additional organizations and deleting an organization are available on **Cloud** only. Local Executor has no organizations.

**Prerequisites:** Updating the organization name, icon, or URL requires the **owner** or **admin** role. Deleting an organization on **Cloud** requires the **owner** role in a signed-in browser session (API keys cannot delete an organization).

**You'll know it worked when:** After clicking **Save** on a setting card, the updated name or icon appears in the sidebar switcher, or your browser navigates to the new `/org/<new-slug>/organization` URL.

## Update name, icon, or URL slug

These steps are the same on **Cloud** and **Self-host**. Regular **members** see the fields disabled with the notice that only organization owners and admins can change organization settings.

### Organization name

1. Open **Settings** (`/org/<slug>/organization`).
2. Edit the **Organization name** field (non-blank, up to 120 characters).
3. Click **Save**.

### Organization icon

1. In the **Organization icon** card, click **Upload organization icon** and choose a **PNG**, **JPEG**, or **WebP** file up to **2 MiB**.
2. Click **Save** to publish the icon, or click **Remove icon** and **Save** to revert to the default initial avatar.

### Organization URL (slug)

1. In the **Organization URL** card, enter a new slug using lowercase letters, numbers, and hyphens, up to **45 characters** (for example `acme-ops`).
2. Click **Save**.

Changing the slug updates dashboard URLs (`/org/<slug>/...`) immediately and leaves no automatic redirect behind. Update your bookmarks — the old slug stops pointing to this organization and can later be used by another organization. On Cloud, changing the slug also moves your organization's public app publishing scope (`<slug>.executor.community`) to the new slug.

## Switch or create organizations

### Switch organizations

Click the organization switcher in the sidebar footer to open the **Switch organization** menu and pick another organization you belong to. Executor opens `/org/<slug>/apps` and remembers your last active organization in that browser.

Switching organizations in the dashboard is a display preference only. It never retargets existing MCP connections or personal access tokens — each MCP grant stays bound to the organization you approved when you connected.

### Create an organization (Cloud)

1. Open the sidebar organization switcher and click **Create organization** (or visit `/create`).
2. Enter **Name** (up to 100 characters) and **Handle** (slug, up to 45 characters — prefilled from the name until you edit it).
3. Select **Create organization** to create the organization as its owner.

Self-host first-run setup creates a single organization named by the installer with initial slug `executor`. Organization creation and deletion endpoints are disabled on Self-host.

## Delete an organization (Cloud)

Only an organization **owner** can delete an organization, and only from a signed-in browser session on **Cloud**.

1. Open **Settings** (`/org/<slug>/organization`) and scroll to the **Delete organization** card. Review the app and account counts shown there.
2. Click **Delete organization**.
3. In the confirmation dialog, type the organization's exact slug into **Confirm organization URL**.
4. Click **Delete organization** to confirm.

Deletion is permanent. Once Executor accepts it, members immediately lose access. Executor then removes the organization and its apps, versions, accounts, credentials, MCP connections, and uploaded icon, unregisters its webhooks, and cancels any active paid billing subscription as part of background cleanup. Queued or running workflows can block the deletion.

## Example

The slug pattern enforced on both creation and rename is lowercase alphanumeric segments separated by single hyphens, at most 45 characters:

```text
Valid:   acme, acme-ops, team-2
Invalid: Acme, acme_ops, -acme, acme--ops
```

When you rename `acme` to `acme-ops`, open `/org/acme-ops/apps` to confirm it loads the same organization. `/org/acme/apps` stops pointing to this organization (and `acme` can be claimed by another organization), while existing MCP grants bound to that organization's ID continue working without reconnecting.

## Limits

- **Slug rules:** Lowercase letters (`a–z`), digits (`0–9`), and single hyphens between segments (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), maximum **45 characters**. No automatic redirect is created for old slugs.
- **Name length:** Up to **120 characters** when renaming in Settings; up to **100 characters** in the Cloud **Create organization** dialog.
- **Icon format and size:** `image/png`, `image/jpeg`, or `image/webp` only, maximum **2 MiB** (`2 * 1024 * 1024` bytes).
- **Desktop pinned windows:** A desktop window authorized for a single pinned organization cannot switch to or create another organization; use the browser to create another.
- **Self-host restrictions:** Self-hosted servers have one organization (initial slug `executor`) and disable organization creation and deletion.
- **Browser session required for deletion:** Deleting an organization on Cloud requires a signed-in browser session; API keys and MCP clients cannot delete an organization. Queued or running workflows can block deletion until they finish.

## Related

- [Organizations and access](/docs/concepts/organizations-and-access)
- [Members and roles](/docs/organizations/members)
- [Groups and sharing](/docs/organizations/groups)
- [Plans and billing](/docs/cloud/billing)
- [Account settings](/docs/account)
