---
"@executor-js/sdk": patch
---

A deploy to an existing app takes an optional `expectedVersion`, as `activate` does. When another
version is active by the time the deploy would build or activate, such as after someone else's
deploy, it fails with `AppVersionChanged` and saves no version. A deploy whose build runs
migrations checks again right before them; migrations that ran still stay if a concurrent change
fails the deploy afterwards, as for any deploy that fails after migrating. Deploys that omit it do
not check.
