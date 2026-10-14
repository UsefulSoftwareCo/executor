---
"@executor-js/sdk": minor
"@executor-js/local-server": minor
"@executor-js/app-templates": patch
---

Breaking: `accounts.list` and `accounts.providers` require `owner`, in the SDK, the
Promise facade, `GET /v1/accounts` and `GET /v1/providers`. A call without one fails
with 400 instead of reading every owner's accounts. Pass the owner whose accounts you
want; `accounts.providers` returns only the providers of that owner's accounts.

Local assigns owners itself. Apps created through its API (`POST /v1/apps`,
`/v1/apps/copies` and `/v1/apps/deploy` without `app`) and OAuth clients registered
through it belong to `local`, whatever owner the caller sends. A connection request
saves its account under `local`, or `executor-local` for the server's own Executor app,
and only for an app of that owner; `accountConnect.issue` no longer takes an `owner`,
and the one `POST /v1/account-connections` takes is ignored. The local dashboard lists
the accounts of `local` and `executor-local`, the owner of the server's own Executor app
and API key account.

Upgrading local gives `local` every record an agent created earlier under another owner,
once, at the first start (data step `7_local_owners`): apps with their deployments,
profiles, schedules, runs, webhooks and event subscriptions; accounts; connections and
pending sign-ins and approvals; and OAuth clients. The server's own Executor app and its
API key account stay under `executor-local`. If two apps would then share a name or a
slug, or two OAuth clients the same credentials, or a record the move has to read does
not decrypt or cannot be read back, no record moves: the log and a notice on every
dashboard page name the records and what to do, and the next start moves everything once
all but one of each is renamed or removed, or the unreadable record is removed or has
expired. An unreadable OAuth client or account is removed through the API with the API
key (`DELETE /v1/oauth-clients/<id>?owner=<owner>`, `DELETE /v1/accounts/<id>?owner=<owner>`);
an unreadable connection only by restoring a data directory saved before it was written. Moved accounts
keep renewing with the OAuth client they signed in with; the next automatic sign-in,
including a reconnect, registers a new client for `local`. The step runs on storage 4.0.11 or later, which
earlier releases refuse, so a data directory it has moved cannot be opened by an earlier
release; restore the copy saved before the upgrade to go back.

Breaking: local no longer serves `GET /v1/owners/:owner/removable` or
`DELETE /v1/owners/:owner`. Its owners are fixed, so removing one could only delete all
of the user's data or the server's own Executor app.
