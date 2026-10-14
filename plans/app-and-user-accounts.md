# App and user accounts

Status: planned. Builds on [remove profiles](remove-profiles.md). The link
redesign gave app and user accounts one link model for both scopes; this plan
describes that model.

Every account an app uses today is a caller's linked account. Some accounts
belong to the app instead: the team's Datadog key, an integration-wide secret.
This plan splits requirements and context into the app's accounts and the
user's accounts. Team references, deferred by the remove-profiles plan, are not
added: an app link is used through the app by every caller, not shared as a
member's link.

## Model

- A **link** connects an account to one requirement of an app. Links are keyed
  by requirement in both scopes; the server never infers the requirement from
  the provider.
- **User link**: one subject, the member. A member links one account per plain
  requirement, any number for `.many()`; each call uses the caller's links.
  Nothing is chosen per call.
- **App link**: no subject. It fills an app requirement for every caller and
  for the app's background work. Only people who can edit the app link, and
  only accounts they can use.
- A plain requirement keeps one link per app (and subject): linking another
  replaces it. `.many()` uses every link, and linking adds one.
- Using an app link follows app access. A caller uses the account through the
  app's code without access to the account itself.
- A requirement is either an app requirement or a user requirement. Callers
  never choose or override an app requirement's account.
- Requirement names are unique across scopes: `datadog` cannot name both an app
  and a user requirement. Stored selections, links and authorization checks
  name a requirement without its scope.
- The same account may be linked in both scopes of one app. An account used by
  both scopes in one evaluation must pass both checks: the actor's use for the
  user requirement and the app link for each app requirement. Removing the app
  link refuses the app requirement even while the actor can still use it.

Optional plain requirements are out of scope.

