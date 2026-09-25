/** A target's applicability is explicit. Missing evidence never implies N/A. */
import { Schema } from "effect";
import type { Target } from "./report-model.ts";

/** Scheduled tests need a real result; other dispositions explain why none is expected. */
export const TargetPlan = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("scheduled"),
    runtime: Schema.optional(Schema.Literals(["managed", "attached"])),
  }),
  Schema.Struct({ status: Schema.Literal("not-applicable"), reason: Schema.NonEmptyString }),
  Schema.Struct({ status: Schema.Literal("not-run"), reason: Schema.NonEmptyString }),
]);
/** Snapshot this plan in a report so later configuration changes cannot rewrite its meaning. */
export const TestPlan = Schema.Struct({
  file: Schema.String,
  title: Schema.String,
  fixtures: Schema.optional(Schema.Literals(["actors", "cli"])),
  appOrigin: Schema.optional(Schema.Literal(true)),
  managementProfiles: Schema.optional(Schema.Array(Schema.Literals(["owner", "admin", "member"]))),
  targets: Schema.Struct({ "self-host": TargetPlan, local: TargetPlan, cloud: TargetPlan }),
});
const scheduled = { status: "scheduled" } as const;
const managedCloud = { status: "scheduled", runtime: "managed" } as const;
const na = (reason: string) => ({ status: "not-applicable", reason }) as const;
const cloudOnboarding = {
  cloud: scheduled,
  "self-host": na(
    "Self-host has instance setup and password/SSO admission instead of Cloud onboarding.",
  ),
  local: na("Local uses device pairing instead of Cloud account onboarding."),
};

