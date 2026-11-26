# Documentation source citations

This file is internal authoring metadata and is not published (it sits outside
`apps/docs/content/`). Source references correspond to CLI/desktop
`2.0.0-beta.79` (commit `6a3b0129e4`) and deployed Executor Cloud unless noted
otherwise.

## Getting started & desktop

- `/docs/quickstart` (`apps/docs/content/quickstart.md`)
  - Entry skill & MCP tools: `packages/app-templates/executor/skills/executor/SKILL.md`, `packages/mcp/src/contracts/tools.ts`, `packages/mcp/src/contracts/skills.ts`, `packages/mcp/src/contracts/execute.ts`
  - Cloud onboarding & dashboard flow: `apps/hosted/cloud/web/src/implementation/components/team-setup.tsx`, `apps/hosted/cloud/src/implementation/onboarding.ts`, `apps/hosted/web/src/implementation/pages/agent-setup.tsx`, `apps/hosted/web/src/implementation/pages/accounts-setup.tsx`, `packages/ui/src/implementation/dashboard/app-accounts.tsx`
  - Local install, launcher, service & key storage: `apps/cli/package.json`, `scripts/releases/npm-launcher.mjs`, `apps/docs/public/install.sh`, `apps/docs/public/install.ps1`, `apps/local/server/src/contracts/service.ts`, `apps/local/server/src/implementation/bootstrap.ts`, `apps/local/server/src/implementation/launcher.ts`, `apps/local/server/src/implementation/server.ts`, `apps/local/server/src/implementation/mcp.ts`
  - Self-host MCP route: `apps/hosted/self-host/src/implementation/routes.ts`, `apps/hosted/web/src/implementation/pages/connect.tsx`
  - CLI verification test: `e2e/tests/cli-tool-commands.spec.ts`

- `/docs/desktop` (`apps/docs/content/desktop.md`)
  - Welcome screen, accounts & sidebar switcher: `apps/local/desktop/src/implementation/pages.ts`, `apps/local/desktop/src/implementation/accounts.ts`, `apps/local/web/src/implementation/app.tsx`, `apps/hosted/web/src/implementation/components/dashboard-frame.tsx`
  - Hosted server sign-in, TLS & Linux storage warning: `apps/local/desktop/src/implementation/hosted-servers.ts`
  - Shared data dir, menus, updates, recovery & reset: `apps/local/desktop/src/main.ts`, `scripts/releases/standalone-entry.ts`, `apps/local/desktop/src/implementation/updates.ts`, `apps/local/desktop/src/implementation/connection.ts`, `apps/local/desktop/src/implementation/recovery.ts`, `apps/local/desktop/src/implementation/reset.ts`
  - Diagnostics export & manifest excerpt: `apps/local/desktop/src/implementation/diagnostics.ts`, `e2e/tests/desktop-release.spec.ts`

## Apps

- `/docs/apps/add` (`apps/docs/content/apps/add.md`)
  - Dashboard Add app & catalog: `packages/ui/src/implementation/dashboard/add-app.tsx`, `packages/ui/src/implementation/dashboard/catalog.tsx`, `packages/catalog/src/contracts/catalog.ts`, `apps/local/server/src/implementation/dashboard.ts`
  - Remote MCP server import: `packages/ui/src/implementation/dashboard/custom-app.tsx`, `packages/catalog/src/contracts/imports.ts`, `packages/catalog/src/implementation/mcp.ts`, `apps/local/web/src/implementation/components/add-app.tsx`, `apps/hosted/web/src/implementation/components/add-app.tsx`
  - From scratch agent setup & permissions: `packages/ui/src/implementation/dashboard/agent-setup.tsx`, `packages/ui/src/implementation/dashboard/scoped-connections.tsx`, `apps/hosted/web/src/implementation/components/grant-choices.tsx`, `packages/app-management/src/http.ts`, `apps/hosted/server/src/app-management.ts`
  - CLI commands & host selection: `packages/app-management/src/cli.ts`, `packages/app-management/src/implementation/hosts.ts`, `packages/app-management/src/implementation/node-auth.ts`
  - Hello app example: `packages/app-templates/executor/skills/app-authoring/tools.md`

