---
title: Operator OAuth clients
description: "Configure built-in operator Google, GitHub, and Slack OAuth clients and the optional OAuth client metadata document on self-hosted Executor."
---

Self-host operators can configure built-in OAuth clients for Google and GitHub. The unlisted Slack client is for eligible existing connections.

Set the matching `EXECUTOR_OAUTH_<PROVIDER>_CLIENT_ID` and `EXECUTOR_OAUTH_<PROVIDER>_CLIENT_SECRET` environment variables and register the provider-account callback URL `<BETTER_AUTH_URL>/api/oauth/callback` (or your `EXECUTOR_OAUTH_CALLBACK_URL`) with each provider.

**Prerequisites:** A running self-host container ([Self-host with Docker](/docs/run/self-host)) with `BETTER_AUTH_URL` set, and developer/admin access to create OAuth apps in Google Cloud Console, GitHub, or Slack.

**You'll know it worked when** the container starts healthy without missing-pair errors in `docker logs`, a compatible app's **Accounts → Connect new account** flow offers **Executor for Google** or **Executor for GitHub**, and completing a connection succeeds with the provider.

## Callback URL

By default, provider-account authorization-code OAuth flows redirect back to:

```text
<BETTER_AUTH_URL>/api/oauth/callback
```

Dashboard SSO and incoming MCP authorization use separate routes. If you set `EXECUTOR_OAUTH_CALLBACK_URL`, route that URL to Executor at `/api/oauth/callback`. Register the resulting provider callback URL, including any override, with your provider.

## Built-in operator OAuth clients

Executor defines three built-in operator client slots. Supply both the client ID and the client secret for each client you configure.

| Provider | Display label | Environment variables | Managed access-token hosts for app requests |
| --- | --- | --- | --- |
| Google | **Executor for Google** | `EXECUTOR_OAUTH_GOOGLE_CLIENT_ID`, `EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET` | `*.googleapis.com` |
| GitHub | **Executor for GitHub** | `EXECUTOR_OAUTH_GITHUB_CLIENT_ID`, `EXECUTOR_OAUTH_GITHUB_CLIENT_SECRET` | `api.github.com`, `uploads.github.com`, `api.githubcopilot.com` |
| Slack | **Executor for Slack** | `EXECUTOR_OAUTH_SLACK_CLIENT_ID`, `EXECUTOR_OAUTH_SLACK_CLIENT_SECRET` | `mcp.slack.com` |

Executor places the managed access token in app requests to these hosts only if both the app and the connected account allow the destination (managed OAuth uses separate sealing and its configured header and host limits). Code exchange and refresh use the provider's configured token endpoint.

### Google (`Executor for Google`)

1. In Google Cloud Console, create an OAuth 2.0 Web application client and add the effective [provider callback URL](#callback-url) as an authorized redirect URI.
2. Enable the Google APIs your apps use and configure the OAuth consent screen for the scopes your apps request.
3. Pass `EXECUTOR_OAUTH_GOOGLE_CLIENT_ID` and `EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET` to the container.

### GitHub (`Executor for GitHub`)

1. Create a GitHub App with User-to-Server OAuth enabled and set its callback URL to the effective [provider callback URL](#callback-url). Configure the repository and account permissions the app needs in GitHub.
2. Pass `EXECUTOR_OAUTH_GITHUB_CLIENT_ID` and `EXECUTOR_OAUTH_GITHUB_CLIENT_SECRET` to the container.

### Slack (`Executor for Slack`)

1. Configure your Slack OAuth app with the effective [provider callback URL](#callback-url).
2. Pass `EXECUTOR_OAUTH_SLACK_CLIENT_ID` and `EXECUTOR_OAUTH_SLACK_CLIENT_SECRET` to the container.

## OAuth client metadata document

For a new connection using automatic client selection, Executor first checks for an eligible stored registration. A refused match can stop the attempt. If the lookup finds no match, Executor looks for an offered operator client. If no operator client is offered, provider discovery determines whether Executor can use a configured metadata document or register a client dynamically. Reconnecting an existing account can reuse its saved client.

Set `EXECUTOR_OAUTH_CLIENT_METADATA_URL` to a canonical, publicly reachable HTTPS URL with a non-root path and no query, fragment, or credentials. To have Executor serve the document, use `/oauth/client-metadata.json` on your instance origin or route that path from the configured public metadata origin to Executor:

```bash
EXECUTOR_OAUTH_CLIENT_METADATA_URL=https://executor.example.com/oauth/client-metadata.json
```

For a document served by Executor, check the returned `redirect_uris` and route the listed callback to Executor. To host the document yourself on another origin and path, list the effective [provider callback URL](#callback-url) in that document. Executor checks for canonical HTTPS and known private or loopback address literals at startup. Verify DNS and reachability separately.

Turn this on **only** when the metadata URL is publicly reachable over HTTPS on the internet — remote OAuth servers fetch the metadata document directly.

## Example

Replace the placeholder origin, client IDs, and client secrets below with your own values. Route your HTTPS origin to the loopback container through a TLS reverse proxy and keep access restricted to you until setup finishes. Complete setup before making the metadata URL public:

```bash
docker run -d --name executor-v2 --init --restart unless-stopped \
  -p 127.0.0.1:4400:4400 -v executor-v2-data:/app/data \
  -e BETTER_AUTH_URL=https://executor.example.com \
  -e EXECUTOR_OAUTH_GOOGLE_CLIENT_ID=1234567890-example.apps.googleusercontent.com \
  -e EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET=GOCSPX-example-secret \
  -e EXECUTOR_OAUTH_GITHUB_CLIENT_ID=Iv23liExampleClientId \
  -e EXECUTOR_OAUTH_GITHUB_CLIENT_SECRET=example-github-secret \
  -e EXECUTOR_OAUTH_CLIENT_METADATA_URL=https://executor.example.com/oauth/client-metadata.json \
  ghcr.io/usefulsoftwareco/executor-selfhost:2.0.0-beta.79
```

Confirm the container started cleanly and serves the metadata document:

```bash
curl -sf http://127.0.0.1:4400/health
curl -sf http://127.0.0.1:4400/oauth/client-metadata.json
```

Then open a compatible app's **Accounts → Connect new account** flow in the dashboard to confirm it offers the configured operator client, and complete a connection to verify the provider accepts your credentials and callback URI.

## Related

- [Self-host with Docker](/docs/run/self-host)
- [Deploy, proxy, and tune self-host](/docs/run/self-host/deploy)
- [Sign-in and OIDC SSO](/docs/run/self-host/sign-in-and-sso)
- [Connect an account](/docs/connect-an-account)
- [Providers and accounts](/docs/concepts/providers-and-accounts)
