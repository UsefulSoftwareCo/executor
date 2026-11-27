---
title: Author an app (moved)
description: "The app authoring guide has moved to Build an app and been split into focused pages."
noindex: true
---

This guide has moved to [Build an app](/docs/build) and is now organized into focused pages under **Build an app**. Every heading from the previous guide maps below.

## A first app

Start with the two-file starter (`index.ts` and `package.json`), `executor apps framework`, and `executor apps create` in [Build an app](/docs/build).

## Using an account

Define providers, `hosts`, `request` placements, `health` checks, and setup help in [Accounts and providers](/docs/build/accounts).

### App accounts

Learn how `user.accounts` and shared `app.accounts` work in [Accounts and providers](/docs/build/accounts).

## Queries and mutations

Declare `query`, `mutation`, typed schemas, nested routers, `dynamicRouter`, icons, and `ctx.cache` in [Tools, routers, and schemas](/docs/build/tools).

## Approvals

Declare per-tool approval rules (`always()`, `never()`, `Approval<Input>`, `withApproval`, `withApprovals`) in [Input prompts and tool approvals](/docs/build/input-and-approvals), and review browser and scheduled approvals on [Approvals](/docs/approvals).

## Schedules and webhooks

For schedule and webhook examples, read `workflows.md` and `webhooks.md` in the built-in `app-authoring` skill. Follow [Ship skills with an app](/docs/build/skills) to select the host and sign in for tool commands. On **Cloud** and **Self-host**, use a connection with access to the built-in Executor app and link its required account.

Read the files with `executor skills --app executor --name app-authoring --file workflows.md` and `executor skills --app executor --name app-authoring --file webhooks.md`.

See [Framework versions and upgrades](/docs/build/upgrades) for changes to schedule scope, [Accounts and providers](/docs/build/accounts) for account scope, and [Approvals](/docs/approvals) for pending scheduled runs.

## Asking for input mid-tool

Prompt users for structured form input with `ctx.elicit` in [Input prompts and tool approvals](/docs/build/input-and-approvals).

## Importing an existing service

Wrap remote MCP servers, OpenAPI documents, and GraphQL endpoints in [Import MCP, OpenAPI, and GraphQL](/docs/build/import).

## Storing data

Add numbered SQLite migrations in `migrations/` and run queries and transactions with `ctx.sql` in [App storage and SQLite](/docs/build/storage).

## Shipping instructions

Bundle `skills/<name>/SKILL.md`, load remote skills with `dynamicSkills`, and publish router instructions in [Ship skills with an app](/docs/build/skills).

## Deploying

Deploy with `executor apps deploy` or over MCP in [Build an app](/docs/build#deploying).

### Updating an existing app

Read working source, commit snapshots, push with Git, and deploy commits in [Build an app](/docs/build#updating-an-existing-app).

## Update a hosted app

Follow the app-management sign-in and deployment steps for [Cloud](/docs/build#cloud) or [Self-host](/docs/build#self-host).

## Open an app UI

Build a React UI with Tailwind CSS v4, serve `ui/public/`, and open the app in [App UI and static files](/docs/build/ui).

### Install as a desktop app

Install an app UI as a desktop window with `ui/icon.svg`, `ui/menubar.html`, shortcuts, and permissions in [Desktop apps](/docs/desktop-apps).

## What is coming later

See currently available capabilities in [Apps and versions](/docs/concepts/apps-and-versions) and [Tools and approvals](/docs/concepts/tools-and-approvals).