- `/docs/apps/publish` (`apps/docs/content/apps/publish.md`)
  - Registry validation, limits & snapshot resolution: `packages/sdk/src/contracts/registry.ts`, `packages/sdk/src/implementation/registry.ts`, `packages/sdk/src/contracts/source.ts`
  - Hosted publish permissions & UI: `apps/hosted/server/src/app-management.ts`, `packages/app-management/src/http.ts`, `apps/hosted/web/src/implementation/pages/app-detail.tsx`, `apps/local/web/src/implementation/pages/app-detail.tsx`, `packages/ui/src/implementation/dashboard/publish-app.tsx`
  - CLI publish, catalog, install & host selection: `packages/app-management/src/cli.ts`, `packages/app-management/src/implementation/hosts.ts`, `packages/app-management/src/implementation/node-auth.ts`, `apps/local/server/src/implementation/server.ts`, `apps/hosted/self-host/src/implementation/executor-services.ts`
  - End-to-end publish/install sequence: `e2e/tests/package-scopes.spec.ts`, `e2e/tests/add-app-registry.spec.ts`

- `/docs/apps/source-and-git` (`apps/docs/content/apps/source-and-git.md`)
  - Dashboard Source tab & History: `packages/ui/src/implementation/dashboard/app-workspace.tsx`, `packages/app-management/src/implementation/source-display.ts`, `packages/app-source/src/implementation/git-repositories.ts`, `packages/app-source/src/implementation/protected-git.ts`
  - CLI Git, credential helper & snapshot commands: `packages/app-management/src/cli.ts`, `packages/app-management/src/http.ts`, `packages/app-management/src/implementation/hosts.ts`, `packages/app-management/src/implementation/node-auth.ts`, `apps/local/server/src/implementation/app-management.ts`, `apps/hosted/cloud/src/infrastructure/stage.ts`
  - End-to-end Git & CLI deploy fixtures: `e2e/tests/app-git-remotes.spec.ts`, `e2e/support/apps-cli.ts`, `e2e/tests/local-apps-cli.spec.ts`

- `/docs/apps/executor-app` (`apps/docs/content/apps/executor-app.md`)
  - Built-in app & managed key eligibility/renewal: `apps/hosted/server/src/implementation/organization-defaults.ts`, `apps/hosted/server/src/implementation/managed-key-eligibility.ts`, `apps/hosted/server/src/implementation/managed-executor-key.ts`, `apps/hosted/server/src/implementation/executor-app.ts`, `apps/hosted/cloud/src/implementation/default-app.ts`, `apps/hosted/self-host/src/implementation/executor-services.ts`, `e2e/tests/executor-managed-key.spec.ts`
  - Local built-in app & management surface: `apps/local/server/src/implementation/executor-app.ts`, `apps/local/server/src/contracts/management.ts`, `apps/local/server/src/contracts/app-management.ts`, `packages/app-management/src/contracts/api.ts`
  - Hosted API & tokens: `apps/hosted/server/src/contracts/api.ts`, `apps/hosted/server/src/contracts/apps.ts`, `apps/hosted/server/src/contracts/organization.ts`, `apps/hosted/web/src/implementation/pages/tokens.tsx`
  - Feedback tool: `apps/hosted/server/src/implementation/feedback.ts`, `apps/hosted/cloud/src/implementation/product-analytics.ts`, `apps/hosted/self-host/src/implementation/product-analytics.ts`, `apps/local/server/src/implementation/server.ts`
  - Entry skill & catalog example: `packages/app-templates/executor/skills/executor/SKILL.md`

## Automation

- `/docs/workflows` (`apps/docs/content/workflows.md`)
  - Workflow API, SQL transactions & limits: `packages/apps/src/contracts/workflows.ts`, `packages/apps/src/implementation/workflows.ts`, `packages/apps/src/contracts/sql.ts`, `packages/apps/src/implementation/sql.ts`, `packages/apps/src/contracts/context.ts`, `packages/apps/src/implementation/workflow-context.ts`, `packages/sdk/src/implementation/workflows.ts`
  - Dashboard & hosted access checks: `packages/ui/src/implementation/dashboard/app-workflows.tsx`, `apps/hosted/server/src/implementation/workflows.ts`, `apps/hosted/server/src/implementation/workflow-access.ts`, `apps/hosted/server/src/implementation/access.ts`
  - Example adapted from: `e2e/support/workflow-app.ts`

