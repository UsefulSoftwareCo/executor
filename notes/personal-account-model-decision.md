# Pending: hosted personal-account model (PR #92)

Status: pending the user's product decision. The weekly upstream sync does not authorize a deployment or acceptance of the ownership changes.

Upstream makes every hosted account personal. Groups share apps and OAuth clients, not saved accounts. A `destination: { kind: "shared" }` on an account connection is no longer honored. App-wide links still let an editor use their own account through an app for every caller; they do not transfer account ownership.

Keep `e2e/tests/shared-app-account-handoff.spec.ts` skipped and both hosted targets marked `not-run` in `e2e/test-plan.ts` until the user decides whether to accept this model or restore the fork's shared-account behavior. The scenario is retained, not deleted, because it records the previous product guarantee.

Before any authorized upgrade, review the live-data impact report. Hosted step `10_group_account_connections` removes pending group-shared connection access without a backup. Step `12_personal_accounts` reassigns shared accounts, removes other members' user links (converting eligible links to app links), removes account-group memberships, and removes pending shared connection access. Step 12 records its changes in `hosted_personal_accounts_backup`; that does not recover step 10's earlier deletions. Neither step deletes saved credential accounts themselves.
