---
"executor": minor
---

Extract personal/organization access rules from the core SDK into the new
`@executor-js/product-access` package. BREAKING for SDK embedders:
`createExecutor` (Effect and Promise APIs alike) now REQUIRES
`access: ExecutorAccess` — the product's decisions for row visibility and
write partitions (`owners`), user-intent settings authorization
(`settingsWrite`), view capabilities (`adminReads` / `storageWrites`), and
effective tool-policy evaluation (`toolPolicy`). The former `orgWrites` and
`platformView` options are removed; select a posture from
`@executor-js/product-access` (`singleUserAccess()`,
`workspaceServiceAccess()`, `memberAccessForRole(...)`,
`requestBoundMemberAccess()`, `platformObserverAccess()`) or supply your own.
Core keeps enforcing tenant isolation, the storage owner policy clamps, and
approval mechanics; it no longer decides any product rule. Test helpers
changed too: `makeTestConfig` and the workspace harness require `access`
(postures in `@executor-js/product-access/testing`). No stored schema or data
migration — persisted rows, tenants, owners, subjects and addresses are
unchanged.
