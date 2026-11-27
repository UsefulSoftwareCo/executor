---
"@executor-js/hosted-server": patch
"@executor-js/hosted-web": patch
"@executor-js/hosted-self-host": patch
"@executor-js/hosted-cloud": patch
"@executor-js/ui": patch
"@executor-js/app-management": patch
---

Installed catalog apps follow the official app feed. A daily pass (and every self-host start)
queues member setup for each organization that installed one, and member setup builds the
feed's current source without saving anything. An install nobody changed, with no undeployed
workspace edits, is deployed the new source over the version it was checked against when every
linked account keeps working, and the source is committed to its workspace. Otherwise the update
is held back: the app's Versions tab shows "Update available", with how many linked accounts
would need reconnecting, and a manager's Update applies it. `GET` and `POST
/api/organizations/:organization/apps/:app/catalog-update` read and apply the held-back update
(managers only); applying fails with `CatalogUpdateUnavailable` when the app, its workspace, the
feed or the accounts it would break changed since. An install someone edited is never updated by
itself, and a failed sweep never fails member setup.
The workspace commit keeps a framework pin the workspace held, and a workspace left behind by a
commit that failed after an update is brought back to the running source on the next sweep.
