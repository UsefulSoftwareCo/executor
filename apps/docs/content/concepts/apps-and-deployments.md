---
title: Apps and deployments
description: "An app owns its source, account selections and data. A deployment is an immutable, retained version of its code."
---

## App

An **app** has a name, an owner, Git source, and its selected accounts. It can
have source before it is deployed. Once deployed, it also points to the version
it currently runs.

You can make independent copies for different accounts:

- "Work Vercel", selecting your work Vercel account.
- "Personal Vercel", selecting your personal one.

**Make a copy** creates a new app with its own source and fresh Git history.
It does not copy connected accounts or app data. A running app is copied from
its deployed source, even when its working files have newer changes. The copy
deploys automatically. An unfinished app copies its working files and stays
undeployed.

Each copy records the original app or public package and source commit. That
record does not connect their updates. Changing or deleting the original does
not change the copy.

Each app has a slug. That slug is the namespace an agent uses:
`tools.<app-slug>.queries.<name>`.

## Deployment

A **deployment** is one immutable version of an app's source and build. A build
must succeed before it becomes the running version. Earlier deployments remain
available for rollback. Rollback changes the running code; it does not rewind
app data or external actions.

Source edits and Git pushes do not deploy automatically. An agent reads working
source, commits changes against that revision, then deploys the saved commit.
Deployment accepts complete files or an existing Git commit. It does not edit Git.
The newest successful deployment becomes active.

## Public apps

**Publish** shares a chosen source snapshot independently of the running app.
`package.json` supplies the public name and description. Publication shares
source files, not private Git history, connected accounts, credentials, or app
data.

A public package has one current published revision. Republishing replaces that
listing; there is no public version catalog. Making a copy uses the exact
published revision you reviewed and creates a normal, independently owned app.
Republishing or unpublishing the original does not update or revoke your copy.

## Getting an app

- **From a public listing.** Make your own copy, then select its accounts.
- **From the catalog.** Add an MCP server that needs no sign-in or supports OAuth.
  For any other service, copy the setup prompt and your agent writes the app.
- **From a URL.** Add an MCP server by URL, with the same check.
- **From source.** Write TypeScript and deploy it. See [Author an app](/build/author-an-app).

After deploying or changing account selections, discover tools again in a new
`execute` call.

## What is coming later

- Automatic updates from another app or public package.
- Imports between Executor app packages.
- Stored-data schema migration between deployments.
