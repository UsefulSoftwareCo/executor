---
title: Publish and install published apps
description: "Publish an app from Executor Cloud to the public directory at executor.sh/apps, or install published apps on Local, Self-host, or Cloud."
---

Publishing exposes the selected commit's files, package name, `package.json` description, commit ID, and publication date publicly at [executor.sh/apps](https://executor.sh/apps) under `@<org-slug>.executor.community/<app-name>`. Publishing leaves connected account records, live app data (such as the app's SQLite database), and private Git history behind—any credentials or private data written into included files become public. **Publishing and unpublishing** (`Publish`, `executor apps publish`, `executor apps unpublish`) are **Cloud** only. **Browsing and installing** (`executor apps catalog`, `executor apps install`) work on **Local**, **Self-host**, and **Cloud**.

**Key command:** publish from Cloud with `executor apps publish --app "$APP_ID" --commit "$COMMIT"`; install anywhere with `executor apps install --package "$PACKAGE" --commit "$COMMIT" --name "My Copy"`.

**Prerequisites:** to publish, sign in as a Cloud organization **owner** or **admin** with edit access to the app. For the CLI, run `executor apps login`, open the verification link, select the organization, and approve **Executor API** access. Published apps are available to install on Local, Self-host, and Cloud. Hosted installs require app-management write access and an all-apps policy in the target workspace. The shell examples use `jq`; install it first, or copy the named fields from the JSON output.

**You'll know it worked when…** `executor apps published` (or **View public listing**) shows your package on `executor.sh/apps`, and `executor apps install` creates an independent copy in the target workspace.

## How to use it

### Publish from Executor Cloud

Publishing is enabled only on Executor Cloud. **Local** has no **Publish** action. On **Self-host**, owners and admins who can manage the app see a disabled **Publish** button explaining *"Publishing is not available on this server."*

- **From the Cloud dashboard:**
  1. Open your app and click **Publish**.
  2. Review the listing preview. If the dialog flags a package name issue or blocked file, use **Rename and continue** (which saves a new commit with the scoped name) or **Copy prompt** to resolve it.
  3. Click **Publish** (or **Publish update** for later commits).
  4. Click **View public listing** to open the page on `executor.sh/apps`.
  5. To remove a listing later, reopen **Publish** and click **Unpublish**.

- **From the CLI (Cloud):** before publishing from the CLI, save a commit whose `package.json` already has a valid scoped `name` matching your organization's current slug (for example, `@your-org.executor.community/hello`). The CLI publishes that commit as-is without modifying `package.json`.
  ```bash
  executor apps login
  executor apps list
  APP_ID="<id-from-list>"
  executor apps history --app "$APP_ID"
  COMMIT="<40-char-sha-from-history>"
  executor apps publish --app "$APP_ID" --commit "$COMMIT"
  executor apps published
  ```

- **Remove a listing from the CLI (Cloud):** run `unpublish` separately when you want to take the listing down:
  ```bash
  executor apps unpublish --package "@your-org.executor.community/hello"
  ```

### Browse and install published apps (Local, Self-host, Cloud)

Browse and read published app source at [executor.sh/apps](https://executor.sh/apps). The dashboard's **Browse app catalog** lists official apps, not community listings. To install a community app, read its current `name` and `commit` from `executor apps catalog` and pass both to `executor apps install`:

- **Local:** run from a CLI profile with no configured or remembered host so commands target your local background Executor (which queries `EXECUTOR_REGISTRY_URL`, defaulting to Executor Cloud). If you are using the same CLI profile you just used for Cloud `executor apps login`, then on both the catalog and install commands unset `EXECUTOR_ACCESS_TOKEN`, set `EXECUTOR_API_KEY` to your Local server's API key, and pass `--host http://127.0.0.1:4312` without `--organization`; check the target before installing:
  ```bash
  executor apps catalog
  executor apps install \
    --package "$PACKAGE" \
    --commit "$COMMIT" \
    --name "My Copy"
  ```
- **Cloud:** sign in with `executor apps login`, then run `executor apps catalog` and `executor apps install`.
- **Self-host:** sign in with `executor apps login --host https://executor.example.com`, then run `executor apps catalog` and `executor apps install`. Self-host reads from `EXECUTOR_REGISTRY_URL` (defaulting to Executor Cloud).

## Example

Save a commit in your Cloud app whose `package.json` includes `"name": "@your-org.executor.community/hello"`, then publish that commit from Cloud and install it into a separate Local CLI profile (with no remembered hosted host). The shell examples below use `jq`; install it first, or copy the named fields from the JSON output:

```bash
# 1. On Cloud: sign in, find the app ID and latest commit, and publish
executor apps login
APP_ID="$(executor apps list | jq -r '.[] | select(.name == "Hello") | .id')"
COMMIT="$(executor apps history --app "$APP_ID" | jq -r '.[0].commit')"
executor apps publish --app "$APP_ID" --commit "$COMMIT"
executor apps published
```

```bash
# 2. On Local (a CLI profile with no remembered host, or with --host and EXECUTOR_API_KEY):
LISTING="$(executor apps catalog | jq -r '.[] | select(.name == "@your-org.executor.community/hello")')"
PACKAGE="$(printf '%s' "$LISTING" | jq -r .name)"
PINNED_COMMIT="$(printf '%s' "$LISTING" | jq -r .commit)"
executor apps install \
  --package "$PACKAGE" \
  --commit "$PINNED_COMMIT" \
  --name "Hello Copy"
```

## Limits

- **Cloud-only publishing:** Local and Self-host do not host a writable package registry; they act as read-only clients of `EXECUTOR_REGISTRY_URL`.
- **Package naming:** when you publish, use a scoped `package.json` name matching your current organization slug (`@<org-slug>.executor.community/<app-name>`). The app-name label must start with a lowercase letter or digit, contain only lowercase letters, digits, or hyphens, and be at most 63 characters. Renaming your organization slug moves existing listings under the new scope and keeps their published commits. Update the scoped name in a new commit before publishing again.
- **Size and file filters:** a publication can contain up to 512 files and 4 MiB of source outside `ui/public/` (public assets have separate source limits), and an optional description up to 2,000 characters. Paths containing `.env`, `.env.*`, `.npmrc`, `node_modules`, `.git`, or `.executor` are blocked.
- **Pinned to the current listing commit:** `executor apps install` requires the listing's currently published 40-character `--commit` and creates an independent copy in your workspace. If the listing changes before you install, review the new commit before using it. Unpublishing removes the public listing. Existing installed copies keep their source.
- **Public source vs private state:** anyone can read the selected commit's files, package name, `package.json` description, commit ID, and publication date. Publishing leaves connected account records, live app data, and private Git history behind, but credentials or private data written into included files become public. Review the selected files and description for secrets and private data before publishing.

## Related

- [Add an app](/docs/apps/add)
- [App source and Git](/docs/apps/source-and-git)
- [Apps and versions](/docs/concepts/apps-and-versions)
- [Command line](/docs/run/cli)

Using Executor CLI 2.0.0-beta.79? For app management and Git, run `executor apps login`. For tool commands and MCP, run `executor login`. For Self-host, add `--host <your origin>` to the sign-in command.
