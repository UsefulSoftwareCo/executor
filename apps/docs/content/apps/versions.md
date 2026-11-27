---
title: Versions and deploying
description: "Deploy an app from the Source tab or CLI, inspect retained builds on the Versions tab, switch back to a previous version, and read commit history."
---

Every time you deploy an app, Executor builds its source into an immutable **version**. When a deployment becomes active, new calls use that version. Saving source edits or pushing Git commits never deploys automatically—you deploy explicitly from the **Source** tab (**Deploy latest**) or with `executor apps deploy`, inspect retained builds on the **Versions** tab, and view commit history on **Source** (**History**) or via `executor apps history`.

- **Available on:** Local, Self-host, and Cloud.
- **Required permissions and prerequisites:** On Self-host and Cloud, only the **app creator** and **organization admins** (`owner` or `admin`) can read **Source** and **Versions**. Deploying or activating a version also requires an editable app and app edit access. On Local, you can view and deploy any editable app. For Local CLI commands, clear any configured or remembered hosted target first; for Cloud or Self-host, sign in first with `executor apps login --host "$EXECUTOR_ORIGIN"` (`https://api.executor.sh` for Cloud, or your Self-host origin) and pass `--host "$EXECUTOR_ORIGIN"` to each command. Set `APP_ID` to the `id` of the app you intend to deploy, and prepare a complete app directory (`index.ts` plus `package.json` pinning `executor apps framework`) before running `--files`.
- **Main CLI command (Local):**

```bash
executor apps deploy --app "$APP_ID" --files ./my-app
```

You'll know it worked when the **Source** tab shows **Live · up to date** (or `executor apps deploy` returns JSON with `app.activeVersion` matching `version.id`), and the new version carries the **Active** badge on **Versions**. If you have app-use access, run a tool to confirm the new behavior.

## Deploying a new version

A failed build leaves the active version running. The error names the failing stage and includes source locations when available. When a deployment becomes active, new calls use that version while keeping the app's identity, stored SQL data, and compatible account links. If builds finish out of order, a slower build cannot replace a newer activation—compare `app.activeVersion` with `version.id` and run a tool to verify the change.

### From the dashboard (Local, Self-host, and Cloud)

1. Open the app and click the **Source** tab.
2. Check the live status in the header: **Not deployed**, **Live · up to date** (when the live commit matches the working head), or **Live `<sha>` · 1 newer commit not deployed** / **N newer commits not deployed** (or newer changes not deployed).
3. Click **Deploy latest** to build and activate the current commit on `main`. (When the latest saved commit is already live, the button is disabled with `"Your latest saved changes are already live."`.)

You'll know it worked when the status banner reads `"Deployed. New calls use this version."` and the **Versions** tab lists the new build as **Active**.

### From the CLI (`executor apps deploy`)

#### Local

With no configured or remembered hosted target, run `executor apps list` and set `APP_ID` to the `id` of the app you intend to deploy.

To save and deploy a local directory, prepare a complete app (root `index.ts` and `package.json` pinning the version from `executor apps framework`), then run:

```bash
executor apps deploy --app "$APP_ID" --files ./my-app --message "Add search filter"
```

To deploy a saved commit, copy its full 40-character `commit` SHA from the history of the same app:

```bash
executor apps history --app "$APP_ID" &&
  read -r -p "Commit SHA: " COMMIT_SHA &&
  executor apps deploy --app "$APP_ID" --commit "$COMMIT_SHA"
```

#### Cloud and Self-host

Set `EXECUTOR_ORIGIN` to `https://api.executor.sh` for Cloud or to your Self-host origin. Run `executor apps login --host "$EXECUTOR_ORIGIN"`. Choose the intended organization and authorize **Executor API**. In `2.0.0-beta.79`, app commands use this sign-in separately from `executor login`.

Run `executor apps list --host "$EXECUTOR_ORIGIN"` to find an app you can use. If you manage the app without use access, open **Apps → Filters → Manage apps**, open the app, and copy its ID from the dashboard URL. Set `APP_ID` to that ID before deploying.

```bash
read -r -p "App ID to deploy: " APP_ID
```

Choose one source. To save and deploy a local directory:

```bash
executor apps deploy --host "$EXECUTOR_ORIGIN" --app "$APP_ID" --files ./my-app --message "Release v2"
```

To deploy a saved commit, enter its full 40-character `commit` SHA from the history of that app:

```bash
executor apps history --host "$EXECUTOR_ORIGIN" --app "$APP_ID" &&
  read -r -p "Commit SHA: " COMMIT_SHA &&
  executor apps deploy --host "$EXECUTOR_ORIGIN" --app "$APP_ID" --commit "$COMMIT_SHA"
```

You'll know it worked when the command exits `0`, prints JSON where `app.activeVersion` equals `version.id`, and the version shows as **Active** on the **Versions** tab. If you have app-use access, run a tool to verify its behavior.

## Viewing versions and switching back

