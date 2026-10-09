---
title: Usage analytics
description: "What anonymous usage data the CLI, desktop app and self-hosted Executor send, and how to turn it off."
---

Released builds of the CLI, the desktop app and the self-hosted Docker image
send anonymous usage events to the Executor team's PostHog project. We use them
to see which features get used and where things fail. Builds from source send
nothing. Each server prints one line at startup when analytics are on.

## Turn it off

Set either variable before Executor starts:

```sh
DO_NOT_TRACK=1
EXECUTOR_DISABLE_ANALYTICS=1
```

Any value other than empty, `0`, `false`, `no` or `off` turns analytics off.
Nothing is recorded or sent, including feedback: the `feedback.submit` tool then
returns `FeedbackDisabled`.

## What is sent

Each event carries an anonymous install ID, made on first start and kept in the
data directory, plus the product (`cli`, `desktop` or `self-host`) and its
version.

- **Startup:** product, version, release channel, operating system,
  architecture, and the number of apps and accounts. Self-host adds the number
  of users and organizations.
- **Usage:** when tools, app pages, app data, account connections, deployments
  and scheduled runs succeed or fail, with how long they took, the error type,
  the HTTP status, the API operation name, the kind of sign-in an account uses,
  the client application's name and whether the request came from MCP, the API
  or the dashboard.
- **Feedback:** only the text you or your agent submit through
  `feedback.submit`.

On self-host, events from a signed-in person use an HMAC of their user ID, keyed
by a secret that is created per instance (`analytics-secret.key` in the data
directory) and never sent. The same person always has the same pseudonymous ID
on one instance, and it cannot be linked to their account. Self-host events also
include the root domain of the instance's public URL: `executor.platform.acme.com`
is reported as `acme.com`. Local addresses, IP addresses and tunnel or dynamic-DNS
hosts are reported as `private`.

## What is never sent

Tool inputs or outputs, app source code, app data, credentials, the names of
apps, tools, accounts or organizations, URLs other than the self-host root
domain, raw IDs, email addresses, personal names, error messages, or browser
activity. Events do not create PostHog person profiles, and PostHog does not
look up a location from them.
