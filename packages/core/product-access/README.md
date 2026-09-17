# @executor-js/product-access

The product's personal/organization access rules for
[`@executor-js/sdk`](../sdk). The SDK executes tools and enforces tenant
isolation; it deliberately owns no product rule. Every `createExecutor` call
requires an `ExecutorAccess` — the product's decisions for:

- **`owners`** — which owner partitions (`"user"`, `"org"`) the binding sees
  and may write, in precedence order. Really filters storage CRUD, tool
  list/schema/invoke, plugin storage and plugin blobs.
- **`settingsWrite(target)`** — whether a user-intent settings mutation
  (connections, policies, OAuth clients, the integration catalog) is allowed,
  asked live at every sink.
- **`capabilities`** — `adminReads` (the tenant-wide read-only admin surface)
  and `storageWrites` (`"denied"` = whole-executor read-only).
- **`toolPolicy(sources)`** — how stored policy rows and toolkit capability
  rules resolve into an effective allow/approve/block decision.

This package ships the standard rules. Core never falls back to them — a
composition root states its posture explicitly.

## Effect SDK

```ts
import { Effect } from "effect";
import { createExecutor } from "@executor-js/sdk/core";
import { singleUserAccess } from "@executor-js/product-access";

const program = Effect.gen(function* () {
  const executor = yield* createExecutor({
    tenant,
    subject,
    onElicitation: "accept-all",
    access: singleUserAccess(),
  });
  // Execution stays on the executor namespaces: executor.tools, executor.execute, …
});
```

## Promise SDK

```ts
import { createExecutor } from "@executor-js/sdk"; // published root = Promise API
import { workspaceServiceAccess } from "@executor-js/product-access";

const executor = await createExecutor({
  onElicitation: "accept-all",
  // Subject-less single-workspace embedder posture.
  access: workspaceServiceAccess(),
});
```

## Postures

| Constructor                                      | Binding                                                                                               | Used by                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `singleUserAccess()`                             | bound subject, everything allowed                                                                     | local daemon, CLI, desktop          |
| `memberAccessForRole({ orgRoleModel, orgRole })` | bound member; admins configure, members use                                                           | HTTP API plane                      |
| `requestBoundMemberAccess()`                     | bound member; decision re-read per request via `CurrentOrgWriteAccess`, re-stamped on approval resume | MCP session stacks                  |
| `workspaceServiceAccess()`                       | subject-less org service; boot convergence                                                            | seeding/system executors, embedders |
| `platformObserverAccess()`                       | subject-less, storage read-only, tenant-wide `admin` reads                                            | `/admin/*` org-credential plane     |

`orgWriteAccessForRole` is the single home of the admin/member rule.
`./policy` exports the resolution semantics (owner ranking, most-restrictive
merge, plugin-default fallback, toolkit allowlist) — browser-safe, built on
`@executor-js/sdk/shared`. `./testing` exports `testAccess` postures for
tests (`makeTestConfig({ access: testAccess.member() })`).

## Breaking changes (from the pre-split SDK)

- `ExecutorConfig.orgWrites` and `platformView` are gone; `access` is
  required on both the Effect and Promise `createExecutor`.
- `makeTestConfig` / `makeTestWorkspaceHarness` / `makeTestExecutor` /
  `makeTestWorkspaceLayer` require `access`.
- Policy resolution functions moved here from `@executor-js/sdk`
  (`resolveEffectivePolicy`, `effectivePolicyFromSorted`, …); pattern
  matching (`matchPattern`, `isValidPattern`) stays in the SDK.
- No stored schema or data migration: rows, tenants, owners, subjects and
  tool addresses are unchanged.
