# Remove profiles

Status: implemented. [App accounts](../notes/app-accounts.md) describes the result.
The link redesign in [app and user accounts](app-and-user-accounts.md) then keyed
links by requirement and kept app and user links in one table; this plan is
updated to match.

Profiles bundle one subject's account selections, enabled state, setup
reconciliation and resource ownership for an app. They made every call, MCP
path, UI tab and background resource name a profile. This plan removes the
concept. Shared accounts and groups stay unchanged.

## Model

- **Account**: unchanged. Personal or shared; access is decided by the existing
  hosted policy (`hosted_account_access`, groups).
- **User link**: one row per `(app, requirement, account, subject)`. It records
  that a user uses an account for one requirement of an app. It has no
  revision, name, enabled state or setup lifecycle. A plain requirement has at
  most one per user and app: linking another account replaces it, and the
  previous account stays saved.
- **Account set**: for a caller and app, `my links ∩ accounts I can use`,
  checked at use time. Missing or revoked accounts drop out; nothing is
  substituted.

Links live in the product, hosted and local. The core SDK stores no
selections.

Team references (one link for everyone who can use a shared account) are
deferred. The link redesign uses a null `subject` for app links instead, which
fill app requirements only.

## Requirements and calls

Calls never choose accounts. Each runs with the caller's linked accounts.

- A plain `provider` declaration means one account. `ctx.accounts.x` is the
  caller's linked account for it, so authored code does not change. With none
  linked, the call fails with `AccountRequired`. With several linked anyway
  (a deploy turned `.many()` into plain), the newest link is used.
- `.many()` receives every account linked to it. To use fewer, unlink some.
- There is no per-call choice: no `$accounts` MCP input, no `accounts` on
  product routes, no account in the URL, no account picker for authored UIs or
  runtime tabs. A tool input with `$accounts` fails with
  `AccountChoiceUnsupported`.
- Each link names its requirement, so two plain requirements with the same
  provider have their own links. Two accounts as one plain requirement take two
  apps.

## Core SDK

- Operations that execute app code take an explicit `accounts` map instead of
  `profile` and `expectedProfileRevision`: tools, skills, app data and workflow
  start.
- Delete the `appProfiles` group, `ProfileHost`/`ProfileDispatcher`, profile
  setup reconciliation, `setEnabled` and the `profileResolving` hook.
- Add a lifecycle hook that returns a subject's linked accounts for an app, used
  only by background work. Add `appRemoving` so the product deletes links with
  the app.
- `accountRemoving` deletes the account's user links in the same transaction.
  An account with an app link is refused (`AccountLinkedToApp`).
- Discovery caches by deployment and account set instead of profile revision.
- MCP returns to `tools[appSlug]`. Search lists each app's linked account
  labels as context; signatures take no account input.

## Background work

Schedules and webhooks keep separate tables with the same rule:

- The row records an `actor`, whose access is checked. Neither saves an account
  choice.
- Each run resolves the actor's current links, as a call does. A plain
  requirement with no linked account waits, like the existing reconnect wait.
- Webhooks fix the source account and are keyed by `(app, account)`. The source
  account serves its provider's plain requirement; other requirements use the
  actor's links. Several users linking the same shared account produce one
  subscription. It is removed with the last link to that account.
- Webhooks register automatically when an account is linked. Schedules still
  start paused and are enabled by a person.
- Each member has at most one copy of a schedule declaration, which runs as
  them with their linked accounts. Fan-out within one copy uses `.many()`.
- Workflows keep their captured accounts and deployment, as today.

## Product and UI

- Hosted owns `hosted_app_account_links`, local `local_app_account_links`, and
  each its account-set query.
- Remove the profile dropdown, create-profile dialog, profile URL parameter,
  Default/Profile 2 naming and the profile launch page.
- The app's Accounts tab lists, per requirement, the accounts the caller could
  use: a radio for a plain requirement, checkboxes for `.many()`, and "Connect
  new account" last, on hosted and local. Connecting an account from an app
  creates the account and its link in one transaction.
