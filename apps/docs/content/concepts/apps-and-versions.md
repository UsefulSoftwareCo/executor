---
title: Apps and versions
description: "An app owns its source and data. A version is an immutable, retained build of its code."
---

## App

An **app** has a name, an owner, Git source and its stored data. It can have
source before it is deployed. Once deployed, it also points to the version it
currently runs.

**Make a copy** creates a new app with its own source and fresh Git history.
It does not copy connected accounts or app data. A running app is copied from
its deployed source, even when its working files have newer changes. The copy
deploys automatically. An unfinished app copies its working files and stays
undeployed.

Each copy records the original app or public package and source commit. That
record does not connect their updates. Changing or deleting the original does
not change the copy.

Each app has a slug. That slug is the namespace an agent uses:
`tools.<app-slug>.<name>`.

## Accounts

Each person links their own accounts to an app, and every call runs with the
accounts that person linked: one for each single-account requirement, and all of
them for a `.many()` requirement. Calls never choose accounts. To use your work
and personal Vercel accounts side by side, copy the app and link one to each.
An app can also require accounts of its own, which people who can edit it link
for everyone. See [Providers and accounts](/concepts/providers-and-accounts).

Managing an app does not grant use of somebody else's accounts. Every caller
runs the app's active version and shares the app's stored data.

## Version

A **version** is one immutable snapshot of an app's source and build. A build
must succeed before it becomes the running version. Earlier versions remain
available for rollback. Rollback changes the running code; it does not rewind
app data or external actions.

Source edits and Git pushes do not deploy automatically. An agent reads working
source, commits changes against that revision, then deploys the saved commit.
Deploying accepts complete files or an existing Git commit. It does not edit Git.
The newest successful version becomes active.

## Public apps

**Publish** shares a chosen source snapshot independently of the running app.
`package.json` supplies the public name and description. Publication shares
source files, not private Git history, connected accounts, credentials, or app
data.

A public package has one current published revision. Republishing replaces that
listing; there is no public version catalog. Making a copy uses the exact
published revision you reviewed and creates a normal, independently owned app.
Republishing or unpublishing the original does not update or revoke your copy.

### Publish to another host

Sign in to the destination with your own account, then copy a selected source
commit and publish it there:

```sh
executor apps login --host https://api.executor.sh
executor apps publish --host <source-host> --app <source-app> --commit <source-commit> \
  --registry https://api.executor.sh --package @<destination-scope>/<app>
```

The destination uses its saved sign-in. `EXECUTOR_API_KEY`,
`EXECUTOR_ACCESS_TOKEN` and `--organization` apply to the source host.
The package name changes only in the copy. Review the selected source before
publishing: its files become public. Git history, accounts and app data stay on
the source host, and the destination app stays undeployed.

If publication fails after creating the copy, the CLI prints its app ID. Add
`--registry-app <destination-app>` to reuse that app on retry or for an update.
This replaces its working files with the selected source; its running version,
accounts and data stay as they were. Use a destination app you own and intend
to publish. The host still checks publishing rights and the package scope.
Only Cloud supports publication; self-hosted instances can supply source and
keep a copy, but refuse to publish it.

## Getting an app

- **From a public listing.** Make your own copy, then link its accounts.
- **From the catalog.** Add an MCP server that needs no sign-in or supports OAuth.
  For any other service, copy the setup prompt and your agent writes the app.
- **From a URL.** Add an MCP server by URL, with the same check.
- **From source.** Write TypeScript and deploy it. See [Author an app](/author-an-app).

After deploying or changing account links, discover tools again in a new
`execute` call.

## What is coming later

- Automatic updates from another app or public package.
