---
title: Quickstart
description: "Start Executor on Cloud, Self-host, or Local, connect an MCP client to the MCP endpoint, connect an account, and run your first tool."
---

Executor stores credentials for the accounts you connect. Your assistant uses those accounts through app tools at one MCP endpoint. This guide covers the first-run path for **Cloud** (`https://app.executor.sh` dashboard, `https://mcp.executor.sh/mcp` MCP endpoint), **Local** (`npm i -g executor@beta`, `http://127.0.0.1:4312/mcp` MCP endpoint), and **Self-host** (`<your Executor origin>/mcp`). For deployment, see [Self-host Executor](/docs/run/self-host). On CLI 2.0.0-beta.79, run `executor apps login --host <your origin>` for app management and Git, or `executor login --host <your origin>` for tool commands and MCP.

**The step that matters most:** point your MCP client at the real MCP endpoint—`https://mcp.executor.sh/mcp` on Cloud (not `https://app.executor.sh/mcp`, which returns 404), `<your Executor origin>/mcp` on Self-host, or `http://127.0.0.1:4312/mcp` locally.

**Prerequisites:** an AI assistant that supports MCP (such as Claude, ChatGPT, Claude Code, Codex, or Cursor). For Local with npm, Node.js 14.18.0 or newer is required (the launcher downloads the native release on first run); the standalone installers run without Node.js. On Linux, use a glibc distribution with system CA certificates installed.

**You'll know it worked when…** your assistant finds and runs a read-only tool from the service you connected. You can also read the Executor entry skill (`skills({ app: "executor", name: "executor" })`) if your connection includes the Executor app and, on Cloud or Self-host, you have the [required account linked](/docs/apps/executor-app#cloud-and-self-host). The Local CLI check below (`executor search --namespace executor`) verifies discovery of the built-in Executor app.

## Quickstart on Executor Cloud

