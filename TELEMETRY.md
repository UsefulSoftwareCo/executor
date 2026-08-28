# Telemetry

Executor's local products (the CLI, the desktop app) and self-hosted
deployments send a small set of anonymous usage events. This document is the
complete account of what is sent, what is deliberately not sent, why the
feature exists, and how to turn it off.

The hosted cloud product has its own browser-side analytics, disclosed
separately in its terms; this document covers the software that runs on your
machines.

## Why

Executor is used mostly outside our infrastructure. Without some signal from
local and self-hosted installs, every product decision about them is a guess:
we cannot tell whether a feature ships broken, whether anyone uses toolkits,
whether executions fail at unusual rates after a release, or whether the
product is growing anywhere except cloud.

The events exist to answer exactly one kind of question: **how are product
features being used?** They are metadata about the product, not about you.
Anything that would answer "what is this user doing" — which APIs you call,
what your tools are named, what your code does — is out of scope by design,
not by omission.

## What is sent

Each event carries its named properties plus, on every event: a random
per-install id, the product surface (`cli`, `desktop`, or `selfhost`), the
release channel, and the app version.

| Event                 | Properties                                       | Meaning                                                                                                                                         |
| --------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `execution_completed` | `ok`, `plane` (`mcp`/`api`), `toolkit` (boolean) | A code execution finished, split by whether an agent (MCP) or a human-facing API triggered it, and whether a toolkit-scoped endpoint served it. |
| `integration_added`   | `plugin_key`                                     | An integration was added, by kind (`openapi`, `mcp`, `graphql`, ...).                                                                           |
| `integration_removed` | `plugin_key`                                     | An integration was removed, by kind.                                                                                                            |
| `artifact_created`    | `via` (`agent`/`ui`)                             | A generative-UI artifact was saved.                                                                                                             |
| `artifact_viewed`     | `via`                                            | An artifact was opened for its content.                                                                                                         |
| `artifact_updated`    | `via`                                            | An artifact was overwritten or renamed.                                                                                                         |
| `artifact_deleted`    | `via`                                            | An artifact was deleted.                                                                                                                        |

That table is exhaustive. The typed catalog the code compiles against is
[`packages/core/analytics/src/events.ts`](packages/core/analytics/src/events.ts);
an event that is not in that file cannot be sent.

## What is never sent

- No code, tool arguments, tool results, or error messages.
- No secrets, tokens, or credentials.
- No names you typed: no integration slugs, connection names, toolkit slugs,
  tool names, or artifact titles. The **kind** of integration (`openapi`,
  `mcp`, ...) is a product question; **which** service you connected it to is
  your business.
- No identity: no emails, usernames, hostnames, IP-derived location, or org
  names. Events are marked so the analytics backend builds no person profile.

## The anonymous id

A random UUID is minted the first time the daemon or server starts and stored
as `analytics-id` in the data directory (`~/.executor` for local installs, the
configured data dir for self-host). It exists so that ten events from one
install count as one install, not ten. It is not derived from your machine,
account, or network, and deleting the file resets it. When telemetry is
disabled the file is never created.

## Opting out

Set either environment variable to `1`, `true`, or `yes`:

- `DO_NOT_TRACK` — the [cross-tool convention](https://consoledonottrack.com),
  which Executor also honors for its other outbound calls (crash reporting,
  the integrations.sh catalog fetch).
- `EXECUTOR_DISABLE_ANALYTICS` — telemetry only, if you want the catalog
  fetch and crash reporting to keep working.

Opting out is total: the analytics service becomes a no-op, nothing is
buffered, nothing is sent, and no id file is written. The CLI's managed
service (launchd/systemd) forwards both variables into the supervised
daemon's environment, so an opted-out install stays opted out.

## Delivery mechanics

Events buffer in memory (bounded) and flush in batches on a fixed cadence,
plus once at shutdown. Delivery is best-effort: a failed flush re-queues and
retries later, failures are swallowed, and no user-facing operation ever
waits on — or can be failed by — analytics. The ingest endpoint is PostHog
(`us.i.posthog.com`); the project key in the source identifies the project
and grants no read access.

## Where the line is enforced

Structurally, not by convention:

- The event catalog is a closed, typed interface — adding a property means
  editing [`events.ts`](packages/core/analytics/src/events.ts) in a reviewed
  change, next to the property rules at the top of that file.
- Attribution (`plane`, `via`) is bound where each serving surface is
  composed, so events cannot carry request-controlled labels.
- Observers hang off neutral seams (an engine wrapper, post-commit hooks); the
  core SDK carries no analytics vocabulary and hosts that do not opt in — like
  every test — compose with no analytics at all.
