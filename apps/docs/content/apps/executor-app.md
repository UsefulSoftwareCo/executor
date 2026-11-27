---
title: The built-in Executor app
description: "Understand the built-in Executor app that ships in every workspace, including its management tools, skills, managed API key eligibility, and feedback.submit tool."
---

Every Executor workspace comes with a built-in app whose slug is `executor`. It wraps Executor's own management OpenAPI surface as MCP tools (apps, accounts, workflows, schedules, webhooks, skills, and `feedback.submit`), loads Executor's built-in skills (`executor`, `code-mode`, `app-authoring`) from `/.well-known/agent-skills/index.json`, and lets connected agents inspect and manage Executor itself. It ships on **Local**, **Self-host**, and **Cloud**.

**The step that matters most:** start any agent session by reading its entry skill with `skills({ app: "executor", name: "executor" })` (or `executor skills --app executor --name executor`), and discover management tool paths with `search({ namespace: "executor" })`.

**Prerequisites:** a running Local, Self-host, or Cloud workspace with an MCP client or the `executor` CLI. To read the entry skill or use the management tools, connect with access to the **Executor** app. On Cloud or Self-host, also link the app's required **Executor** account. Eligible owners and admins receive an automatic key as described below (on **Cloud**, a verified email is also required).

**You'll know it worked when…** `search({ namespace: "executor" })` returns management tools under `tools.executor.*` and `skills({ app: "executor" })` lists `executor`, `code-mode`, and `app-authoring`.

## How to use it

The app exposes management tools and skills on all targets, while authentication and available management operations differ between hosted targets and Local:

### Cloud and Self-host

- **Managed API key:** on Cloud and Self-host, Executor automatically creates and links a managed API key named `Executor app (created automatically)` for eligible organization owners and admins (on Cloud, verified email is also required; Self-host does not require email verification). The key is scoped to that user and organization and checked against their role. With that account linked on the default **Executor** app, Executor injects the organization header and path parameter default automatically so callers do not need to pass the organization ID manually.
- **Automatic key renewal:** after an upstream HTTP 401, Executor can replace a revoked managed API key if the account is still the caller's managed link on the default **Executor** app and the caller is still eligible. The failed tool call returns an `AppProviderFailed` error carrying `credentialsRenewed: true` if replacement succeeded. Review the failure before deciding whether to retry—Executor leaves the failed call for the caller to retry and never replays it automatically.
- **Tools available:** covers `apps`, `appAccounts`, `accounts`, `skills`, `tools`, `schedules`, `webhooks`, `workflows`, `appData`, `organization`, `groups`, `oauthClients`, `mcpConnections`, `toolCalls`, `context.get` (returns your current `organization`, `slug`, `role`, and `gitOrigins`), and `feedback.submit`.

### Local

- **Local API key link:** Local Executor installs the built-in app under its internal `executor-local` owner and links a local API key and `baseUrl` automatically so tools call the local management API without OAuth setup.
- **Tools available:** covers `apps`, `appAccounts`, `accounts`, `accountConnections`, `skills`, `tools`, `schedules`, `webhooks`, `appWorkflows`, `appWorkflowRuns`, `webhookLinks`, `appManagement` (`create`, `deploy`, `source`, `history`, `git`, `commit`, `copy`, `catalog`), `framework.release`, and `feedback.submit`. To install from the official catalog on Local, use **Add app** -> **Browse app catalog**. For an app published in the public registry, use `executor apps install` with the published package name and commit.

### Sending feedback with `feedback.submit`

`feedback.submit` sends your feedback text to Executor's product analytics pipeline and reports acceptance after ingestion. On Cloud, the event includes your user and organization IDs. Keep credentials, personal data, and private business data out of the message. The tool returns `FeedbackDisabled` when product analytics are off, or `FeedbackUnavailable` if ingestion fails.

## Example

On Local, use a CLI profile with no configured or remembered host. On Cloud, run `executor login`. On Self-host, run `executor login --host https://executor.example.com` with your server's origin. On Cloud or Self-host, make sure the **Executor** app's required account is linked first (see the prerequisites above). Then discover the built-in skills and management tools from your terminal:

```bash
executor skills --app executor --name executor
executor search --namespace executor
```

Inside MCP `execute` on **Cloud** or **Self-host** (using a connection that includes the **Executor** app as an eligible owner or admin, with verified email on Cloud; note that a Self-host catalog may be disabled with `EXECUTOR_CATALOG_URL=off`):

```js
const context = await tools.executor.context.get({});
const matches = await tools.executor.organization.catalog({
  query: { search: "gmail", limit: "20" },
});
return { organization: context.slug, role: context.role, matches };
```

## Limits

- **Managed key eligibility:** automatic provisioning and renewal of the managed API key apply only to organization owners and admins (with verified email required on Cloud).
- **No automatic replay on key renewal:** when a revoked managed API key is automatically renewed after an upstream 401 on Cloud or Self-host, the failed call returns `AppProviderFailed` with `credentialsRenewed: true` and is not replayed automatically because earlier steps may have had side effects.
- **Manual API keys are not auto-renewed:** if you linked a personal access token yourself, create its replacement on the **Tokens** page, then open the **Executor** app's **Accounts** tab and connect the replacement token for your organization.
- **Feedback requires analytics:** `feedback.submit` returns `FeedbackDisabled` when product analytics are disabled on Local or Self-host (for example with `DO_NOT_TRACK=1` or `EXECUTOR_DISABLE_ANALYTICS=1` set before startup), and `FeedbackUnavailable` if ingestion is unavailable.
- **Browser-only endpoints excluded from OAuth:** endpoints marked browser-session-only (such as `/api/viewer` and `/api/catalog`) are not callable with OAuth credentials; use `organization.catalog` for OAuth-accessible catalog lookups.

## Related

- [Skills](/docs/skills)
- [Add an app](/docs/apps/add)
- [Personal access tokens](/docs/api-keys)
- [Usage analytics](/docs/run/usage-analytics)
- [The MCP endpoint](/docs/mcp)

Using Executor CLI 2.0.0-beta.79? For app management and Git, run `executor apps login`. For tool commands and MCP, run `executor login`. For Self-host, add `--host <your origin>` to the sign-in command.
