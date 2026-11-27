---
title: Apps and versions
description: "An app owns its source and data. A version is an immutable, retained build of its code."
---

An **app** owns its name, owner, Git source, and stored data; a **version** is one immutable, retained build of its code. Apps, versions, copies, and catalog installation work on **Local**, **Self-host**, and **Cloud**; public publishing is available on **Cloud**.

To get started, open **Add app → Browse app catalog** and click **Add** beside a catalog app to install an independent copy and deploy it, then connect any required accounts.

## App

An **app** has a name, an owner, Git source, and its stored data. It can have source before it is deployed. Once deployed, it also points to the version it currently runs.

**Make a copy** starts a separate app with its own code and data identity and fresh Git history, from the active version's source or (for a never-deployed app) its saved working source. Account links, live app data, and original Git history stay behind. A deployed parent's copy deploys automatically. An undeployed parent's copy stays undeployed. On Cloud and Self-host, copying an existing app requires manage access to its source. Using the hosted app-management route also requires a manage-capable grant with an all-apps policy.

Each copy records the original app or public package and source commit. That record does not connect their updates: changing, republishing, or deleting the original does not change existing copies.

Each app has a slug. That slug is the namespace an agent uses: `tools.<app-slug>.<name>`.

## Accounts

Each person links their own accounts to an app, and user calls run with the accounts that person linked: one for each single-account requirement, and all of them for a `.many()` requirement. Calls never choose accounts. To use your work and personal Vercel accounts side by side, copy the app and link one to each. An app can also require accounts of its own, which people who can edit it link for everyone. See [Providers and accounts](/docs/concepts/providers-and-accounts).

Managing an app does not grant use of somebody else's personal accounts. Ordinary new calls run the app's active version and share the app's stored data.

## Version

A **version** is one immutable snapshot of an app's source and build. A build must succeed before it becomes the running version.

Git edits alone do not deploy. Deploy a saved commit, or submit a full file set (which saves a new commit and deploys it). Activation preserves ordering for concurrent deploys, and earlier retained versions stay available in the versions list so you can roll back the running code. Rollback changes the active code; it preserves app data and cannot undo external actions. Existing paused approvals, runs, or background contexts can remain pinned to their saved version.

## Public apps (Cloud)

On **Cloud**, an organization owner or admin with edit access to an app can **Publish** a chosen Git commit independently of the running app. The public listing exposes the selected commit's files, package name and description (from `package.json`), commit ID, and publication date.

Cloud publication leaves connected account records, private Git history, and live app data behind (and blocks paths such as `.env`, `.env.*`, and `.npmrc`). However, credentials or private data written into included source files become public — review the source you select before publishing.

A public package has one current published revision. Republishing replaces that listing; there is no public version catalog. Making a copy uses the published revision you reviewed and creates a normal, independently owned app. Existing copies keep their source after a listing is updated or removed.

## Getting an app

- **From the catalog:** On **Local**, **Self-host**, or **Cloud**, open **Add app → Browse app catalog** and click **Add** beside a catalog app to install an independent copy and deploy it, then connect any required accounts.
- **From an MCP server:** Choose **Add app → From an MCP server** to import a remote MCP server by URL.
- **From a public listing:** Install using the listing's package name and exact current commit. Through hosted app management, authorize write access with an all-apps policy. Link the required accounts on your copy.
- **From source:** Write TypeScript and deploy it. See [Author an app](/docs/author-an-app).

After deploying or changing account links, discover tools again in a new `execute` call.

## What is coming later

- Automatic updates from another app or public package.

## Related

- [Author an app](/docs/author-an-app)
- [Tools and approvals](/docs/concepts/tools-and-approvals)
- [Providers and accounts](/docs/concepts/providers-and-accounts)
- [Organizations and access](/docs/concepts/organizations-and-access)
- [How Executor protects credentials](/docs/security/credentials)