Out of scope: caller identity (`ctx.user.id`, issue #380), dropping the actor,
fan-out to every member, and approvals in app-scope work.

## Authoring

```ts
const requirements = {
  app: { accounts: { datadog } },
  user: { accounts: { outlook } },
};

async (ctx: MutationContext<typeof requirements>) => {
  ctx.app.accounts.datadog;
  ctx.user.accounts.outlook;
};
```

- `{ accounts }` requirements and `ctx.accounts` are removed. Intentional break,
  released with a version bump; there is no compatibility path in authored code.
- `.many()` works in both scopes.
- `MutationContext<typeof requirements, "app">` and the other contexts with the
  `"app"` scope have no `user`. App-scope declarations accept only those, and
  mutations whose handler declares no parameters, which use no context. A
  handler that declares its context without a type gets the caller's, with
  `user`, so a tool or an approved mutation reads `ctx.user.accounts` without a
  check.
- Webhooks name the scope of their source account: `account: { app: "datadog" }`
  or `account: { user: "github" }`. An app-account webhook's context has no
  `user`. A webhook written inline in `defineApp` cannot infer which scope its
  handlers' context has from the `account` beside them, so inline webhooks are
  written with `satisfies Webhook<WebhookContext<typeof requirements, "app">, ...>`
  (or the user scope) to type their handlers.
- Workflows declare their scope the same way: `WorkflowContext<typeof
requirements, "app">` for runs started without a caller, such as by an app
  schedule. A run records the scope it started in and has `ctx.user` only when
  it started with a caller.
- Schedules split by scope:
  - `appCron` and `appInterval`: one schedule per declaration, enabled by an app
    manager, no actor, app accounts only.
  - `userCron` and `userInterval`: the stack's per-member schedules, one per
    `(app, name, member)`, each enabled by its member and run as them.
  - `cron` and `interval` are removed.
- App-scope schedules and app-account webhooks accept only mutations without
  `approval`. The types reject the rest.
- Event attribution counts user accounts only. App accounts are part of every
  call, so the single-account default would always see them.

## Protocol

Framework protocol 13. `DeclaredRequirements.accounts` and `ResolvedAccounts`
are nested by scope: `{ app: {...}, user: {...} }`. Protocol 12 is frozen; the
host reads a protocol 12 bundle's requirements as user requirements.

## Core SDK

The SDK stores no links.

- Requirements record their scope at deploy.
- Operations take `AppAccounts` nested by scope. The SDK validates the map
  against the declared scopes and supplies `ctx.app` and `ctx.user`.
- `ResourceLifecycle.appLinks({ app })` returns the app links for background
  work, beside `userLinks({ app, subject })`. Each link names its requirement.
- `linkedRequirements(requirements, scope, links)` groups one scope's links by
  requirement, and `resolveLinkedAccounts({ app, deployment, appLinks,
userLinks })` resolves both scopes. An app and a user requirement may share a
  provider or an account.
- App-scope schedules and app-account webhook sources have no actor.
  `appResolving` receives the user accounts, checked by the actor's use, and
  each app requirement's `(requirement, account)`, checked by the app link; an
  account in both is checked both ways. The same checks run again after a
  renewal and before a kept evaluation is served.
- Removing what an app registered, such as a webhook registration, uses
  `removalResolving` with the same scoped accounts and the app. Its app accounts
  are authorized by the app's authority over them, not a current app link,
  because unlinking is what removes their registrations.
- Workflows keep captured accounts and the scope they started in. A step whose
  captured app account is no longer linked fails like a revoked credential.
- Evaluated declarations are kept per invocation scope.
- An account has one webhook source per app. With an app link it has no actor
  and serves only the webhooks of the app requirements it is linked to; an
  account also linked by members serves as its app link, with no user copy.

## Product

Hosted:

- One table, `hosted_app_account_links (app, requirement, subject, account,
linked_by, created_at)`, `subject` null for an app link. Partial unique
  indexes on `(app, requirement, account)` for app links and
  `(app, subject, requirement, account)` for user links.
- Routes under `/api/organizations/:org/apps/:app/accounts`, with literal `app`
  and `user` segments, also exposed through the Executor app:
  `appAccounts.{app,user}.list` (`GET /app`, `GET /user`), `.get`
  (`GET /:requirement`: linked accounts, then the others the caller could link),
  `.link` (`PUT /:requirement/:account`), `.unlink`
  (`DELETE /:requirement/:account`) and `.connect`
  (`POST /:requirement/connections`). App links need edit access to the app
  (org owners and admins, and the app's creator) and, to link, use of the
  account. Anyone who can use the app lists the app links, without upstream
  account information unless they can edit it.
- `RequirementMismatch` (422): no such requirement in that scope, or the
  account's provider differs.
- Tool calls fill app requirements from the app links and user requirements from
  the caller's user links.
- MCP grants and scoped connections do not list app accounts; app access
  authorizes them.
- Connections carry the scope. Completing one links the new account to the
  requirement in that scope. `accounts.connect` is removed; status and form
  steps stay under `accounts.connection`.
- Deleting an account with an app link is refused with `AccountLinkedToApp`
  (409). Deleting one with only user links unlinks them.
- When an app-linked account needs reconnecting, people who can edit the app are
  told. Callers get an error naming the app account and that someone who can
  edit the app must reconnect it.
- An app link registers the account's app-account webhooks; unlinking
  unregisters them. Removing the last app link hands the source to a member who
  links the account, or stops it. App schedules are not paused: one whose plain
  requirement loses its link waits as "Account required", as a member's copy
  does, and resumes once an account is linked again. Schedule declarations do
  not say which requirements they use, so pausing would stop schedules the
  account never served.

Local has no organizations: `local_app_account_links` has the same shape
without `linked_by`, `subject` null or `local`, and no access policy.

MCP `$accounts` and discovery describe user requirements only.

UI: one discovery cache per app page, refreshed after the caller's own link,
unlink or connect. The Accounts tab has "App accounts" ("Linked for everyone")
and "Your accounts" ("Linked for you"), built from the same component: each
requirement lists the accounts the caller could use, a radio for a plain
requirement and checkboxes for `.many()`, with "Connect new account" last.
People who cannot edit the app see the app section greyed out and read-only.
Schedules show their scope.

## Migration

- Authored apps: a codemod rewrites `{ accounts }` to `{ user: { accounts } }`,
  `ctx.accounts` to `ctx.user.accounts`, webhook `account: "x"` to
  `account: { user: "x" }`, and `cron`/`interval` to `userCron`/`userInterval`
  in apps with user requirements or `appCron`/`appInterval` otherwise. It warns
  at each schedule it makes an app schedule, and gives that schedule's mutation
  handler `MutationContext<typeof requirements, "app">` when it declares its
  context without a type.
- Stored data: no app links are created. Existing links stay user links, now
  keyed by requirement; see [remove profiles](remove-profiles.md). Deployments of protocol 12 and earlier keep running with
  their schedules as user schedules, one copy per member. Deploying a
  declaration as an app schedule replaces those copies: activation deletes the
  members' copies of it with their settings, run history and pending approvals,
  and the app schedule starts paused until an app manager enables it.
- Templates gain an app-scope option for a single shared service account.
- Data step `5_redeploy_pre_beta10_executor_apps` changes only an old Executor
  app's pin, so it now pins `0.0.1-beta.84`, a protocol 12 release,
  instead of the host's release, on which that source no longer builds.

Follow-up: move v1's integration-wide fixed credentials (`notes/v1-import.md`)
to app links once this lands.

## Stack

1. Framework: requirement and context split, protocol 13, schedule and webhook
   constructors.
2. SDK: nested accounts, scope at deploy, `appAccounts`, background resolution.
3. Hosted: links, policy, routes, connect and grants.
4. MCP, local and UI.
5. Codemod, templates, demo apps and docs.
6. Tests on top.