/** Scenario names and applicability used by both test declarations and test selection. */
export const scenarios = {
  workflowReplayAccess: {
    fixtures: "actors",
    file: "workflow-replay-access.spec.ts",
    title: "workflow replay checks retained account access after profile rebinding",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario exercises hosted account sharing and profile authorization."),
    },
  },
  activeDeploymentTools: {
    fixtures: "actors",
    file: "active-deployment-tools.spec.ts",
    title: "Hosted new tool calls reject retired deployments and preserve active approval policy",
    targets: { "self-host": scheduled, cloud: scheduled, local: na("Hosted authorization policy") },
  },
  activeDeploymentResume: {
    fixtures: "actors",
    file: "active-deployment-tools.spec.ts",
    title: "Hosted MCP resumes pinned approvals after promotion with current authorization",
    targets: { "self-host": scheduled, cloud: scheduled, local: na("Hosted authorization policy") },
  },
  graphqlPublicCache: {
    fixtures: "actors",
    file: "graphql-cache.spec.ts",
    title: "Public GraphQL profiles share metadata while query results remain live",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback introspection fixture"),
      local: na("Hosted app deployment scenario"),
    },
  },
  graphqlCatalogCache: {
    fixtures: "actors",
    file: "graphql-cache.spec.ts",
    title:
      "GraphQL catalogs reuse introspection and refresh isolated query and mutation definitions",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback introspection fixture"),
      local: na("Hosted app deployment scenario"),
    },
  },
  mcpCatalogCache: {
    fixtures: "actors",
    file: "mcp-catalog.spec.ts",
    title: "MCP catalog cache skips repeated discovery and revalidates account revisions",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback default; external emulators.dev fixture used for remote measurement"),
      local: na("Hosted deployment API scenario"),
    },
  },
  mcpCatalogRefresh: {
    fixtures: "actors",
    file: "mcp-catalog.spec.ts",
    title: "MCP catalog notifications invalidate schemas and failed refreshes retain values",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback notification fixture"),
      local: na("Hosted deployment API scenario"),
    },
  },
  liveOpenapi: {
    fixtures: "actors",
    file: "live-openapi.spec.ts",
    title: "Live OpenAPI refreshes operations while preserving static credential placement",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback upstream fixture; deployed Cloud API benchmark covers the live runtime"),
      local: na("Hosted deployment API scenario"),
    },
  },
  liveOpenapiCache: {
    fixtures: "actors",
    file: "live-openapi-cache.spec.ts",
    title: "Live OpenAPI reuses fresh definitions and validates input before dispatch",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback upstream fixture; deployed Cloud API benchmark covers the live runtime"),
      local: na("Hosted deployment API scenario"),
    },
  },
  dynamicOnlyApp: {
    fixtures: "actors",
    file: "dynamic-only-app.spec.ts",
    title: "Dynamic-only apps resolve and call tools without a static catalog",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted profile API fixture; Node adapter exercised by self-host"),
    },
  },
  appCacheAccounts: {
    fixtures: "actors",
    file: "app-cache-accounts.spec.ts",
    title: "App cache isolates accounts, credential rotations and profile access",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted profile API fixture; Node adapter exercised by self-host"),
    },
  },
  appCache: {
    fixtures: "actors",
    file: "app-cache.spec.ts",
    title: "App cache shares values, coalesces loads and retains values after refresh failure",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted profile API fixture; Node adapter exercised by self-host"),
    },
  },
  appCacheFences: {
    fixtures: "actors",
    file: "app-cache-fences.spec.ts",
    title: "App cache fences invalidated loaders and retains background refreshes",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted profile API fixture; Node adapter exercised by self-host"),
    },
  },
  cloudImpersonation: {
    fixtures: "actors",
    file: "cloud-impersonation.spec.ts",
    title: "Platform admin impersonation uses the shared widget and restores the original session",
    targets: {
      cloud: managedCloud,
      "self-host": na("Cloud platform operator controls"),
      local: na("Local has browser pairing instead of hosted identities"),
    },
  },
  mcpMemoryBurst: {
    fixtures: "actors",
    file: "mcp-memory-burst.spec.ts",
    title: "MCP subscriptions survive a reconnect burst",
    targets: {
      cloud: { status: "scheduled", runtime: "attached" },
      "self-host": na("Cloudflare Durable Object memory investigation"),
      local: na("Cloudflare Durable Object memory investigation"),
    },
  },
  mcpMemoryShared: {
    fixtures: "actors",
    file: "mcp-memory-shared.spec.ts",
    title: "MCP subscriptions survive concurrent clients on one session",
    targets: {
      cloud: { status: "scheduled", runtime: "attached" },
      "self-host": na("Cloudflare Durable Object memory investigation"),
      local: na("Cloudflare Durable Object memory investigation"),
    },
  },
  mcpMemory: {
    fixtures: "actors",
    file: "mcp-memory.spec.ts",
    title: "MCP subscriptions survive idle sessions and reconnect churn",
    targets: {
      cloud: { status: "scheduled", runtime: "attached" },
      "self-host": na("Cloudflare Durable Object memory investigation"),
      local: na("Cloudflare Durable Object memory investigation"),
    },
  },
  toolsErrorState: {
    fixtures: "actors",
    file: "tools-error-state.spec.ts",
    title: "Tools errors explain discovery failures and preserve retry on desktop and mobile",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("The hosted Tools page owns this error presentation."),
    },
  },
  testingCli: {
    fixtures: "cli",
    file: "testing-cli.spec.ts",
    title: "Testing CLI owns scenario creation, role requests, population and teardown",
    targets: {
      "self-host": scheduled,
      local: scheduled,
      cloud: na(
        "CLI transport uses local products; shared SDK Cloud operations are covered by the populated scenario.",
      ),
    },
  },
  testingSdk: {
    fixtures: "actors",
    file: "testing-sdk.spec.ts",
    title: "Testing SDK isolates overlapping populated organizations and cleans failed scenarios",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no organizations; its scenario lifecycle uses independent processes."),
    },
  },
  cloudSsoOidc: {
    fixtures: "actors",
    file: "cloud-sso.spec.ts",
    title: "Cloud SSO OIDC setup preserves drafts and binds verified identities to one team",
    targets: {
      cloud: managedCloud,
      "self-host": na("Cloud customer SSO"),
      local: na("Cloud customer SSO"),
    },
  },
  cloudSsoSaml: {
    fixtures: "actors",
    file: "cloud-sso.spec.ts",
    title: "Cloud SSO SAML accepts signed assertions and rejects tampering and replay",
    targets: {
      cloud: managedCloud,
      "self-host": na("Cloud customer SSO"),
      local: na("Cloud customer SSO"),
    },
  },
  localBootstrap: {
    file: "local-bootstrap.spec.ts",
    title: "local first launch saves OS credentials, survives restart and refuses missing keys",
    targets: {
      local: {
        status: "not-run",
        reason: "Runs against the installed release archive with local-bootstrap.config.ts.",
      },
      cloud: na("Local OS credential setup"),
      "self-host": na("Local OS credential setup"),
    },
  },
  memberControls: {
    fixtures: "actors",
    file: "member-controls.spec.ts",
    title: "Member restrictions keep controls visible and the app overview stable",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no organization member roles."),
    },
  },
  memberControlsMobile: {
    fixtures: "actors",
    file: "member-controls.spec.ts",
    title: "Mobile member restrictions keep controls visible and the app overview stable",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no organization member roles."),
    },
  },
  localStartupObservability: {
    file: "local-startup-observability.spec.ts",
    title: "local startup failures retain their resource phase and safe system code",
    targets: {
      local: scheduled,
      cloud: na("Local process startup"),
      "self-host": na("Local process startup"),
    },
  },
  optimisticObservability: {
    fixtures: "actors",
    file: "optimistic-observability.spec.ts",
    appOrigin: true,
    title: "optimistic replay failures are delivered without changing a submitted write",
    targets: {
      cloud: scheduled,
      "self-host": scheduled,
      local: na("Shared app client covered on hosted targets"),
    },
  },
  browserObservability: {
    fixtures: "actors",
    file: "browser-observability.spec.ts",
    title: "browser decode and startup failures reach correlated error collectors",
    targets: {
      cloud: managedCloud,
      "self-host": na("Cloud Sentry receiver"),
      local: na("Cloud Sentry receiver"),
    },
  },
  emptyStateRecovery: {
    fixtures: "actors",
    file: "empty-state-recovery.spec.ts",
    title: "Empty states preserve drafts and respect app permissions",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted authoring and membership scenario."),
    },
  },
  emptyAccountSearch: {
    fixtures: "actors",
    file: "empty-state-recovery.spec.ts",
    title: "Empty account searches can be cleared without losing selections",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Shared picker exercised through hosted connections."),
    },
  },
  emptyStateMcp: {
    fixtures: "actors",
    file: "empty-state-mcp.spec.ts",
    title: "Empty organization consent offers a valid self-host recovery",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud routes new users through team setup."),
      local: na("Local uses pairing."),
    },
  },
  seatOnlyBilling: {
    fixtures: "actors",
    file: "seat-only-billing.spec.ts",
    title: "Seat-only billing runs HTTP and MCP without an execution balance",
    targets: {
      "self-host": na("Billing is cloud only."),
      cloud: scheduled,
      local: na("Billing is cloud only."),
    },
  },
  emptyStateBilling: {
    fixtures: "actors",
    file: "empty-state-billing.spec.ts",
    title: "Empty billing catalog can be refreshed",
    targets: {
      "self-host": na("Billing is cloud only."),
      cloud: scheduled,
      local: na("Billing is cloud only."),
    },
  },
  emptyStates: {
    fixtures: "actors",
    file: "empty-states.spec.ts",
    title: "Empty states guide first use and recover from filters",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted role and group flows; shared presentation is covered on self-host."),
    },
  },
  sourceHighlighting: {
    fixtures: "actors",
    file: "source-highlighting.spec.ts",
    title: "Source browser highlights CSS, Markdown, JSON, and HTML files",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("The shared source browser is exercised through hosted organization routes."),
    },
  },
  appFilters: {
    fixtures: "actors",
    file: "app-filters.spec.ts",
    title: "App filters retain cards through loading, failure and retry",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no group or access filters."),
    },
  },
  sdkQueryBudgets: {
    fixtures: "actors",
    file: "sdk-query-budgets.spec.ts",
    title: "SDK batches invocation accounts and finished workflow history",
    targets: {
      "self-host": scheduled,
      cloud: na("This query budget reads the self-host Motel collector."),
      local: na("This scenario uses hosted organization routes."),
    },
  },
  toolAccountContext: {
    fixtures: "actors",
    file: "tool-account-context.spec.ts",
    title: "Tools identify their accounts and replace catalogs after account selection",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local uses its paired scenario."),
    },
  },
  localToolAccountContext: {
    file: "local-tool-account-context.spec.ts",
    title: "Local tools identify their accounts and replace catalogs after account selection",
    targets: {
      local: scheduled,
      "self-host": na("Hosted uses its organization scenario."),
      cloud: na("Hosted uses its organization scenario."),
    },
  },
  appBrowser: {
    fixtures: "actors",
    file: "app-browser.spec.ts",
    title: "App browser shows skill and workflow overviews",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local uses its paired dashboard scenario."),
    },
  },
  localAppBrowser: {
    file: "local-app-browser.spec.ts",
    title: "Local app browser shows skill and workflow overviews",
    targets: {
      local: scheduled,
      "self-host": na("Hosted uses its member dashboard scenario."),
      cloud: na("Hosted uses its member dashboard scenario."),
    },
  },
  memberGroupVisibility: {
    fixtures: "actors",
    file: "group-visibility.spec.ts",
    title: "Members only see and share into their own groups",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no organization groups."),
    },
  },
  devtoolsMembers: {
    file: "devtools-members.spec.ts",
    title: "Local dev tools bootstrap an operator and use native impersonation",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "The shared picker is exercised through the full self-host development entry point.",
      ),
      local: na("Local has pairing instead of organization members."),
    },
  },
  groupAuthoring: {
    fixtures: "actors",
    file: "resource-access.spec.ts",
    appOrigin: true,
    title: "Groups protect app drafts and independent copies",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no organization group policy."),
    },
  },
  resourceIsolation: {
    fixtures: "actors",
    file: "resource-isolation.spec.ts",
    title: "Group resource grants and account connections cannot cross organizations",
    targets: {
      "self-host": na(
        "Self-host permits one organization; real cross-organization grants are a Cloud scenario.",
      ),
      cloud: scheduled,
      local: na("Local has no organization sharing policy."),
    },
  },
  resourceSharing: {
    fixtures: "actors",
    file: "resource-sharing.spec.ts",
    title: "Group sharing forms retain drafts and recover stale edits on desktop and mobile",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no organization sharing policy."),
    },
  },
  resourceAccess: {
    fixtures: "actors",
    file: "resource-access.spec.ts",
    title: "Groups enforce private app access and live membership changes",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no organization sharing policy."),
    },
  },
  arrayResourceAccess: {
    fixtures: "actors",
    file: "resource-access.spec.ts",
    appOrigin: true,
    title: "Array accounts enforce complete access through API and private UI",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no organization sharing policy."),
    },
  },
  arrayResourceDeletion: {
    fixtures: "actors",
    file: "resource-access.spec.ts",
    appOrigin: true,
    title: "Array account deletion preserves authoring access and clears profile bindings",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no organization sharing policy."),
    },
  },
  publishingDialog: {
    fixtures: "actors",
    file: "publishing-dialog.spec.ts",
    title: "Publishing dialog explains readiness and keeps copied listings separate",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "The shared dialog is checked with response fixtures on self-host; registry authorization has separate integration coverage.",
      ),
      local: na("Local does not publish apps."),
    },
  },
  appPackageMetadata: {
    fixtures: "actors",
    file: "app-package-metadata.spec.ts",
    title: "App templates retain package names independently of installed labels",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "This scenario uses a loopback upstream; hosted templates share the same implementation.",
      ),
      local: na("This scenario exercises the hosted import API."),
    },
  },
  openapiUserAgent: {
    fixtures: "actors",
    file: "openapi-user-agent.spec.ts",
    title: "Imported OpenAPI PAT calls supply User-Agent and preserve explicit client headers",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a loopback upstream to exercise the shared Worker OpenAPI transport."),
      local: na("Exercises the hosted import and account connection APIs."),
    },
  },
  templateAccounts: {
    fixtures: "actors",
    file: "template-accounts.spec.ts",
    title: "Imported templates route shared tools to explicitly selected accounts",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses loopback upstream fixtures for the shared protocol templates."),
      local: na("Exercises the hosted import and profile APIs."),
    },
  },
  cloudDashboardRoutes: {
    file: "cloud-dashboard-routes.spec.ts",
    title: "Cloud dashboard deep links preserve API, docs and asset routing",
    targets: {
      cloud: scheduled,
      "self-host": na("Cloudflare's static asset rewrites are Cloud-only."),
      local: na("Cloudflare's static asset rewrites are Cloud-only."),
    },
  },
  appPackage: {
    fixtures: "actors",
    file: "app-package.spec.ts",
    title: "App builds retain their selected npm framework across rebuilds",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "This local tarball fixture is served on loopback; self-host exercises the shared Worker compiler.",
      ),
      local: na(
        "This scenario uses hosted routes; Local shares the same workerd compiler and runtime.",
      ),
    },
  },
  productAnalytics: {
    fixtures: "actors",
    file: "product-analytics.spec.ts",
    title: "Cloud product events preserve identity and dashboard replay masks private data",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host does not export product analytics or replay."),
      local: na("Local does not export product analytics or replay."),
    },
  },
  feedback: {
    fixtures: "actors",
    file: "feedback.spec.ts",
    title: "Cloud feedback enforces its API contract and reaches the local ingestion service",
    targets: {
      cloud: managedCloud,
      "self-host": na("PostHog feedback belongs to Cloud."),
      local: na("PostHog feedback belongs to Cloud."),
    },
  },
  groupFormErrors: {
    fixtures: "actors",
    file: "groups.spec.ts",
    title: "Group forms show field errors and retain drafts through failed saves",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no organization groups."),
    },
  },
  passwordRefresh: {
    fixtures: "actors",
    file: "password-refresh.spec.ts",
    title: "Password sign-in retains its draft through tab-focus session checks",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud uses provider and code sign-in instead of passwords."),
      local: na("Local uses pairing instead of hosted login."),
    },
  },
  emailCodeRefresh: {
    file: "email-code-refresh.spec.ts",
    title: "Cloud sign-in retains its code through tab-focus session checks",
    targets: {
      cloud: scheduled,
      "self-host": na("Self-host uses passwords instead of email codes."),
      local: na("Local uses pairing instead of hosted login."),
    },
  },
  groups: {
    fixtures: "actors",
    file: "groups.spec.ts",
    title: "Groups persist atomic membership edits and enforce current admin permissions",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no organizations or groups."),
    },
  },
  groupsIsolation: {
    fixtures: "actors",
    file: "groups.spec.ts",
    title: "Group identities and memberships cannot cross organization boundaries",
    targets: {
      cloud: scheduled,
      "self-host": na(
        "Self-host permits only one organization; foreign organization references are checked in the shared groups scenario.",
      ),
      local: na("Local has no organizations or groups."),
    },
  },
  openapiPaths: {
    fixtures: "actors",
    file: "openapi-paths.spec.ts",
    title: "OpenAPI path parameters cannot escape a narrowed MCP tool grant",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a controlled loopback HTTP API through the shared Worker runtime."),
      local: na("Hosted MCP grant narrowing is verified on self-host."),
    },
  },
  openapiErrors: {
    fixtures: "actors",
    file: "openapi-errors.spec.ts",
    title: "OpenAPI errors preserve declared details through MCP without leaking response bodies",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a controlled loopback HTTP API through the shared Worker runtime."),
      local: na("The shared OpenAPI and MCP error path is covered on self-host."),
    },
  },
  providerErrors: {
    fixtures: "actors",
    file: "provider-errors.spec.ts",
    title: "Provider failures retain safe reasons and account recovery across protocols",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses controlled loopback providers through the shared runtime contract."),
      local: na("Shared error views and SDK are exercised through hosted APIs."),
    },
  },
  graphqlCatalogImport: {
    fixtures: "actors",
    file: "graphql-catalog.spec.ts",
    title: "GraphQL catalog import hides CLI entries and connects account tools",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a loopback GraphQL upstream to verify the shared catalog importer."),
      local: na("The shared catalog form is exercised through hosted installation."),
    },
  },
  cloudCatalogInstall: {
    fixtures: "actors",
    file: "cloud-compiler.spec.ts",
    title: "Cloud catalog installs Axiom through the browser and reaches account setup",
    targets: {
      cloud: scheduled,
      "self-host": na("This scenario measures the Cloud catalog installation path."),
      local: na("This scenario measures the Cloud catalog installation path."),
    },
  },
  cloudCompilerDependencies: {
    fixtures: "actors",
    file: "cloud-compiler.spec.ts",
    title: "Cloud compiler installs imported packages and preserves source manifests",
    targets: {
      cloud: scheduled,
      "self-host": na("This scenario exercises the Cloud compiler dependency resolver."),
      local: na("This scenario exercises the Cloud compiler dependency resolver."),
    },
  },
  cloudCompilerMemory: {
    fixtures: "actors",
    file: "cloud-compiler.spec.ts",
    title: "Cloud compiler memory failures preserve the active deployment",
    targets: {
      cloud: { status: "scheduled", runtime: "attached" },
      "self-host": na("This scenario requires Cloudflare's compiler Worker memory limit."),
      local: na("This scenario requires Cloudflare's compiler Worker memory limit."),
    },
  },
  requestTiming: {
    fixtures: "actors",
    file: "request-timing.spec.ts",
    title: "Cloud request timings correlate browser resources with the server trace",
    targets: {
      cloud: scheduled,
      "self-host": na("Cloudflare lifecycle spans belong to the cloud host."),
      local: na("Cloudflare lifecycle spans belong to the cloud host."),
    },
  },
  oauthCompatibility: {
    fixtures: "actors",
    file: "oauth-compatibility.spec.ts",
    title:
      "OAuth accepts compatible registration and token variants, classifies registration failures, and keeps token validation",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer with controlled wire responses."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  importDiagnostics: {
    fixtures: "actors",
    managementProfiles: ["owner"],
    file: "import-diagnostics.spec.ts",
    title: "OpenAPI imports distinguish download, parse and generation failures safely",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a loopback definition host to exercise the shared importer."),
      local: na("The shared importer is exercised through the hosted import route."),
    },
  },
  setupDiagnostics: {
    fixtures: "actors",
    file: "setup-diagnostics.spec.ts",
    title: "Setup failures deliver safe catalog and OAuth diagnostics",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer to provoke safe diagnostic failures."),
      local: na("Exercises shared catalog and OAuth instrumentation through hosted APIs."),
    },
  },
  mcpAuthDiscovery: {
    fixtures: "actors",
    file: "mcp-auth-discovery.spec.ts",
    title: "MCP imports defer discovery and OAuth setup honors POST authentication challenges",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback MCP issuer."),
      local: na("Exercises the shared import and OAuth implementation through hosted APIs."),
    },
  },
  mcpDeferredSetup: {
    fixtures: "actors",
    file: "mcp-deferred-setup.spec.ts",
    title: "MCP outages preserve added apps and recover in account setup and tools",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses controlled loopback MCP and OAuth servers through shared product code."),
      local: na(
        "Shared import, connection, and error views are verified through the hosted product.",
      ),
    },
  },
  oauthUrlPolicy: {
    fixtures: "actors",
    file: "oauth-url-policy.spec.ts",
    title: "OAuth setup honors host URL policy and named loopback callbacks",
    targets: {
      "self-host": scheduled,
      local: na(
        "This journey uses hosted account routes and managed self-host URL policy configuration.",
      ),
      cloud: na("This journey requires explicit managed self-host HTTP origin exceptions."),
    },
  },
  oauthProvisioning: {
    file: "oauth-provisioning.spec.ts",
    title: "OAuth resources are provisioned before client registration",
    targets: { local: scheduled, "self-host": scheduled, cloud: scheduled },
  },
  workspaceSource: {
    fixtures: "actors",
    file: "workspace-source.spec.ts",
    title: "Workspace reads reuse confirmed source and preserve concurrent writes",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("The shared source contract is exercised through hosted organization routes."),
    },
  },
  historicalSource: {
    fixtures: "actors",
    file: "historical-source.spec.ts",
    title: "Historical source deploys without downloading later revisions",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("The shared source contract is exercised through hosted organization routes."),
    },
  },
  appCopies: {
    fixtures: "actors",
    file: "app-copies.spec.ts",
    title: "App copies use running source and remain independent through edits and navigation",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted role checks use organization actors; local Git is covered separately."),
    },
  },
  lastOrganization: {
    file: "last-organization.spec.ts",
    title: "Last active organization survives entry and rename while stale destinations recover",
    targets: cloudOnboarding,
  },
  heroExperiments: {
    file: "hero-experiments.spec.ts",
    title: "Hero experiments render stable HTML and isolate previews",
    targets: cloudOnboarding,
  },
  betaNotice: {
    fixtures: "actors",
    file: "beta-notice.spec.ts",
    title: "Marketing preview opens once and beta banners reopen it across homepage and dashboard",
    targets: {
      cloud: scheduled,
      "self-host": na("The cloud beta notice is not shown on self-host."),
      local: na("The cloud beta notice is not shown in the local dashboard."),
    },
  },
  deploymentLinks: {
    fixtures: "actors",
    file: "deployment-links.spec.ts",
    title: "Cloud product links follow the deployment origin",
    targets: {
      cloud: scheduled,
      "self-host": na("Self-host uses public docs and does not serve the marketing site."),
      local: na("Local uses public docs and does not serve the marketing site."),
    },
  },
  teamCreateRoute: {
    fixtures: "actors",
    file: "team-create-route.spec.ts",
    title: "Team setup routing waits for membership and redirects existing members",
    targets: cloudOnboarding,
  },
  signInEntry: {
    fixtures: "actors",
    file: "sign-in-entry.spec.ts",
    title: "Sign-in completion selects destinations before loading a page",
    targets: cloudOnboarding,
  },
  rootEntryLoading: {
    fixtures: "actors",
    file: "root-entry-loading.spec.ts",
    title:
      "Signed-in root restores Apps before organization lookup without reloading on canonical navigation",
    targets: cloudOnboarding,
  },
  localQueryState: {
    file: "local-query-state.spec.ts",
    title: "Local forms retain drafts through live read failures and reset for another resource",
    targets: {
      local: scheduled,
      "self-host": na("This journey checks local storage subscriptions and pairing."),
      cloud: na("This journey checks local storage subscriptions and pairing."),
    },
  },
  accountConnectionQuery: {
    fixtures: "actors",
    file: "account-connection-query.spec.ts",
    title: "Account connection stays in the app and loads its tools without a page refresh",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This journey checks hosted account connection and app query invalidation."),
    },
  },
  localAppLaunch: {
    file: "local-app-launch.spec.ts",
    title: "local app launch chooses accounts per tab and opens no-provider apps directly",
    targets: {
      local: scheduled,
      "self-host": na("Hosted app launch is checked with scalar and array choices."),
      cloud: na("Hosted app launch is checked with scalar and array choices."),
    },
  },
  localResources: {
    file: "local-resources.spec.ts",
    title: "local account groups run workflows and no-provider apps need no profile",
    targets: {
      local: scheduled,
      "self-host": na("Paired local dashboard."),
      cloud: na("Paired local dashboard."),
    },
  },
  groupedResources: {
    fixtures: "actors",
    file: "grouped-resources.spec.ts",
    title:
      "account groups isolate workflow starts and webhook configuration while retaining disabled history",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local resource controls have a separate paired-browser scenario."),
    },
  },
  groupedAccounts: {
    fixtures: "actors",
    file: "grouped-accounts.spec.ts",
    title: "profile selection loads the full catalog and pins tool calls",
    targets: {
      local: na("Hosted browser runner; local lifecycle is covered separately."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  appAccountPicker: {
    fixtures: "actors",
    file: "app-account-picker.spec.ts",
    title:
      "App account picker saves in place, retains failed choices and supports multiple accounts",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted app account controls and organization permissions."),
    },
  },
  oauthClientRecovery: {
    fixtures: "actors",
    file: "oauth-client-recovery.spec.ts",
    title:
      "Rejected OAuth clients remain editable and replacements commit only after successful sign-in",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Hosted callback routing and saved-client management."),
    },
  },
  oauthImportedClientSecret: {
    fixtures: "actors",
    file: "oauth-imported-client-secret.spec.ts",
    title: "Imported OpenAPI OAuth asks for a client secret and completes sign-in with it",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer and OpenAPI upstream."),
      local: na("Exercises the hosted import and callback routing."),
    },
  },
  oauthConnectStoryboard: {
    fixtures: "actors",
    file: "oauth-connect-storyboard.spec.ts",
    title: "OAuth connect storyboard captures loading, consent, success and recovery frames",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer for controlled capture."),
      local: na("Hosted account dialogs and callback recovery."),
    },
  },
  oauthSetupErrors: {
    fixtures: "actors",
    file: "oauth-setup-errors.spec.ts",
    title:
      "OAuth setup explains each discovery failure and preserves recovery on desktop and mobile",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer; hosted presentation is shared."),
      local: na("Local connection-link coverage is in the local OAuth scenario."),
    },
  },
  oauthErrorReport: {
    fixtures: "actors",
    file: "oauth-error-report.spec.ts",
    title: "Cloud tracks an unusable OAuth registration response with safe evidence",
    targets: {
      cloud: managedCloud,
      "self-host": na("Only Cloud records product failures for the Executor team."),
      local: na("Only Cloud records product failures for the Executor team."),
    },
  },
  localOAuth: {
    file: "local-oauth.spec.ts",
    title: "Local OAuth setup checks preserve grant boundaries and complete machine accounts",
    targets: {
      "self-host": na("Local dashboard and limited connection grants."),
      cloud: na("Local dashboard and limited connection grants."),
      local: scheduled,
    },
  },
  oauthPermissionsLayout: {
    fixtures: "actors",
    file: "oauth-permissions-layout.spec.ts",
    title:
      "OAuth permissions collapse and scroll within the connection dialog on desktop and mobile",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Checks the shared OAuth fields through the hosted connection dialog."),
    },
  },
  oauthClientForm: {
    fixtures: "actors",
    file: "oauth-client-credentials.spec.ts",
    title:
      "OAuth forms use provider configuration and recover a completed machine connection after response loss",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback token service."),
      local: na("Hosted modal and organization account reconciliation."),
    },
  },
  oauthClientCredentials: {
    fixtures: "actors",
    file: "oauth-client-credentials.spec.ts",
    title: "Client credentials connects without redirects and renews tokens with provider settings",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback token service."),
      local: na("Exercises shared OAuth through the hosted API."),
    },
  },
  oauthProviderConfig: {
    fixtures: "actors",
    file: "oauth-provider-config.spec.ts",
    title: "OAuth provider code controls scopes, resources, and client authentication",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Exercises shared OAuth through the hosted API."),
    },
  },
  oauthClientSetup: {
    fixtures: "actors",
    file: "oauth-client-setup.spec.ts",
    title:
      "OAuth client setup is read-only, cached, and explicit about required clients and failures",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer to inspect registration side effects."),
      local: na("Hosted organization policy and setup UI."),
    },
  },
  appAccountOAuth: {
    fixtures: "actors",
    file: "app-account-picker.spec.ts",
    title:
      "App account sign-in names the account before OAuth and returns cancellation to the same app",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted browser sign-in and callback recovery."),
    },
  },
  queryRefresh: {
    fixtures: "actors",
    file: "query-refresh.spec.ts",
    title: "Dashboard refresh preserves drafts through failed reads and recovery",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This journey checks hosted query refresh after organization identity resolution."),
    },
  },
  membersRefresh: {
    fixtures: "actors",
    file: "query-refresh.spec.ts",
    title: "Dashboard members retain their rows and invitation draft through refresh errors",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no hosted organization membership."),
    },
  },
  sessionHint: {
    fixtures: "actors",
    file: "session-hint.spec.ts",
    title: "Session hints paint early without granting access and clear on sign-out or expiry",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local uses pairing rather than hosted session cookies."),
    },
  },
  localAppDetailLoading: {
    file: "local-app-detail-loading.spec.ts",
    title: "Local desktop app navigation keeps a stable loading panel through live reads",
    targets: {
      local: scheduled,
      "self-host": na("This journey checks local pairing and live app reads."),
      cloud: na("This journey checks local pairing and live app reads."),
    },
  },
  localAppDetailLoadingMobile: {
    file: "local-app-detail-loading.spec.ts",
    title: "Local mobile app navigation keeps a stable loading panel through live reads",
    targets: {
      local: scheduled,
      "self-host": na("This journey checks local pairing and live app reads."),
      cloud: na("This journey checks local pairing and live app reads."),
    },
  },
  appDetailLoading: {
    fixtures: "actors",
    file: "app-detail-loading.spec.ts",
    title: "Desktop app detail navigation preserves its frame while metadata and tools load",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This journey checks hosted app metadata requests."),
    },
  },
  appDetailLoadingMobile: {
    fixtures: "actors",
    file: "app-detail-loading.spec.ts",
    title: "Mobile app detail navigation preserves its frame while metadata and tools load",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This journey checks hosted app metadata requests."),
    },
  },
  organizationIcon: {
    fixtures: "actors",
    file: "organization-icon.spec.ts",
    title: "Organization icon uploads and survives a settings reload",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Organization settings are hosted only."),
    },
  },
  settingsLoading: {
    fixtures: "actors",
    file: "settings-loading.spec.ts",
    title: "Settings loading keeps static labels and controls around unknown values",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Organization settings are hosted only."),
    },
  },
  apiKeysLoading: {
    fixtures: "actors",
    file: "settings-loading.spec.ts",
    title: "API keys loading keeps its page identity and reads tokens before metadata",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Personal tokens are hosted only."),
    },
  },
  dashboardLoading: {
    fixtures: "actors",
    file: "dashboard-loading.spec.ts",
    title: "Dashboard loading shows content skeletons without auth or organization gates",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This journey checks hosted session entry and organization references."),
    },
  },
  frameworkDiscovery: {
    fixtures: "actors",
    file: "framework-discovery.spec.ts",
    managementProfiles: ["owner"],
    title: "framework discovery exposes pinned contracts and linked authoring topics",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted discovery journey; local skills have separate MCP coverage."),
    },
  },
  frameworkAuthoring: {
    fixtures: "actors",
    file: "framework-authoring.spec.ts",
    managementProfiles: ["owner"],
    appOrigin: true,
    title: "framework discovery deploys its checked example with optimistic updates and rollback",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted discovery-to-browser journey; local skills have separate MCP coverage."),
    },
  },
  appPendingWrites: {
    fixtures: "actors",
    file: "app-pending-writes.spec.ts",
    appOrigin: true,
    title: "closing an app warns about queued optimistic deletes until writes settle",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("The shared browser client is exercised through hosted app authentication."),
    },
  },
  appUiDiscovery: {
    fixtures: "actors",
    managementProfiles: ["owner"],
    file: "app-ui.spec.ts",
    appOrigin: true,
    title: "MCP discovers private app URLs and preserves browser-only API boundaries",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted Better Auth and organization routes."),
    },
  },
  appUiAccess: {
    fixtures: "actors",
    file: "app-ui.spec.ts",
    appOrigin: true,
    title: "private app access revokes live sessions and supports complete DNS labels",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted Better Auth and organization routes."),
    },
  },
  appUi: {
    fixtures: "actors",
    file: "app-ui.spec.ts",
    appOrigin: true,
    title: "private app bookmarks authenticate and execute through the hosted runtime",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted Better Auth and organization routes."),
    },
  },
  appReload: {
    fixtures: "actors",
    file: "app-reload.spec.ts",
    appOrigin: true,
    title: "hosted apps reload on deployment and recover missed version notifications",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local already has a deployment watcher; this covers hosted app sessions."),
    },
  },
  appTailwind: {
    fixtures: "actors",
    file: "app-tailwind.spec.ts",
    appOrigin: true,
    title: "React app deployments compile Tailwind utilities and preserve ordinary styles",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na(
        "This scenario uses hosted deployment and app authentication; local shares the workerd compiler.",
      ),
    },
  },
  appObservability: {
    fixtures: "actors",
    file: "app-observability.spec.ts",
    appOrigin: true,
    title: "app query traces connect browser, streamed host work, runtime and React commits",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted deployment and app authentication."),
    },
  },
  appWarmQueries: {
    fixtures: "actors",
    file: "app-observability.spec.ts",
    appOrigin: true,
    title: "warm app queries export timing without reloading retained server builds",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted deployment and app authentication."),
    },
  },
  appRetryTraces: {
    fixtures: "actors",
    file: "app-observability.spec.ts",
    appOrigin: true,
    title: "app subscription retries retain failed attempts and native trace links",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted deployment and app authentication."),
    },
  },
  appStreamRevocation: {
    fixtures: "actors",
    file: "app-observability.spec.ts",
    appOrigin: true,
    title: "app query streams and retained assets enforce live access revocation",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted deployment and app authentication."),
    },
  },
  authObservability: {
    file: "auth-observability.spec.ts",
    title: "Cloud OAuth callbacks report safe failures and verified sessions with stage traces",
    targets: {
      cloud: managedCloud,
      "self-host": na("Cloud social sign-in instrumentation."),
      local: na("Cloud social sign-in instrumentation."),
    },
  },
  observabilityOutcomes: {
    fixtures: "actors",
    file: "observability-outcomes.spec.ts",
    title: "observability retains logical failures, large app traces and unsampled requests",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("This scenario uses hosted APIs; the runtime and collector are shared with Local."),
    },
  },
  appDomainStatus: {
    fixtures: "actors",
    file: "app-domain-status.spec.ts",
    appOrigin: true,
    title: "app domains show pending setup, retry failures and expose only ready links",
    targets: {
      cloud: scheduled,
      "self-host": na("Cloud provisions team certificates; self-host operators manage TLS."),
      local: na("Local app origins do not provision cloud certificates."),
    },
  },
  appUiFailures: {
    fixtures: "actors",
    file: "app-ui-failures.spec.ts",
    appOrigin: true,
    title: "private app failures stay visible and recover without losing drafts",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app deployment and browser authentication."),
    },
  },
  appUiFailureTelemetry: {
    fixtures: "actors",
    file: "app-ui-failures.spec.ts",
    appOrigin: true,
    title: "private app crash reports reach the host collector before authored telemetry starts",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app deployment and browser authentication."),
    },
  },
  executorKeyAccount: {
    fixtures: "actors",
    file: "executor-key-account.spec.ts",
    title: "Executor installs each user’s managed key without rebinding the shared app",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local uses its configured instance API key."),
    },
  },
  executorCustomization: {
    fixtures: "actors",
    managementProfiles: ["owner"],
    file: "executor-customization.spec.ts",
    title: "Executor customization preserves personal accounts through the browser and MCP",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local uses its configured instance API key."),
    },
  },
  executorInstallationLoading: {
    fixtures: "actors",
    file: "executor-key-account.spec.ts",
    title: "Executor installation shows progress and preserves search through failure and retry",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local uses its configured instance API key."),
    },
  },
  executorAppCardAccount: {
    fixtures: "actors",
    file: "executor-key-account.spec.ts",
    title: "Executor app card shows the current user's profile account",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local uses its configured instance API key."),
    },
  },
  sharedAuthorization: {
    fixtures: "actors",
    file: "shared-authorization.spec.ts",
    title: "API grants enforce exact tool selection and audience boundaries",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario checks hosted API and MCP parity."),
    },
  },
  apiGrantRestrictions: {
    fixtures: "actors",
    file: "api-grant-restrictions.spec.ts",
    title: "API grants retain exact selections through deployment, refresh and live narrowing",
    targets: { "self-host": scheduled, cloud: scheduled, local: na("Hosted OAuth grant scenario") },
  },
  liveGrantRestrictions: {
    fixtures: "actors",
    file: "mcp-grant-restrictions.spec.ts",
    title: "MCP grants retain exact selections through deployment and live narrowing",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario checks hosted API and MCP parity."),
    },
  },
  patMcp: {
    fixtures: "actors",
    file: "pat-mcp.spec.ts",
    title: "PATs authenticate MCP in model and native modes with organization access",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local uses its instance credential."),
    },
  },
  patMcpRoles: {
    fixtures: "actors",
    file: "pat-mcp.spec.ts",
    title: "PAT MCP clients recheck current organization roles without reconnecting",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no personal access tokens."),
    },
  },
  patMcpApprovals: {
    fixtures: "actors",
    file: "pat-mcp.spec.ts",
    title: "PAT MCP approvals bind continuations to the token and enforce live revocation",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no personal access tokens."),
    },
  },
  patMcpExpiry: {
    fixtures: "actors",
    file: "pat-mcp.spec.ts",
    title: "PAT expiry rejects new requests and existing MCP clients",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no personal access tokens."),
    },
  },
  patMcpInFlight: {
    fixtures: "actors",
    file: "pat-mcp-in-flight.spec.ts",
    title: "Revocation between tool calls stops an already running MCP execute",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "The controlled upstream is loopback-only; hosted request authorization is shared.",
      ),
      local: na("Local uses its instance credential."),
    },
  },
  namedApiKeys: {
    fixtures: "actors",
    file: "named-api-keys.spec.ts",
    title: "Personal access tokens inherit user permissions and support expiry and revocation",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local uses its instance key."),
    },
  },
  organizationApiKeys: {
    fixtures: "actors",
    file: "organization-api-keys.spec.ts",
    title: "Deleting an organization revokes its managed and personal API keys",
    targets: {
      cloud: scheduled,
      "self-host": na("Self-host does not expose organization deletion."),
      local: na("Local has no organizations."),
    },
  },
  memberApiKeys: {
    fixtures: "actors",
    file: "member-api-keys.spec.ts",
    title: "Organization membership removal permanently revokes pinned API keys",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no organization memberships."),
    },
  },
  userApiKey: {
    fixtures: "actors",
    file: "user-api-key.spec.ts",
    title: "User API keys are private and independent of dashboard sessions",
    targets: {
      "self-host": scheduled,
      cloud: {
        status: "not-run",
        reason: "This session lifecycle scenario uses self-host password login.",
      },
      local: na("Local uses its configured instance API key."),
    },
  },
  warmRequestAuth: {
    fixtures: "actors",
    file: "warm-request-auth.spec.ts",
    title: "Dashboard requests refuse signed-out sessions and removed members immediately",
    targets: {
      "self-host": scheduled,
      cloud: {
        status: "not-run",
        reason: "This session lifecycle scenario uses self-host password login.",
      },
      local: na("Local has no dashboard sessions or organization memberships."),
    },
  },
  localWorkflows: {
    file: "local-workflows.spec.ts",
    title: "local app workflows execute through the authenticated SDK HTTP surface",
    targets: {
      local: scheduled,
      "self-host": na("Hosted workflow coverage uses organization routes."),
      cloud: na("Hosted workflow coverage uses organization routes."),
    },
  },
  localProfilePicker: {
    file: "local-profile-picker.spec.ts",
    title: "local account groups select scalar tools without copying apps",
    targets: {
      local: scheduled,
      "self-host": na("Local pairing journey."),
      cloud: na("Local pairing journey."),
    },
  },
  localSourceFormatting: {
    file: "local-source-formatting.spec.ts",
    title: "local source views receive server-formatted text and preserve raw source",
    targets: {
      local: scheduled,
      "self-host": na("Local paired source routes."),
      cloud: na("Local paired source routes."),
    },
  },
  codeFormatting: {
    fixtures: "actors",
    file: "code-formatting.spec.ts",
    title: "code blocks format source and copy without changing stored content",
    targets: {
      local: na("Shared source viewer covered through hosted."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  sourceDisplayBudget: {
    fixtures: "actors",
    file: "source-display-budget.spec.ts",
    title: "source display budgets bound inline content and preserve complete stored files",
    targets: {
      local: na("Hosted source display budgets."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  profileSetupStatus: {
    fixtures: "actors",
    file: "profile-setup-status.spec.ts",
    title: "account setup stays invisible until provider registration fails",
    targets: {
      local: na("Hosted shared-view journey."),
      "self-host": scheduled,
      cloud: na("Uses a loopback provider fixture."),
    },
  },
  profileCreation: {
    fixtures: "actors",
    file: "profile-picker.spec.ts",
    title: "profile creation preserves existing accounts and discards cancelled drafts",
    targets: {
      local: na("Hosted browser authority journey."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  profilePicker: {
    fixtures: "actors",
    file: "profile-picker.spec.ts",
    title: "profile picker keeps scalar and array choices isolated across tabs",
    targets: {
      local: na("Hosted browser authority journey."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  profileAppTabs: {
    fixtures: "actors",
    file: "profile-picker.spec.ts",
    appOrigin: true,
    title: "authored app tabs preserve profile choice and reject disabled or foreign profiles",
    targets: {
      local: na("Hosted browser authority journey."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  profileDeployment: {
    fixtures: "actors",
    file: "profile-picker.spec.ts",
    title: "profile catalogs follow deployments independently across browser tabs",
    targets: {
      local: na("Hosted browser authority journey."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedProfiles: {
    fixtures: "actors",
    file: "hosted-profiles.spec.ts",
    title: "hosted profiles isolate subjects and preserve disabled account selections",
    targets: { local: na("Hosted membership only."), "self-host": scheduled, cloud: scheduled },
  },
  hostedProfileScheduling: {
    fixtures: "actors",
    file: "hosted-profile-scheduling.spec.ts",
    title: "hosted profiles isolate shared accounts for schedules and workflows",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted profile authorization"),
    },
  },
  hostedProfileRevocation: {
    fixtures: "actors",
    file: "hosted-profiles.spec.ts",
    title: "hosted profiles recheck shared accounts after deletion and revocation",
    targets: { local: na("Hosted membership only."), "self-host": scheduled, cloud: scheduled },
  },
  profiles: {
    file: "profiles.spec.ts",
    title: "profiles share deployment and storage while preserving setup and execution bindings",
    targets: {
      local: scheduled,
      "self-host": na("Hosted profile access has its own browser scenario."),
      cloud: na("Hosted profile access has its own browser scenario."),
    },
  },
  workflowProfiles: {
    fixtures: "actors",
    file: "workflow-profiles.spec.ts",
    title: "approval-resumed workflow controls stay inside the caller's profile",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted profiles, API keys and MCP."),
    },
  },
  workflows: {
    fixtures: "actors",
    file: "workflows.spec.ts",
    title: "app workflows pin deployments and accounts, retry steps, and enforce permissions",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app and account management routes."),
    },
  },
  workflowHistory: {
    fixtures: "actors",
    file: "workflows.spec.ts",
    title: "app workflows launch from handlers and isolate paginated history",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app and account management routes."),
    },
  },
  workflowFailures: {
    fixtures: "actors",
    file: "workflows.spec.ts",
    title: "app workflows enforce approval, failure, timeout rollback and termination",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app and account management routes."),
    },
  },
  workflowTimeout: {
    fixtures: "actors",
    file: "workflow-durability.spec.ts",
    title: "workflow timeouts roll back confirmed writes without late commits",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app management routes."),
    },
  },
  workflowSleep: {
    fixtures: "actors",
    file: "workflow-durability.spec.ts",
    title: "workflow sleep preserves completed mutations and resumes execution",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app management routes."),
    },
  },
  appContext: {
    fixtures: "actors",
    file: "app-context.spec.ts",
    title: "standalone app handlers receive fresh accounts and scoped storage",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted account and webhook management routes."),
    },
  },
  invitationRoles: {
    fixtures: "actors",
    file: "invitation-roles.spec.ts",
    title: "invitation roles cannot grant owner authority through native auth routes",
    targets: {
      local: na("Hosted organization invitations."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  invitationPrivacy: {
    fixtures: "actors",
    file: "invitation-security.spec.ts",
    title: "invitation secrets are available only to current organization administrators",
    targets: {
      local: na("Hosted organization invitations."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  invitationRedemption: {
    fixtures: "actors",
    file: "invitation-redemption.spec.ts",
    title:
      "self-host invitation links admit the intended role exactly once without replacing accounts",
    targets: {
      local: na("Self-host invitation signup."),
      "self-host": scheduled,
      cloud: na("Cloud requires a verified recipient instead of password registration."),
    },
  },
  selfHostOnboarding: {
    file: "self-host-onboarding.spec.ts",
    title: "Self-host administrator setup opens the agent handoff before Apps",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud has its own team creation journey."),
      local: na("Local uses device pairing instead of administrator setup."),
    },
  },
  onboardingGoogle: {
    file: "cloud-onboarding.spec.ts",
    title: "Cloud onboarding with Google opens prepared team confirmation",
    targets: cloudOnboarding,
  },
  onboardingGithub: {
    file: "cloud-onboarding.spec.ts",
    title: "Cloud onboarding with GitHub retains edited team details through a failed confirmation",
    targets: cloudOnboarding,
  },
  onboardingEmail: {
    file: "cloud-onboarding.spec.ts",
    title: "Cloud onboarding with email registers a passkey and uses it for returning sign-in",
    targets: cloudOnboarding,
  },
  onboardingSkip: {
    file: "cloud-onboarding.spec.ts",
    title:
      "Cloud onboarding can skip a passkey and returning email sign-in keeps the existing team",
    targets: cloudOnboarding,
  },
  localSkills: {
    file: "local-skills.spec.ts",
    title: "local MCP skills follow configured copies and deployment versions",
    targets: {
      local: scheduled,
      "self-host": na(
        "Local bearer access is covered here; hosted OAuth skills use the hosted scenario.",
      ),
      cloud: na(
        "Local bearer access is covered here; hosted OAuth skills use the hosted scenario.",
      ),
    },
  },
  skillFolder: {
    fixtures: "actors",
    file: "skill-folder.spec.ts",
    title: "skill folders share one loader and respect explicit catalogs",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na(
        "Shared runtime behavior is covered on hosted targets; local MCP has its own skill scenario.",
      ),
    },
  },

  skillFolderValidation: {
    fixtures: "actors",
    file: "skill-folder-validation.spec.ts",
    title: "skill folders validate every selected document and honor empty overrides",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na(
        "Shared runtime behavior is covered on hosted targets; local MCP has its own skill scenario.",
      ),
    },
  },

  skillFolderPaths: {
    fixtures: "actors",
    file: "skill-folder-paths.spec.ts",
    title: "skill folders reject path traversal and duplicate catalogs",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na(
        "Shared runtime behavior is covered on hosted targets; local MCP has its own skill scenario.",
      ),
    },
  },
  dynamicSkills: {
    fixtures: "actors",
    file: "dynamic-skills.spec.ts",
    title: "dynamic skills refresh remote publications without redeployment",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na(
        "Shared runtime and HTTP behavior are covered on hosted targets; local MCP has its own skill scenario.",
      ),
    },
  },
  appSkills: {
    fixtures: "actors",
    file: "app-skills.spec.ts",
    title: "bundled app skills remain authorized and pinned across deployments",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario tests hosted membership; local skills are covered through MCP."),
    },
  },
  appSkillDeployments: {
    fixtures: "actors",
    file: "app-skills.spec.ts",
    title: "app skill deployments retain pinned history through updates and activation",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This journey checks hosted skill authorization and deployments."),
    },
  },
  scheduledBrowser: {
    file: "schedule-browser.spec.ts",
    title: "browser schedule controls enable, run, approve and pause a mutation",
    targets: {
      local: scheduled,
      "self-host": {
        status: "not-applicable",
        reason: "Shared UI exercised locally; hosted authority covered separately.",
      },
      cloud: {
        status: "not-applicable",
        reason: "Shared UI exercised locally; hosted authority covered separately.",
      },
    },
  },
  hostedScheduleBrowser: {
    fixtures: "actors",
    file: "hosted-schedule-browser.spec.ts",
    title: "hosted schedule controls enable, run, approve and pause through the browser",
    targets: {
      cloud: scheduled,
      "self-host": scheduled,
      local: na("Local pairing drives the same shared controls in its own scenario."),
    },
  },
  scheduleDiscoveryStates: {
    fixtures: "actors",
    file: "hosted-schedule-browser.spec.ts",
    title: "schedule discovery distinguishes loading, failure and confirmed empty results",
    targets: {
      cloud: scheduled,
      "self-host": scheduled,
      local: na("The shared schedule view is exercised through the hosted API."),
    },
  },

  scheduleLoading: {
    fixtures: "actors",
    file: "hosted-schedule-browser.spec.ts",
    title: "schedule tab keeps its layout through metadata, settings and discovery loading",
    targets: {
      cloud: scheduled,
      "self-host": scheduled,
      local: na("The shared schedule view is exercised through the hosted API."),
    },
  },
  scheduleAccountSetup: {
    fixtures: "actors",
    file: "hosted-schedule-browser.spec.ts",
    title: "schedule discovery offers account setup without a false empty result",
    targets: {
      cloud: scheduled,
      "self-host": scheduled,
      local: na("The shared schedule view is exercised through the hosted account routes."),
    },
  },
  scheduleRestart: {
    file: "schedule-restart.spec.ts",
    title: "local restart coalesces overdue schedules and preserves pending approvals",
    targets: {
      local: scheduled,
      "self-host": na(
        "Restart scenario owns a local target; hosted authorization is tested separately.",
      ),
      cloud: na("A deployed cloud endpoint cannot be restarted by this local process controller."),
    },
  },
  hostedSchedules: {
    fixtures: "actors",
    file: "hosted-schedules.spec.ts",
    title: "hosted scheduled runs require current membership and browser approval",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local does not have organization memberships."),
    },
  },
  scheduledRuns: {
    file: "local-schedule-runs.spec.ts",
    title: "scheduled runs honor approval policy, browser review and overlap exclusion",
    targets: {
      local: scheduled,
      "self-host": na(
        "Local cookie review and runner fixture; hosted roles are covered separately.",
      ),
      cloud: na("Local cookie review and runner fixture; hosted roles are covered separately."),
    },
  },
  schedules: {
    file: "local-schedules.spec.ts",
    title: "local app schedules are typed, paused by default and configurable",
    targets: {
      local: scheduled,
      "self-host": na("SDK route fixture; hosted scheduling has separate authority checks."),
      cloud: na("SDK route fixture; hosted scheduling has separate authority checks."),
    },
  },
  mcp: {
    fixtures: "actors",
    file: "claude-mcp.spec.ts",
    title: "Claude Code connects through /mcp, browser authentication and a real tool call",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario tests hosted organization consent, which Local does not have."),
    },
  },
  mcpProtocol: {
    fixtures: "actors",
    file: "mcp-server.spec.ts",
    title: "MCP OAuth grants support discovery, execution, refresh and revocation",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario tests hosted organization consent, which Local does not have."),
    },
  },
  mcpSkills: {
    managementProfiles: ["owner"],
    fixtures: "actors",
    file: "mcp-server.spec.ts",
    title: "MCP skills expose pinned instructions and obey live OAuth grant restrictions",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario tests hosted organization consent, which Local does not have."),
    },
  },
  organizationRemoval: {
    fixtures: "actors",
    file: "organization-removal.spec.ts",
    title: "Owners delete an organization with every app, account and membership it holds",
    targets: {
      cloud: scheduled,
      "self-host": na(
        "Self-host has a single instance organization and does not expose organization deletion.",
      ),
      local: na("Local has no hosted organizations."),
    },
  },
  hosted: {
    fixtures: "actors",
    file: "hosted-shared.spec.ts",
    title: "hosted roles, account connection, discovery and invocation agree",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no hosted organizations or membership roles."),
    },
  },
  remoteMcp: {
    fixtures: "actors",
    file: "hosted-shared.spec.ts",
    title: "a public remote MCP server imports, discovers tools and calls one end to end",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario tests the hosted custom-import endpoint and organization roles."),
    },
  },
  password: {
    fixtures: "actors",
    file: "hosted.spec.ts",
    title: "self-host password login opens the owner and member dashboards",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Cloud uses email codes, passkeys and social sign-in instead of self-host passwords.",
      ),
      local: na("Local uses device pairing instead of password login."),
    },
  },
  scale: {
    fixtures: "actors",
    file: "hosted.spec.ts",
    title: "concurrent owners and admins save every account in a large inventory",
    targets: {
      "self-host": scheduled,
      cloud: {
        status: "not-run",
        reason: "Requires dedicated cloud load capacity; shared test-stage databases are excluded.",
      },
      local: na("This workload tests hosted organization accounts and administrator roles."),
    },
  },
  telemetry: {
    fixtures: "actors",
    file: "hosted.spec.ts",
    title: "real requests reach Motel with correlated server spans",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud exports to Axiom; this test checks the self-host Motel collector."),
      local: na("This test checks hosted organization routes and self-host service spans."),
    },
  },
  local: {
    file: "local.spec.ts",
    title: "local pairing opens the dashboard and the one-use link cannot be replayed",
    targets: {
      local: scheduled,
      "self-host": na("Self-host uses hosted sign-in rather than local device pairing."),
      cloud: na("Cloud uses hosted sign-in rather than local device pairing."),
    },
  },
  localStartupRecovery: {
    file: "local-startup-recovery.spec.ts",
    title: "local startup can recover after a real port conflict",
    targets: {
      local: scheduled,
      "self-host": na(
        "This case exercises the runner's Local process control and readiness protocol.",
      ),
      cloud: na("This case exercises the runner's Local process control and readiness protocol."),
    },
  },
  cloud: {
    file: "cloud.spec.ts",
    title: "cloud endpoint is healthy and protects the signed-out viewer",
    targets: {
      cloud: scheduled,
      "self-host": na("This test checks Cloud's email-code sign-in UI."),
      local: na("This test checks Cloud's hosted sign-in and viewer routes."),
    },
  },
  enrollmentRefresh: {
    file: "enrollment-refresh.spec.ts",
    title: "Cloud passkey enrollment retains errors and focus during session refresh",
    targets: cloudOnboarding,
  },
} as const satisfies Record<string, typeof TestPlan.Type>;

