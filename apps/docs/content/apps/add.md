---
title: Add an app
description: "Add an app to Executor from the app catalog, from a remote MCP server URL, from scratch with your agent, or from local source files."
---

Executor gives you four ways to add an app: install an official app from **Browse app catalog**, wrap a remote MCP server with **From an MCP server**, build a custom app with **From scratch**, or upload source files with `executor apps create` and `executor apps deploy`. All four paths work on **Local**, **Self-host**, and **Cloud**.

**The step that matters most:** open **Apps** in the dashboard and click **Add app**, or run `executor apps create` followed by `executor apps deploy` from a terminal.

**Prerequisites:** a running Executor workspace (Local, Self-host, or Cloud) where you can create apps. For **From scratch**, connect your agent with **Full access** and choose **All apps** on the hosted MCP consent screen; on Cloud or Self-host, make sure the built-in **Executor** app has a linked account with permission to create and deploy apps (the default managed key is available to organization owners and admins; on Cloud, verify your email first). For CLI commands targeting Cloud or Self-host, sign in first with `executor apps login` (pass `--host <origin>` for Self-host); Local CLI commands use the background Executor only when no host is configured or remembered. The shell examples use `jq`—install it first, or copy the named fields from the JSON output.

**You'll know it worked when…** the new app appears on the **Apps** page with a live version, and its tools show up under the app's **Tools** tab and in MCP `search` (or `executor search greet` for the example below).

## How to use it

The dashboard **Add app** menu is the same on **Local**, **Self-host**, and **Cloud**, with minor account-setup routing differences noted below. The CLI path differs by host selection and authentication.

### 1. Browse app catalog

1. On the **Apps** page, click **Add app** -> **Browse app catalog**.
2. Filter with **Search apps…** and click **Add** on the app you want.
3. Executor installs an editable copy of that app's source into your workspace (the button changes to **Open** once installed).
4. If the app requires an account, follow account setup on **Local** or open the app's **Accounts** tab on **Self-host** and **Cloud** to connect it.

By default, the catalog loads from `EXECUTOR_CATALOG_URL` (`https://catalog.executor.sh/index.json`). On **Local** and **Self-host**, operators can point `EXECUTOR_CATALOG_URL` at another catalog or disable it with `EXECUTOR_CATALOG_URL=off`.

### 2. From an MCP server

1. Click **Add app** -> **From an MCP server** (*"Turn a remote MCP server into an app"*).
2. Enter **App name** and **MCP server URL**, then click **Add app**.
3. Executor checks the server (showing **Checking server…**) for anonymous access or supported OAuth.
4. If the server uses OAuth, follow account setup on **Local** or open **Accounts** on **Self-host** and **Cloud**. For an API key or other sign-in method, use the setup prompt with your agent.

### 3. From scratch with your agent

1. Connect your agent to the target workspace using **Full access** and choose **All apps** on the hosted MCP consent screen. On Cloud or Self-host, make sure the built-in **Executor** app has a linked account with permission to create and deploy apps. The default managed key is available to organization owners and admins. On Cloud, verify your email first.
2. Click **Add app** -> **From scratch** (*"Describe it and your agent builds it"*).
3. Enter what the app should do in **What should it do?** in the **Create from scratch** dialog.
4. Click **Copy prompt** and send it to your connected agent. The prompt directs it to the built-in [Executor app](/docs/apps/executor-app)'s `executor` and `app-authoring` skills to write and deploy the app.

### 4. From source with the CLI

The **Local** commands below target the background Executor when no `--host`, `EXECUTOR_HOST`, or remembered host is set. If you also use a hosted workspace, select your target host explicitly: for an explicit Local target, unset `EXECUTOR_ACCESS_TOKEN`, set `EXECUTOR_API_KEY` to that server's Local API key, and pass `--host http://127.0.0.1:4312` without `--organization`; for a hosted target, sign in first. The shell examples use `jq`; install it first, or copy the named fields from the JSON output.

1. **Authenticate (Cloud or Self-host) and check the framework version:**
   - **Local:** run `executor apps framework`.
   - **Cloud:** run `executor apps login`, then `executor apps framework`.
   - **Self-host:** run `executor apps login --host https://executor.example.com`, then `executor apps framework`.
2. **Create the app files:** save `hello/package.json` (using the `version` returned by `executor apps framework`) and `hello/index.ts` as shown in [Example](/docs/apps/add#example) below.
3. **Create and deploy the app:**
   - **Local:**
     ```bash
     APP_ID="$(executor apps create --name "Hello" --files ./hello | jq -r .id)"
     executor apps deploy --app "$APP_ID" --files ./hello
     executor search greet
     ```
   - **Cloud and Self-host:**
     ```bash
     APP_ID="$(executor apps create --name "Hello" --files ./hello | jq -r .id)"
     executor apps deploy --app "$APP_ID" --files ./hello
     ```

## Example

Run `executor apps framework` and read the JSON `version`. Save the two files below as `hello/package.json` (substituting that version into `dependencies.apps`) and `hello/index.ts`:

```json
{
  "name": "hello",
  "private": true,
  "type": "module",
  "dependencies": {
    "apps": "<framework-version>"
  }
}
```

```ts
import { defineApp, object, query, router, string } from "apps";

const Greet = object({ name: string().default("world") });

export default defineApp(
  {},
  {
    tools: router({
      greet: query(
        { description: "Greet someone by name", input: Greet },
        async (_ctx, { name }) => ({ message: `Hello, ${name}!` }),
      ),
    }),
  },
);
```

Run `executor apps create --name "Hello" --files ./hello`, copy the returned JSON `id` into `APP_ID`, and run `executor apps deploy --app "$APP_ID" --files ./hello`. On a fresh Local CLI, `executor search greet` returns `tools.hello.greet`.

## Limits

- **MCP server URL rules:** **From an MCP server** rejects URLs with userinfo (`user:pass@`), query strings, fragments (`#`), or brace placeholders (`{`, `}`), and rejects non-HTTP(S) schemes.
- **Catalog apps are independent copies:** installing from the catalog creates your own app source copy; you can edit it freely, and it does not auto-update when the catalog entry changes.
- **Published community apps:** to install an app published by another team on `executor.sh/apps`, use `executor apps install` (see [Publish and install published apps](/docs/apps/publish)).
- **Disabled catalog:** if `EXECUTOR_CATALOG_URL=off` is set on Local or Self-host, the catalog listing is unavailable.

## Related

- [Publish and install published apps](/docs/apps/publish)
- [App source and Git](/docs/apps/source-and-git)
- [Author an app](/docs/author-an-app)
- [Connect an account](/docs/connect-an-account)
- [The built-in Executor app](/docs/apps/executor-app)