Open the **Versions** tab to see retained versions listed newest first (`Version N`, `Version N-1`, …) with timestamps and an **Active** badge on the running build. Selecting any version shows its **Deployed** timestamp, **Source** commit short SHA (seven characters in the cell with the full 40-character SHA in its title, or **Files** when a build has no source commit to redeploy), and a read-only file browser.

### Switching back on Cloud and Self-host

1. Open the **Versions** tab and select a previous version in the sidebar.
2. Click **Activate version** in the header.
3. In the **Activate this version?** dialog, review the warning (`"New calls will use this code. App data and changes made in other services will not be rolled back."`) and click **Activate version** to confirm.

The hosted activation dialog refuses a save if the current active version ID differs from the one it opened with (`expectedVersion`). Activation leaves stored SQL data and external changes in place.

You'll know it worked when the **Active** badge moves to the selected version and subsequent tool calls run its code.

### Switching back on Local

On Local, the **Versions** tab is read-only and does not render an **Activate version** button. To roll back on Local:

Choose the earlier commit from the app's history, then follow the saved-commit deployment steps under [Local](#local). If **Versions** shows **Files**, that build has no SHA to redeploy.

Redeploying an earlier commit on Local creates a new version, follows the normal build and migration validation checks, and leaves the newer working head in place.

You'll know it worked when `executor apps deploy` returns a new active version built from `"$COMMIT_SHA"` and calling a tool returns the earlier version's output.

## Viewing commit history (`executor apps history`)

To inspect recent commits in an app's private Git history:

- **In the dashboard (Local, Self-host, Cloud):** Open **History** from the recent-commit count in **Source** (for example, **1 recent commit** or **N recent commits**) to view commit messages, authors, and SHAs; click **Back to files** to return.
- **In the CLI:** Run:

```bash
executor apps history --app "$APP_ID"
```

Each entry contains `commit` (full 40-character SHA), `author`, `message`, and a Unix-seconds `timestamp`.

## Example

Create a Local app, deploy two versions, inspect commit history, roll back to the first commit, and verify the tool output returns `first` -> `second` -> `first` (with no hosted target selected):

```bash
mkdir -p ./hello-versions
FRAMEWORK_VERSION=$(executor apps framework | node -e 'const d = JSON.parse(require("node:fs").readFileSync(0, "utf8")); console.log(d.version);')

cat <<EOF > ./hello-versions/package.json
{
  "name": "hello-versions",
  "private": true,
  "dependencies": {
    "apps": "${FRAMEWORK_VERSION}"
  }
}
EOF

cat <<'EOF' > ./hello-versions/index.ts
import { defineApp, object, query, router } from "apps";
const greet = query({ input: object({}) }, async () => "first");
export default defineApp({}, { tools: router({ greet }) });
EOF

APP_ID=$(executor apps create --name "hello-versions" --files ./hello-versions | node -e 'const d = JSON.parse(require("node:fs").readFileSync(0, "utf8")); console.log(d.id);')
executor apps deploy --app "$APP_ID" --files ./hello-versions --message "v1"
executor call 'tools["hello-versions"].greet' --input '{}'

cat <<'EOF' > ./hello-versions/index.ts
import { defineApp, object, query, router } from "apps";
const greet = query({ input: object({}) }, async () => "second");
export default defineApp({}, { tools: router({ greet }) });
EOF

executor apps deploy --app "$APP_ID" --files ./hello-versions --message "v2"
executor call 'tools["hello-versions"].greet' --input '{}'

COMMIT_SHA=$(executor apps history --app "$APP_ID" | node -e 'const d = JSON.parse(require("node:fs").readFileSync(0, "utf8")); console.log(d.find((c) => c.message === "v1").commit);')
executor apps deploy --app "$APP_ID" --commit "$COMMIT_SHA"
executor call 'tools["hello-versions"].greet' --input '{}'
```

## Limits

- **Exactly one source flag:** `executor apps deploy` requires either `--commit` (full 40-character SHA) or `--files`, never both or neither.
- **Source size limits:** Source can contain up to 4,096 code files (outside `ui/public/`). Code and inline public bytes together can use up to 16 MiB. Each app-owned JavaScript or TypeScript file may be at most 2 MB (`2,000,000` bytes); imported npm package files, JSON files, and files under `ui/public/` are excluded.
- **Public asset limits (`ui/public/`):** Up to 10,000 files, 32 MB (`32,000,000` bytes) per file, and 1 GB (`1,000,000,000` bytes) total.
- **No automatic data rollback:** Activating or redeploying an earlier version changes only the running code—stored SQL data and external changes in third-party services are left in place.
- **Rediscover tools after deploy:** Run `search` again after deploying a new version to get the current paths and schemas.

## Related

- [Apps](/docs/apps)
- [Share and copy apps](/docs/apps/share-and-copy)
- [Apps and versions](/docs/concepts/apps-and-versions)
- [Author an app](/docs/author-an-app)
- [Tools tab](/docs/apps/tools)
