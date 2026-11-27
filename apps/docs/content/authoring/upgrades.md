---
title: Framework versions and upgrades
description: "Pin dependencies.apps with executor apps framework, understand how hosts build pinned versions, and upgrade apps past 0.0.1-beta.38 and 0.0.1-beta.90."
slug: "/build/upgrades"
---

Declare `dependencies.apps` in `package.json`. Pin it to the exact version reported by your target host to keep rebuilds on that framework release. Check the version with `executor apps framework` or `tools.executor.framework.release` over MCP.

**The command that matters most:** run `executor apps framework` against your target host and copy its `version` (for example `0.0.1-beta.148`) verbatim into `dependencies.apps`.

**Prerequisites:** an existing app you can edit and deploy. See [Build an app](/docs/build) for host selection.

**You'll know it worked when…** `executor apps deploy` builds cleanly against the pinned version, activates it, and the app's tools run without protocol or declaration errors.

## How to use it

### 1. Check your host's `apps` version

Run `executor apps framework` against the app's actual host (`executor apps` chooses `--host`, then `EXECUTOR_HOST`, then the last host remembered by sign-in, then the **Local** background server):

- **Local:** run `executor apps framework` without an explicit or remembered hosted target to use the Local background server.
- **Cloud:** run `executor apps login` if you have not already, then `executor apps framework`.
- **Self-host:** run `executor apps login --host https://executor.example.com`, then `executor apps framework --host https://executor.example.com`.

When `dependencies.apps` matches the host's own exact version, the host supplies its bundled `apps` package directly during build. Otherwise the host installs the requested version from npm during build. Upgrading Executor does not rebuild already-deployed app versions; each deployed version stays on its build until you deploy again.

### 2. Upgrade across breaking framework changes

If you are updating an older app to your host's current `apps` version, check whether its previous `dependencies.apps` predates either breaking release below and apply every boundary the app crosses before deploying.

> **Note on built-in skill upgrade notes:** The historical notes in the built-in `app-authoring` skill (`upgrades/0.0.1-beta.90.md` and `upgrades/0.0.1-beta.38.md`) name those older release versions (`0.0.1-beta.90` and `0.0.1-beta.38`). When upgrading an app now, always pin `dependencies.apps` to the exact version reported by `executor apps framework` (or `tools.executor.framework.release` over MCP) instead.

#### Upgrading from before `0.0.1-beta.90` (account and schedule scopes)

1. Set `dependencies.apps` in `package.json` to the exact version printed by `executor apps framework`.
2. Move account requirements from `{ accounts: { github } }` to `{ user: { accounts: { github } } }` (or `{}` when an app has no accounts).
3. Update handlers from `ctx.accounts.github` to `ctx.user.accounts.github` (and workflow steps from `step.accounts` to `step.user.accounts`). Inside a `defineApp` factory, guard `ctx.user` before reading a single user account requirement, and use `ctx.user?.accounts.service ?? []` for a `.many()` requirement, because the factory also runs without a caller for app-scope work.
4. Scope webhook accounts from `account: "github"` to `account: { user: "github" }` (or `{ app: "service" }` for an app-scoped account).
5. Replace `cron` and `interval` with `userCron` and `userInterval` for per-member schedules, or `appCron` and `appInterval` for app-wide schedules. For an app-wide schedule with a context parameter, type it `MutationContext<typeof requirements, "app">` (or pass `"app"` as the third generic on explicit `mutation<Input, Output, "app">`). App-wide scheduled mutations cannot declare an `approval` rule. Before changing an existing schedule's scope, read "Choose each schedule's scope" in `upgrades/0.0.1-beta.90.md` with `executor skills --app executor --name app-authoring --file upgrades/0.0.1-beta.90.md`. On Cloud and Self-host, use a tool connection that can read the built-in Executor app and link its required account first. Use the framework pin reported by your host, not the one in that note.
6. To use a shared account, declare it under `app.accounts` and read it from `ctx.app.accounts`. On **Cloud** and **Self-host**, changing a requirement from user scope to app scope does not migrate personal links. After deploying, an app manager can link the account for everyone on the app's **Accounts** tab.

#### Upgrading from before `0.0.1-beta.38` (document database to SQLite)

1. Set `dependencies.apps` in `package.json` to the exact version printed by `executor apps framework`.
2. Remove `database: defineDatabase(...)` from requirements and drop `defineDatabase`, `table`, `id`, and `userId` imports.
3. Add `migrations/0001_init.sql` creating your tables and copying any existing rows from the `_executor_legacy_rows (table_name, id, body)` view using `json_extract(body, '$.field')`. During SQL deployment, Executor exposes legacy document rows through `_executor_legacy_rows` (empty for fresh app storage) and leaves `app_rows` alone, so the same migration works for both upgraded and newly copied apps.
4. Rewrite `ctx.db` calls to synchronous `ctx.sql.exec(...)` and `ctx.sql.transaction(...)` (see [App storage and SQLite](/docs/build/storage)). Drop `await` on SQL statements, alias snake_case columns if callers expect camelCase, and ensure workflow step mutations put their writes in a single `ctx.sql.transaction(...)`.

## Example

Check the host's version, then use these files to update a GitHub app from pre-`beta.90` account requirements.

```bash
executor apps framework
# { "version": "0.0.1-beta.148" }
```

```json package.json
{
  "name": "github-issues-app",
  "private": true,
  "dependencies": {
    "apps": "0.0.1-beta.148"
  }
}
```

```ts provider.ts
import { bearer, defineProvider, object, secrets, string } from "apps";

export const github = defineProvider({
  name: "GitHub",
  hosts: ["api.github.com"],
  auth: {
    token: secrets({
      label: "Personal access token",
      fields: object({ token: string() }),
      request: ({ token }) => [bearer(token)],
    }),
  },
});
```

```ts index.ts
import { defineApp, object, query, router, string, type QueryContext } from "apps";
import { github } from "./provider.ts";

const requirements = { user: { accounts: { github } } };

const whoami = query(
  {
    description: "Return the connected GitHub account ID",
    input: object({}),
    output: object({ accountId: string() }),
  },
  async ({ user }: QueryContext<typeof requirements>) => ({
    accountId: user.accounts.github.id,
  }),
);

export default defineApp(requirements, { tools: router({ whoami }) });
```

From the app directory, deploy against your existing app ID:

```bash
executor apps deploy --app "$APP_ID" --files .
```

After deploying, run `whoami` with a previously linked GitHub account and check that it returns an `accountId`.

## Limits

- **Pinning `dependencies.apps`:** declare the exact version printed by `executor apps framework` to keep rebuilds on that release. Omitting `dependencies.apps` fails the build; a version range can resolve to a different published framework version.
- **No automatic migration of running versions:** upgrading your CLI or Executor server does not rebuild already-deployed app versions. Each app stays on its deployed build until you deploy again, though later SQL migrations are not rolled back for old code.
- **Protocol drift on very old pins:** an app pinned to a much older `apps` version can fail with host protocol errors or spend extra work listing large APIs; bump `dependencies.apps` to `executor apps framework` and redeploy.

## Related

- [Build an app](/docs/build)
- [Accounts and providers](/docs/build/accounts)
- [App storage and SQLite](/docs/build/storage)
- [Apps and versions](/docs/concepts/apps-and-versions)