- `/docs/schedules` (`apps/docs/content/schedules.md`)
  - Schedule constructors, validation & dispatcher: `packages/apps/src/contracts/schedules.ts`, `packages/apps/src/implementation/schedules.ts`, `packages/apps/src/implementation/operations.ts`, `packages/sdk/src/implementation/schedules.ts`, `packages/sdk/src/implementation/tool-approvals.ts`
  - Dashboard & permissions: `packages/ui/src/implementation/dashboard/schedules.tsx`, `apps/hosted/server/src/implementation/schedules.ts`, `apps/hosted/server/src/implementation/access.ts`, `apps/local/server/src/implementation/schedules.ts`
  - Example adapted from: `e2e/tests/app-schedules.spec.ts`, `e2e/tests/local-schedules.spec.ts`, `e2e/tests/scheduled-run-redeploy.spec.ts`

- `/docs/webhooks` (`apps/docs/content/webhooks.md`)
  - Webhook contracts, runtime & limits: `packages/apps/src/contracts/webhooks.ts`, `packages/apps/src/contracts/webhook-protocol.ts`, `packages/apps/src/index.ts`, `packages/sdk/src/implementation/webhooks.ts`, `packages/sdk/src/implementation/webhook-http.ts`, `packages/sdk/src/implementation/webhook-sources.ts`
  - Origins & service config: `apps/hosted/cloud/src/infrastructure/executor.ts`, `apps/hosted/self-host/src/implementation/bootstrap.ts`, `apps/hosted/self-host/src/implementation/executor-services.ts`, `apps/local/server/src/contracts/config.ts`, `apps/local/server/src/implementation/service-settings.ts`
  - Dashboard setup & authorization: `packages/ui/src/implementation/dashboard/webhooks.tsx`, `packages/ui/src/implementation/dashboard/webhook-setup.tsx`, `apps/hosted/server/src/implementation/webhook-setup.ts`, `apps/hosted/server/src/implementation/webhooks.ts`, `apps/local/server/src/implementation/webhook-setup.ts`
  - HMAC verification & manual setup example adapted from: `playground/demo-apps/issue-mail/webhooks.ts`, `packages/app-templates/executor/skills/app-authoring/webhooks.md`, `e2e/tests/app-account-webhooks.spec.ts`

## Skills & Cloud SSO

- `/docs/skills` (`apps/docs/content/skills.md`)
  - Skill loaders, router instructions & cache: `packages/apps/src/skills.ts`, `packages/apps/src/contracts/skills.ts`, `packages/apps/src/implementation/skills.ts`, `packages/apps/src/implementation/skill-files.ts`, `packages/apps/src/implementation/router-catalog.ts`, `packages/apps/src/implementation/host.ts`, `packages/apps/src/implementation/catalog-cache.ts`
  - MCP `skills` tool & Skills extension: `packages/mcp/src/contracts/skills.ts`, `packages/mcp/src/implementation/skills.ts`, `packages/mcp/src/implementation/skill-catalog.ts`, `packages/sdk/src/implementation/skills.ts`, `packages/sdk/src/implementation/declarations.ts`
  - Dashboard editor & reader: `packages/ui/src/implementation/dashboard/skill-workspace.tsx`, `packages/ui/src/implementation/dashboard/skill-editor.tsx`, `packages/ui/src/implementation/dashboard/app-skills.tsx`
  - CLI & examples: `packages/app-management/src/tools-cli.ts`, `packages/app-management/src/cli.ts`, `e2e/tests/mcp-skills-extension.spec.ts`, `e2e/tests/skill-folder.spec.ts`, `e2e/tests/dynamic-skills.spec.ts`, `e2e/tests/cli-tool-commands.spec.ts`

- `/docs/cloud/sso` (`apps/docs/content/cloud/sso.md`)
  - Cloud SSO plugin, provisioning, encryption & SAML config: `apps/hosted/cloud/src/implementation/sso.ts`, `apps/hosted/cloud/src/implementation/auth-options.ts`, `apps/hosted/cloud/src/implementation/billing.ts`
  - Cloud UI & sign-in flows: `apps/hosted/cloud/web/src/implementation/components/sso-settings.tsx`, `apps/hosted/cloud/web/src/contracts/sso.ts`, `apps/hosted/cloud/web/src/contracts/auth.ts`, `apps/hosted/cloud/web/src/implementation/routes/org.$organizationSlug.organization.tsx`
  - Self-host OIDC reference: `apps/hosted/self-host/src/implementation/auth-options.ts`
  - End-to-end tests: `e2e/tests/cloud-sso.spec.ts`, `apps/hosted/testing/sso-idp.ts`
