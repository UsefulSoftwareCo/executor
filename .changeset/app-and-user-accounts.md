---
"apps": minor
"@executor-js/sdk": minor
"@executor-js/app-templates": patch
"@executor-js/mcp": patch
---

Apps declare account requirements by scope. `user: { accounts }` holds each
caller's own linked accounts, read as `ctx.user.accounts`, as every requirement
was before. `app: { accounts }` holds the app's own accounts, which people who
can edit the app link for everyone and which every caller and the app's
background work use, read as
`ctx.app.accounts`. This is an intentional authoring break in
`apps@0.0.1-beta.90` (host protocol 13): `{ accounts }` requirements and
`ctx.accounts` are removed, webhooks name their source with its scope
(`account: { user: "github" }` or `{ app: "datadog" }`), and `cron` and
`interval` are replaced by `userCron` and `userInterval`, one copy per member
run as them, and `appCron` and `appInterval`, one schedule run without a caller
with app accounts only. Contexts of the `"app"` scope have no `user`. Bundles of
earlier protocols keep running; their requirements are user requirements. The
app-authoring skill's `upgrades/0.0.1-beta.90.md` gives the steps, and
`scripts/codemods/app-user-accounts.ts` rewrites existing source.

Accounts are linked to an app requirement in either scope: an app link for
everyone, or a user link for one member. Each link names its requirement. A
plain requirement keeps one link per scope (and member), and linking another
replaces it; `.many()` uses every link. The same account may be linked in both
scopes. The Executor app manages links with `appAccounts.app.{list,get,link,unlink,connect}`
and `appAccounts.user.{list,get,link,unlink,connect}`, which take
`path: { organization, app, requirement[, account] }`; app links need edit
access to the app. `accounts.connect` is removed: connect through
`appAccounts.userConnect` or `appAccounts.appConnect` and check progress with
`accounts.connection`. Linking an account to a requirement of another scope or
provider fails with `RequirementMismatch`, and deleting an account linked to an
app for everyone fails with `AccountLinkedToApp` until it is unlinked.

`AccountRequired` carries the requirement's `scope` and, for an app requirement,
says that someone who can edit the app must link an account. The MCP app
template takes `accounts: "app"` for one shared service account.
