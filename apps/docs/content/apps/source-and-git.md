---
title: App source and Git
description: "Browse an app's files and commit history on the Source tab, push changes over Git, or commit and deploy snapshots from the CLI."
---

Every Executor app keeps its working source in Git on branch `main`. Browse files and commits on the **Source** tab (**Working source**, **History**, **Clone**, **Deploy latest**), or manage source from the terminal with `executor apps git`, `credential`, `source`, `history`, `commit`, and `deploy`. Available on **Local**, **Self-host**, and **Cloud**.

**Key step:** clone the app's Git remote, push changes to `main`, and deploy—pushing updates working source only and does not activate a version.

**Prerequisites:** edit access to the app, Git (with author name and email configured if needed), and the `executor` 2.0 beta CLI. For **Cloud** and **Self-host**, sign in with `executor apps login` (`--host <origin>` for Self-host). For **Local**, CLI snapshot commands use the background Executor when no host is configured or remembered (if you also use a hosted profile, unset `EXECUTOR_ACCESS_TOKEN`, set `EXECUTOR_API_KEY` to the Local API key, and pass `--host http://127.0.0.1:4312` without `--organization`). The shell examples use `jq`; install it first, or copy the named fields from the JSON output.

**You'll know it worked when…** your commit appears in **History** (or `executor apps history --app "$APP_ID"`) and the status badge reads **Live · up to date** after deploying.

## How to use it

### Browse and deploy in the dashboard (Local, Self-host, Cloud)

1. Open an app and select the **Source** tab.
2. Browse **Working source** on `main` and check the deployment status badge (`Not deployed`, `Live · up to date`, or a live badge showing newer undeployed commits on `main`).
3. Open **History** using the recent commit count link above the files (such as `1 recent commit`, `N recent commits`, or `History`); click **Back to files** to return to the file tree.
4. Click **Clone** to inspect **Git clone URL** and **Copy clone URL**.
5. Click **Deploy latest** to build and activate the latest commit on `main`.

### Clone, push, and deploy over Git

- **Cloud and Self-host:** sign in first (`executor apps login` for Cloud, or `executor apps login --host https://executor.example.com` for Self-host). Run `executor apps list` and set `APP_ID` to the exact ID of the app you want to edit. Use the full URL returned by `executor apps git --app "$APP_ID"` or shown under **Clone** with the `executor apps credential` helper (even when Cloud serves Git on a different origin than the sign-in host, the helper resolves your saved sign-in for that origin):
  ```bash
  CLONE_URL="$(executor apps git --app "$APP_ID")"
  git clone \
    -c credential.helper= \
    -c credential.helper='!executor apps credential' \
    -c credential.useHttpPath=true \
    "$CLONE_URL" \
    ./my-app
  cd ./my-app
  # Edit index.ts, then commit, push, and deploy:
  git add index.ts && git commit -m "Update tool"
  git push origin main
  executor apps deploy --app "$APP_ID" --commit "$(git rev-parse HEAD)"
  ```

- **Local:** use the Local Git path if you already have the server's API key. `executor apps credential` only supplies hosted sign-ins and does not authenticate against a Local server. Run `executor apps list`, set `APP_ID` to the exact ID of the app you want to edit, pass `-c credential.helper=`, and enter username `executor` and your Local API key as the Git password when prompted for clone and push (keep the API key out of the URL). After cloning, edit the files, commit, push `main` with the same authentication, and run `executor apps deploy` from the checkout. For automatic authentication, use **Download or commit snapshots without Git** below:
  ```bash
  CLONE_URL="$(executor apps git --app "$APP_ID")"
  git clone -c credential.helper= "$CLONE_URL" ./my-app
  cd ./my-app
  # Edit index.ts, then commit, push (entering username "executor" and your Local API key), and deploy:
  git add index.ts && git commit -m "Update tool"
  git push origin main
  executor apps deploy --app "$APP_ID" --commit "$(git rev-parse HEAD)"
  ```

### Download or commit snapshots without Git (Local, Self-host, Cloud)

Run `executor apps list` and set `APP_ID` to the exact ID of the app you want to edit. Download into a new or empty folder, copy `revision.commit` from the download output (using `jq` or manually), edit files, and commit against that expected SHA (or use `deploy --files` to save and deploy in one step):

```bash
BASE_COMMIT="$(executor apps source --app "$APP_ID" --out ./app-snapshot | jq -r .revision.commit)"
# Edit files inside ./app-snapshot, then save and deploy:
NEW_COMMIT="$(executor apps commit --app "$APP_ID" --files ./app-snapshot --expected "$BASE_COMMIT" --message "Update tool" | jq -r .revision.commit)"
executor apps deploy --app "$APP_ID" --commit "$NEW_COMMIT"

# Or save and deploy in one operation:
executor apps deploy --app "$APP_ID" --files ./app-snapshot --message "Deploy update"
```

## Example

On **Cloud**, run `executor apps login`. On **Self-host**, run `executor apps login --host https://executor.example.com` with your server's origin. Run `executor apps list` on that target and set `APP_ID` to the exact ID of the app you want to edit (for example, `APP_ID="$(executor apps list | jq -r '.[] | select(.name == "Hello") | .id')"`). Then clone the app over HTTP using the Executor credential helper, edit `index.ts`, push to `main`, and deploy the pushed commit:

```bash
CLONE_URL="$(executor apps git --app "$APP_ID")"

git clone \
  -c credential.helper= \
  -c credential.helper='!executor apps credential' \
  -c credential.useHttpPath=true \
  "$CLONE_URL" \
  ./app-checkout

cd ./app-checkout
# Configure Git identity if not already set globally:
# git config user.name "Your Name" && git config user.email "you@example.com"
# Edit index.ts, then commit and push to main:
git add index.ts
git commit -m "Add health check tool"
git push origin main

# Pushing updates working source only; deploy activates the new commit
executor apps deploy --app "$APP_ID" --commit "$(git rev-parse HEAD)"
```

## Limits

- **Push does not deploy:** pushing to `main` updates working source only. Run `executor apps deploy` or click **Deploy latest** on the **Source** tab to build and activate the new version.
- **Protected branches and refs:** deleting `main` is rejected (*"the app's main branch cannot be deleted"*). Pushing to `refs/heads/__executor/*` is rejected (*"Executor keeps this ref for retained versions"*).
- **Snapshot replacement on `commit`:** `executor apps commit --files <dir> --expected <sha>` replaces the entire working source with the contents of `<dir>` (files omitted from `<dir>` are deleted) and fails if `main` moved past `--expected`.
- **Target directory for `source --out`:** `executor apps source --out <dir>` requires `<dir>` to be absent or empty.
- **Oversized commits in the dashboard:** the **Source** viewer can return HTTP 413 if the selected commit exceeds repository source limits; inspect that commit with Git instead.

## Related

- [Add an app](/docs/apps/add)
- [Publish and install published apps](/docs/apps/publish)
- [Apps and versions](/docs/concepts/apps-and-versions)
- [Author an app](/docs/author-an-app)
- [Command line](/docs/run/cli)

Using Executor CLI 2.0.0-beta.79? For app management and Git, run `executor apps login`. For tool commands and MCP, run `executor login`. For Self-host, add `--host <your origin>` to the sign-in command.
