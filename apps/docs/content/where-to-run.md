---
title: Where to run Executor
description: "Compare Executor Cloud, the Executor desktop app, the local CLI, and self-hosted Executor side by side to pick the right deployment target."
---

Executor runs the same apps and exposes a `/mcp` endpoint in four ways: **Executor Cloud** (`https://app.executor.sh`), the **Executor desktop app** (macOS, Windows, and Linux), the **local CLI** (`executor`), and **self-hosted Executor** on your own infrastructure. Choose **Cloud** for a hosted team workspace with nothing to deploy, **Desktop** or **CLI** to keep workspace data on your own machine, or **Self-host** to run a multi-user container with a persistent data volume.

Every target is available in the current release (`executor@2.0.0-beta.79` for CLI, desktop, and self-host, and live Executor Cloud). On a fresh CLI with no host selected or remembered, run `executor search apps` to start Local and return tool search results:

```bash
executor search apps
```

After signing in for hosted tool commands (`executor login` for Cloud, or `executor login --host "$EXECUTOR_ORIGIN"` for Self-host), run `executor whoami` to confirm the host and organization—a default Cloud sign-in reports `https://api.executor.sh` as `host` and `https://mcp.executor.sh/mcp` as `mcp`.

## Feature comparison by target

| Capability | Cloud (`app.executor.sh`) | Desktop app | Local CLI (`executor`) | Self-host |
| --- | --- | --- | --- | --- |
| **Setup** | Sign in at `app.executor.sh` | Install desktop app; choose **Run locally**, **Sign in** (Cloud), or **Customize** → **Sign in to this server** (Self-host) | `npm i -g executor@2.0.0-beta.79` | Docker container with persistent data volume (embedded PGlite) |
| **MCP endpoint** | `https://mcp.executor.sh/mcp` | `http://127.0.0.1:4312/mcp` (default local port) or the connected hosted server's MCP URL | `http://127.0.0.1:4312/mcp` (default port) | `<your origin>/mcp` |
| **Users and organizations** | Multi-user organizations, roles (`owner`, `admin`, `member`), groups | Single local user (or connects to Cloud or Self-host orgs when signed in) | Single local user | Multi-user organizations, roles (`owner`, `admin`, `member`), groups |
| **App access sharing** | **Only me**, **Selected groups**, **Everyone in the organization** | Local only in **Run locally** mode; follows the server in hosted mode | Local only (single user) | **Only me**, **Selected groups**, **Everyone in the organization** |
| **Where accounts and data live** | Managed by Executor Cloud (encrypted account records in product PostgreSQL) | In **Run locally** mode, under `EXECUTOR_DATA_DIR` (account fields in `executor.pglite`, source/runtime data in separate dirs; shares `~/.executor/v2/cli` by default). New dirs try the OS credential store, falling back to `keys.json` (POSIX `0600`) when absent or `EXECUTOR_KEY_STORAGE=file` | Same local server storage and key behavior as Desktop **Run locally** | On your infrastructure in the mounted volume (`/app/data/product`, embedded PGlite; `EXECUTOR_ENCRYPTION_KEY` or generated `encryption.key`, POSIX `0600`) |
| **Sign-in and SSO** | Email or OAuth; Enterprise adds SAML and OIDC SSO | Local mode uses local API key or local OAuth; hosted mode uses the server's sign-in | Background local server needs no sign-in (naming a Local origin requires auth); `executor login` for Cloud or `executor login --host "$EXECUTOR_ORIGIN"` for Self-host | Email/password; optional OIDC SSO via `SSO_DISCOVERY_URL` |
| **Scoped connections** | Yes, plus **Connected agents** list and revocation | Yes (no **Connected agents** list in local mode) | Yes via local dashboard (no **Connected agents** list) | Yes, plus **Connected agents** list and revocation |
| **MCP events (`events/subscribe`)** | Yes (webhook delivery) | Yes (webhook delivery) | Yes (webhook delivery) | Yes (webhook delivery) |
| **Switch active version in UI** | Yes (**Activate version** on **Versions** tab) | Local mode: view versions only; deploy an older commit via CLI | Deploy an older commit via `executor apps deploy --commit` | Yes (**Activate version** on **Versions** tab) |
| **Install apps as desktop apps** | Yes, via the Executor desktop app (requires an active deployed version with a UI) | Yes (**Install as app** when the active version has a UI; macOS and Windows add OS launchers) | Requires the Executor desktop app and an active deployed UI | Yes, via the Executor desktop app when app pages are enabled and the active version has a UI |
| **App publishing** | Yes (owners and admins with app edit access) | Only in a Cloud workspace (owners and admins with app edit access) | Only when targeting Cloud (owners and admins with app edit access) | No (install published apps with the required access) |
| **Plans and billing** | Free (up to 3 members), Team ([$15/active member/month](https://executor.sh/pricing) with verified domains; 14-day card-required trial when offered), Enterprise (adds SSO; contact sales) | Free | Free | Self-managed (no Cloud billing) |
| **Tracing and usage analytics** | Cloud operational tracing/logs and product analytics | Bundled local collector / optional OTLP export; product analytics configurable separately | Bundled local collector / optional OTLP export; product analytics configurable separately | Bundled collector / optional OTLP export; product analytics configurable separately |

## Choosing a target

### Cloud

Use **Executor Cloud** when a team wants shared apps, group-based access, browser approvals, and OAuth without running servers. Sign in at `https://app.executor.sh`, create or join an organization, and connect MCP clients to `https://mcp.executor.sh/mcp`.

Executor Cloud Free supports up to three organization members. Team costs [$15 per active member per month](https://executor.sh/pricing) and includes verified domains. A 14-day, card-required trial is available when offered. Enterprise includes Team features and adds SAML and OIDC single sign-on. Enterprise owners and admins configure **Single sign-on** in **Settings** using a verified domain. Contact sales for Enterprise pricing. In a Cloud workspace, organization owners and admins with app edit access can publish apps.

You'll know it worked when your organization dashboard opens at `https://app.executor.sh/org/<your-slug>/apps` and `executor whoami` reports `https://api.executor.sh` as `host` and `https://mcp.executor.sh/mcp` as `mcp` after `executor login`.

### Desktop app

Use the **Executor desktop app** when you want a local dashboard without managing terminal processes, or when you want to install deployed Executor apps with an active UI (`ui/index.html`) into standalone desktop windows. On first launch:

- Choose **Run locally** to start the local server on `http://127.0.0.1:4312` (default port) and store workspace data on your computer. Executor uses the OS credential store where available; on a fresh directory without a supported store, it can keep its keys in `keys.json` (POSIX `0600`). Set `EXECUTOR_KEY_STORAGE=file` before first start to select `keys.json` explicitly. A denied or locked store can stop startup.
- Choose **Sign in** for Executor Cloud, or choose **Customize** and **Sign in to this server** for Self-host. Desktop uses Electron safe storage for hosted refresh tokens (with a warned Linux `basic_text` fallback or sign-in refusal if storage fails).

macOS and Windows create individual OS launchers and support browser handoff. Available desktop capabilities depend on the OS; Windows and macOS 13+ support system audio capture. On Linux (x64 and arm64 AppImages), apps open inside the desktop dashboard without individual OS launchers, browser handoff, or system audio capture.

You'll know it worked when the desktop window lists your apps and **Connections** displays the local or hosted MCP URL.

### Local CLI

Use the **local CLI** (`executor@2.0.0-beta.79`) when you work from a terminal, script tool calls, or run `executor mcp` as a stdio bridge for an agent. The local CLI uses the same kind of local server and storage as Desktop **Run locally**.

The CLI resolves its target host in this order:

1. `--host <origin>` on the command.
2. The `EXECUTOR_HOST` environment variable.
3. The last host you signed in to with `executor login` or `executor apps login`.
4. Local, using the background server by default at `http://127.0.0.1:4312`.

The CLI uses the service’s registered credential by default. A supplied `EXECUTOR_API_KEY` takes precedence. Explicitly targeting a Local origin requires authentication. If the background service is disabled, the CLI starts a temporary Local server instead.

With no `--host`, `EXECUTOR_HOST`, or remembered hosted target set, you'll know it worked when `executor search apps` returns JSON tool results from the local server.

### Self-host

Run **self-hosted Executor** with the Executor container and a persistent data volume when your organization wants to run its own multi-user server. Executor stores its product database in embedded PGlite (`/app/data/product` in the released Docker image) and keeps app source, runtime data, and configured credentials on your infrastructure. The server can make outbound requests for features such as browsing the public app catalog and calling tools. See [Self-host](/docs/run/self-host) for volume and public URL settings.

Self-host supports email/password sign-in and optional OIDC single sign-on via `SSO_DISCOVERY_URL`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, and `SSO_ALLOWED_DOMAINS` (HTTPS discovery only, no redirects). Self-host retains up to 512 MCP clients total and 256 per user by default, including API keys and OAuth grants, and can evict idle clients; configure these caps with `EXECUTOR_MCP_CLIENTS` and `EXECUTOR_MCP_CLIENTS_PER_USER`. Local and Self-host support installing the current published listing by package name and exact commit. On Self-host, installation requires app-management write access with an all-apps policy.

You'll know it worked when `<your origin>` serves the dashboard and `<your origin>/mcp` accepts OAuth sign-in from an MCP client.

## Example

Start Local and search tools on a fresh CLI with no hosted target selected:

```bash
executor search apps
```

Sign in to a hosted server (replace `EXECUTOR_ORIGIN` with `https://api.executor.sh` for Cloud or your Self-host origin) and verify the active target:

```bash
EXECUTOR_ORIGIN="https://executor.example.com"

# Sign in for tool commands and MCP, then confirm host and organization
executor login --host "$EXECUTOR_ORIGIN"
executor whoami --host "$EXECUTOR_ORIGIN"

# Sign in separately for `executor apps` commands in beta.79
executor apps login --host "$EXECUTOR_ORIGIN"
```

## Limits

- **Single user on local:** The local server (used by the CLI and desktop **Run locally** mode) has no organizations, groups, **App access** sharing, or **Connected agents** list.
- **Separate CLI sign-ins in beta.79:** On Cloud and Self-host, `executor login` authorizes tool commands (`search`, `describe`, `call`, `execute`, `resume`, `skills`) and `executor mcp`, while `executor apps login` authorizes `executor apps` commands. `executor logout` clears both for a host.
- **Publishing is Cloud-only:** Only Cloud organization owners and admins with app edit access can publish apps.
- **Version activation UI on local:** The local dashboard's **Versions** tab displays previous versions read-only; redeploy an earlier commit using `executor apps deploy --app "$APP_ID" --commit "$COMMIT_SHA"`.
- **Linux desktop differences:** Linux AppImages omit individual OS launchers, browser handoff, and system audio capture.
- **Self-host SSO protocol:** Self-host configures OIDC via `SSO_DISCOVERY_URL` (HTTPS only, no redirects); SAML and OIDC organization SSO with verified domains are part of Executor Cloud Enterprise.

## Related

- [The MCP endpoint](/docs/mcp)
- [Add an MCP client](/docs/mcp-clients)
- [Desktop apps](/docs/desktop-apps)
- [Apps](/docs/apps)
- [Self-host](/docs/run/self-host)
- [Organizations and access](/docs/concepts/organizations-and-access)
- [Tracing](/docs/run/tracing)
- [Usage analytics](/docs/run/usage-analytics)
