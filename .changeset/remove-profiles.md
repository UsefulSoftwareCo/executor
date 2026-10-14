---
"apps": minor
"@executor-js/app-templates": patch
---

Profiles are removed. Members link accounts to an app's requirements, and every
call runs with the caller's linked accounts: one for each plain requirement and every linked account
for a `.many()` requirement. Linking another account for a plain requirement
replaces the one before; the previous account stays saved. Calls never choose
accounts: passing `$accounts` fails with `AccountChoiceUnsupported`, and a plain
requirement without a linked account fails with `AccountRequired`. The
`appProfiles` API, `profile` and `expectedProfileRevision` inputs and
`tools[app].profiles[id]` MCP paths are gone: MCP lists each app once under
`tools[app]`. Page context names the `accounts` the page runs with instead of a
profile.

Schedules, webhook subscriptions and workflow runs record an `actor`. Each member
has at most one copy of a schedule, which runs as them with their linked
accounts: `schedules.configure` configures or adds the actor's copy, and
`schedules.copy`, `update`, `runNow` and `remove` act on one copy. Webhook sources
(`webhooks.link`, `unlink`, `sources`) replace profile webhook setup and save no
account choices. Schema 4.0.13 converts stored profile data: a member whose
profiles of one app used different accounts for a plain requirement keeps the app
for one account set, and each other set becomes a copy of the app, named
"App (Profile)", with an empty database.