- The Schedules tab shows the member's own copy under each declaration, with
  Enable or Pause, Run now and Remove. A copy whose plain requirement has no
  linked account shows "Account required".

## Migration

Approved rules:

- A member's profiles of one app are grouped by their plain accounts. The group
  of their oldest enabled profile (else oldest profile) stays with the app. Each
  other group becomes a copy of the app, "App (Profile)", with the same owner,
  source, deployment and access, and an empty database.
- Each enabled profile's selections become the member's user links to its
  group's app, keyed by the selection's requirement, including shared accounts:
  a plain requirement's first existing account, every account of a many() one.
  Disabled profiles create no links.
- Schedules: `installation` becomes `actor`, on the group's app. A member's
  schedules of one declaration merge into one, enabled if any was. Schedules
  that would run with more many() accounts than their profile had start paused.
- Webhooks are re-keyed to `(app, account)` with unchanged source accounts.
- Running workflows keep their captured accounts and stay with the app.
- The default Executor app's managed key becomes a user link. A deleted
  key is not recreated.
- New schema version, upgraded in place. Older layouts follow
  [storage migrations](../notes/storage.md#current-baseline-and-migrations),
  which lists every rule.

The removed SDK, HTTP and MCP profile surfaces are an intentional API break,
released with a version bump and changelog entry. There is no compatibility path.

## SDK surface

Implemented in the SDK layer of the stack.

- Tools, skills, app data and workflow start take `accounts`: requirement name
  to account IDs. The product resolves it from the caller's links; no caller
  supplies it. Every requirement is named; a plain one names exactly one
  account and `.many()` any number. A missing requirement fails with
  `AccountRequired`.
- `CurrentActor` is the subject whose access is checked. The product provides
  it around a caller's operations; the SDK provides the saved actor around
  schedules, webhook callbacks and workflow steps. `accountsResolving` reads it.
- `ResourceLifecycle` gains `userLinks({ app, subject })` (named
  `linkedAccounts` before the link redesign), `appRemoving(app)`,
  `appAccountConnected({ app, requirement, account })`, called when a
  connection started for an app saves its account, and
  `sourceActorLost({ app, account, actor })`, called when resolving a webhook
  source finds its actor no longer links the account. Hosted hands the source to
  the oldest other linking member who can use the account, or unlinks it.
- Caller-side resolution is one pure SDK helper, `resolveLinkedAccounts`, with
  `linkedRequirements` and `plainAccount` (the newest link). Hosted, local and
  MCP pass the caller's linked accounts; the helper applies the rules above.
- Background resolution uses the same rules, with a webhook source's account
  for its provider's plain requirement.
- Schedules are one row per `(app, name, actor)`. `configure` configures the
  actor's copy, adding it when missing; `update`, `runNow` and `remove` act on
  one copy. Enabled copies report `accountRequired` or `reconnectAccount` and
  skip occurrences until resolved.
- `apps.copyAs({ from, owner, name, id })`, host-only, makes a copy under a
  reserved ID for the migration's data step.
- Webhook sources: `webhooks.link({ app, account, actor, config? })`
  saves intent and can run in the product's transaction;
  `webhooks.unlink({ app, account })` and `webhooks.sources({ app })`. The
  `WebhookSourceHost` dispatcher replaces `ProfileHost` and registers one
  managed subscription per definition the account's provider serves, on the
  active deployment. Activation re-registers. Subscriptions record `actor`;
  callbacks resolve the accounts.
- Workflow runs record the actor that started them. Runs started by app code
  see only runs of the same actor.
- Account health takes the apps explicitly: `health` and `check` take `apps`,
  `listHealth` takes `links`. `apps.list` no longer filters by account.

## Migration mechanics

SDK schema 4.0.13 converts SDK rows and keeps the profile data for the product.
It runs in the migration transaction, before the product's own steps.

- Additive: `executor_workflow_runs.actor`, `executor_webhooks.actor`,
  `executor_webhook_sources` and `executor_profile_app_copies`. The profile
  columns and `executor_installations` stay, also in fresh databases, so the
  product steps can read them everywhere.
- Profiles are grouped by member and plain accounts. Each group other than the
  original gets a planned copy under a reserved app ID; its schedules wait there
  paused, and pending connections for its profiles target it.
- Schedules merge per `(app, name, actor)`: running, then enabled, then oldest
  profile; run history of the others moves to it. A unique
  `(app, name, actor)` index follows.
- Workflow runs and subscriptions get the profile subject as `actor`. Start and
  subscription keys are unique per app, actor and profile column; subscription keys only among
  subscriptions that have not stopped, which stay as history.
- Every account an enabled profile of an original group selected becomes a
  pending webhook source, from the oldest such profile. Copy groups'
  subscriptions stop; the copy gets its own sources when its accounts are
  linked.
- The previous Cloud server keeps serving until the new one deploys. Triggers
  fill the actor of rows it inserts with a profile and park its new schedules
  of a copy group's profile under the copy, paused. Profile edits in that window
  are not carried over.

Phase B, in a hosted product step after the SDK migration and in the same
transaction (`9_app_account_links`):

- Create `hosted_app_account_links` and fill it from `executor_installations`:
  one user link per `(app, requirement, account, subject)` in enabled profiles
  that are not removing or removed and whose group stays with the app, keyed by
  the selection's requirement: a plain requirement's first existing account,
  every account of a `.many()` one. Skip apps and accounts that no longer
  exist. Convert the managed Executor key the same way.
- Rewrite `hosted_connection_access.target` without `installation`, and stop
  reading `executor_installations` everywhere else. MCP grants and connections
  of a copy group's profile move to a clone of the entry for the copy.
- Implement `userLinks`, `appRemoving`, `appAccountConnected`, provide
  `CurrentActor` for caller operations, and call `webhooks.link`/`unlink` when
  the first link to an `(app, account)` is added or the last removed. When a
  source's actor loses their link while others remain, link again with another
  actor.
- Call `startScheduleWorker`'s `wakeWebhookSources` after linking.

Local step `2_app_account_links` creates `local_app_account_links` from the same
profiles. Saved MCP connections and grants that ran as a profile run as that
profile's accounts, converted once in the MCP auth database.

Data step `10_profile_app_copies`, on every host, creates each planned copy,
links its accounts for the member and resumes its planned schedules. Cloud ships
it in report mode; until a deploy applies it, copies do not exist and their
schedules wait paused under the reserved ID.

Hosted product writes that call SDK operations, such as linking a webhook
source, run in the SDK's tracked transaction (`HostedTransaction`); the SDK
refuses to run inside a raw SQL transaction. The managed Executor key is linked
only when member setup creates it, so a member's unlink stays.

A later SDK version, once no running server reads them, drops the triggers,
`executor_installations` and the profile columns, and rebuilds the start and
subscription key indexes without the profile column. Before rebuilding them it
must resolve keys that only the profile column kept apart.

## Out of scope

- Creating shared accounts from the UI. Today only the hosted API can, which
  includes agents using the Executor app.
- Limiting which hosted operations the Executor app exposes.
- Team references, exclusions and per-group link scopes.

## Stack

1. SDK: `accounts` input, background rows keyed by actor and account, lifecycle
   hooks, profile surfaces removed behind the new inputs.
2. Product: links, account-set query, hosted routes.
3. UI: Accounts tab, schedule copies without account choice.
4. Migration and deletion of profile storage.
5. Tests on top.

No feature flag. The code layers skip CI where supported; the tests layer runs
the whole stack.

## Notes

`notes/app-profiles.md` was replaced by [app accounts](../notes/app-accounts.md).
`notes/project-orientation.md`, `notes/groups-and-accounts.md`,
`notes/schedules.md`, `notes/webhooks.md`, `notes/storage.md` and `README.md`
describe the new model.