1. **Sign up and create your organization.** Open [app.executor.sh](https://app.executor.sh), sign in, and finish **Create your team**. Executor creates your organization with the built-in **Executor** app already installed.
2. **Connect your assistant.** On **Connect your assistant**, pick your assistant for guided instructions, or add the remote MCP server manually under **Add the MCP server**:
   ```text
   https://mcp.executor.sh/mcp
   ```
   Complete the OAuth sign-in in your browser and approve access on the consent page.
3. **Connect your accounts.** Return to **Connect your assistant** and select **Next: connect accounts**. On **Connect your accounts**, connect a service and continue. After initial setup, add services from **Apps** -> **Add app** -> **Browse app catalog** or **From an MCP server**. If an app needs an account, open its **Accounts** tab, select **Connect new account** under the provider, and follow the dialog. Enter required credentials in the connection dialog or sign in on the provider's page—keep credentials out of chat.
4. **Send a first prompt.** Ask your assistant to search for a read-only tool from your connected service and run it to verify account access.

## Quickstart on Local

1. **Install the Executor 2 beta CLI.** Run the `@beta` tag—a bare `npm i -g executor` installs Executor 1, which does not include apps:
   ```bash
   npm i -g executor@beta
   executor --version
   ```
   Confirm `executor --version` prints a `2.0.0-beta.*` version. Without Node.js, install with the shell script on macOS/Linux (`curl -fsSL https://executor.sh/docs/install.sh | sh`), PowerShell on Windows (`irm https://executor.sh/docs/install.ps1 | iex`), or Homebrew (`brew install usefulsoftwareco/tap/executor-beta`). Follow any `PATH` instructions the installer prints and open a new terminal. You can also install the [Executor desktop app](/docs/desktop) from [executor.sh/#install](https://executor.sh/#install) and click **Run locally**.
2. **Start Executor.** Run:
   ```bash
   executor
   ```
   This starts the local background server and opens the local dashboard in your browser (if the browser does not open, open the one-use connection link that `executor` prints within five minutes). On first launch, allow access if your OS asks. A new data directory tries the OS credential store (macOS Keychain, Windows Credential Manager, or Linux Secret Service). File mode, or an absent store with no forced OS mode, saves the keys in `keys.json` (`0600` on POSIX). A denied or locked store can stop startup—unlock the store or allow access, then start again. Initialized directories keep their key source.
3. **Connect your MCP client.** On the same computer, add `http://127.0.0.1:4312/mcp` to a streamable HTTP client that supports OAuth and complete authorization in your paired dashboard (open **Connections** -> **Full access** -> **Connect** for client-specific instructions). If your client starts a command over stdio, run this from a local CLI with no saved hosted sign-in or host override:
   ```bash
   claude mcp add executor -- executor mcp
   ```
4. **Add an app and connect an account.** In the local dashboard, open **Apps** -> **Add app**, install an app from **Browse app catalog** or **From an MCP server**, and—if the app needs an account—open its **Accounts** tab and select **Connect new account** under the provider.
5. **Verify from your shell or assistant.** Run this Local CLI check to verify discovery of the built-in Executor app, and ask your assistant to search for and run a read-only tool from the service you connected to confirm account access:
   ```bash
   executor search --namespace executor
   ```

## Quickstart on Self-host

After deploying your server (see [Self-host Executor](/docs/run/self-host)), open your organization in the dashboard, go to **Connections** -> **Full access** -> **Connect**, add `<your Executor origin>/mcp` to your MCP client, and approve access in the browser. Connect an account for the service you want to use, then ask your assistant to find and run a read-only tool from that service.

Using Executor CLI 2.0.0-beta.79? For app management and Git, run `executor apps login --host <your origin>`. For tool commands and MCP, run `executor login --host <your origin>`.

## Example

Once an MCP client is connected, an agent discovers and runs tools with `skills`, `search`, `describe`, `call`, and `execute`. Automatic, Through your agent, and In your browser also expose `resume` for paused calls. Native handles forms in the open request. These MCP `tools/call` examples read the entry skill when the Executor app and its required account are available, then search for tools.

```json
{
  "name": "skills",
  "arguments": {
    "app": "executor",
    "name": "executor"
  }
}
```

```json
{
  "name": "search",
  "arguments": {
    "query": "catalog"
  }
}
```

## Limits

- **Cloud MCP URL vs dashboard URL:** `https://app.executor.sh` is the dashboard; the Cloud MCP endpoint is `https://mcp.executor.sh/mcp`. Pointing an MCP client at `https://app.executor.sh/mcp` returns HTTP 404.
- **Local loopback boundary:** `http://127.0.0.1:4312/mcp` is reachable only from clients on the same computer and requires browser OAuth authorization or the local API key.
- **npm dist-tag:** installing `executor` without `@beta` installs v1 (`1.x`), which lacks Executor 2 apps, workflows, schedules, and webhooks. If `executor --version` still prints `1.x`, check `type -a executor` (macOS/Linux) or `where.exe executor` (Windows) for an older global install.
- **Local port:** Local Executor defaults to `127.0.0.1:4312`. To change it from the CLI, run `executor service set port <port>`, then `executor service start`, and update the port in your client's MCP URL. In desktop, change it in **File** -> **Server port…**.
- **Self-host URL:** Self-hosted instances serve MCP at `<your Executor origin>/mcp`.

## Related

- [Connect an account](/docs/connect-an-account)
- [Add an app](/docs/apps/add)
- [Add an MCP client](/docs/mcp-clients)
- [Executor desktop app](/docs/desktop)
- [The MCP endpoint](/docs/mcp)
- [Command line](/docs/run/cli)
- [Self-host Executor](/docs/run/self-host)

Using Executor CLI 2.0.0-beta.79? For app management and Git, run `executor apps login`. For tool commands and MCP, run `executor login`. For Self-host, add `--host <your origin>` to the sign-in command.