/** Hosted parity includes every scenario scheduled on both hosted products. */
export const scenariosForSuite = (
  suite: "all" | "hosted",
  cloudMode: "managed" | "attached" = "managed",
) =>
  Object.values(scenarios)
    .filter(
      (scenario) =>
        suite === "all" ||
        (scenario.targets["self-host"].status === "scheduled" &&
          scenario.targets.cloud.status === "scheduled"),
    )
    .map((scenario) =>
      "runtime" in scenario.targets.cloud && scenario.targets.cloud.runtime !== cloudMode
        ? {
            ...scenario,
            targets: {
              ...scenario.targets,
              cloud: na(
                scenario.targets.cloud.runtime === "managed"
                  ? "Requires the managed local Cloud target and its local collectors."
                  : "Requires a deployed Cloud target with Cloudflare's memory limit.",
              ),
            },
          }
        : scenario,
    );

/** Select only explicitly scheduled files for a target; cloud scale stays disabled. */
export const filesForTarget = (
  target: typeof Target.Type,
  suite: "all" | "hosted",
  cloudMode: "managed" | "attached" = "managed",
  filter = "",
) => [
  ...new Set(
    scenariosForSuite(suite, cloudMode)
      .filter(
        (scenario) =>
          scenario.targets[target].status === "scheduled" &&
          new RegExp(filter).test(scenario.title),
      )
      .map((scenario) => `e2e/tests/${scenario.file}`),
  ),
];

/** Keep scenario-level target declarations when several targets share one test file. */
export const patternForTarget = (
  target: typeof Target.Type,
  suite: "all" | "hosted",
  filter: string,
  cloudMode: "managed" | "attached" = "managed",
): string => {
  const selected = new RegExp(filter);
  const titles = scenariosForSuite(suite, cloudMode)
    .filter(
      (scenario) =>
        scenario.targets[target].status === "scheduled" && selected.test(scenario.title),
    )
    .map((scenario) => scenario.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (titles.length === 0) return "(?!)";
  return `^(?:[\\s\\S]* )?(?:${titles.join("|")})$`;
};
