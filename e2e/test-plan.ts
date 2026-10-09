/** A target's applicability is explicit. Missing evidence never implies N/A. */
import { Schema } from "effect";
import type { Target } from "./report-model.ts";

/** Scheduled tests need a real result; other dispositions explain why none is expected. */
export const TargetPlan = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("scheduled"),
    runtime: Schema.optional(
      Schema.Literals([
        "managed",
        "attached",
        "rate-limited",
        "rolled-back",
        "oauth-proxy-preview",
      ]),
    ),
  }),
  Schema.Struct({
    status: Schema.Literal("not-applicable"),
    reason: Schema.NonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("not-run"),
    reason: Schema.NonEmptyString,
  }),
]);
/** Snapshot this plan in a report so later configuration changes cannot rewrite its meaning. */
export const TestPlan = Schema.Struct({
  file: Schema.String,
  title: Schema.String,
  fixtures: Schema.optional(Schema.Literals(["actors", "cli"])),
  appOrigin: Schema.optional(Schema.Literal(true)),
  /** Opt in to writing legacy/upgrade-era rows into the stopped product's own database. */
  legacyStorage: Schema.optional(Schema.Literal(true)),
  managementProfiles: Schema.optional(Schema.Array(Schema.Literals(["owner", "admin", "member"]))),
  /** Labels of extra Testing SDK scenarios created during setup; each has its own closeable scope. */
  sdkScenarios: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  /** Operator settings the scenario's own product process starts with. */
  serverEnvironment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  targets: Schema.Struct({
    "self-host": TargetPlan,
    local: TargetPlan,
    cloud: TargetPlan,
  }),
});
const scheduled = { status: "scheduled" } as const;
const managedCloud = { status: "scheduled", runtime: "managed" } as const;
/** Runs alone on a managed local Cloud started with Better Auth's per-address limit on. */
const rateLimitedCloud = { status: "scheduled", runtime: "rate-limited" } as const;
const rolledBackCloud = { status: "scheduled", runtime: "rolled-back" } as const;
/** Runs on a managed test stage that signs in through a second local Cloud's OAuth proxy. */
const oauthProxyPreviewCloud = { status: "scheduled", runtime: "oauth-proxy-preview" } as const;
const na = (reason: string) => ({ status: "not-applicable", reason }) as const;
const cloudOnboarding = {
  cloud: scheduled,
  "self-host": na(
    "Self-host has instance setup and password/SSO admission instead of Cloud onboarding.",
  ),
  local: na("Local uses device pairing instead of Cloud account onboarding."),
};

/** App Workers the budget scenarios keep loaded; their spec asserts this limit. */
export const appWorkerBudgetLimit = 2;
/** A relay callback in a valid form other than its serialization, which the SDK sends. */
export const oauthRelayCallback =
  "https://Relay.Executor.example:443/api/oauth/callback?tenant=fixture";

/**
 * Keeps each scenario name but gives every value the plan type. A literal type per scenario makes
 * any expression over all of them a union that grows with the plan, and TypeScript refuses one past
 * about a thousand members (TS2590). Values are still checked against the plan, extra keys included.
 */
const plan = <Name extends string>(scenarios: { readonly [_ in Name]: typeof TestPlan.Type }) =>
  scenarios;

/** Scenario names and applicability used by both test declarations and test selection. */
export const scenarios = plan({
  cloudRoleHostRoutes: {
    fixtures: "actors",
    file: "cloud-role-hosts.spec.ts",
    title:
      "cloud role hosts serve only their own routes and discovery, and browser pages move to app.",
    targets: {
      // A new stage orders the role hosts' certificate as it deploys; local Cloud has none to wait for.
      cloud: managedCloud,
      "self-host": na("Role hosts are Cloud's; self-host serves one origin."),
      local: na("Role hosts are Cloud's; local serves one origin."),
    },
  },
  cloudPasskeyMoved: {
    file: "cloud-passkey-moved.spec.ts",
    title:
      "Cloud sign-in explains that a passkey made on the deployment origin no longer works after the move to app.",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host serves sign-in on its one origin; its passkeys never move."),
      local: na("Local has no passkeys."),
    },
  },
  cloudAccountCallback: {
    fixtures: "actors",
    file: "cloud-account-callback.spec.ts",
    title:
      "Cloud connected-account sign-ins return through the deployment origin's callback to the browser origin, and the edge forwards v2's state prefix",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host's callback is on its one origin; nothing forwards to it."),
      local: na("Local's callback is on its one origin; nothing forwards to it."),
    },
  },
  cloudSiteEdge: {
    file: "cloud-site-edge.spec.ts",
    title:
      "Cloud serves its site for the edge with links to app., and its other hosts send site pages there",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host does not serve the marketing site."),
      local: na("Local does not serve the marketing site."),
    },
  },
  cloudSkillsIndexHosts: {
    fixtures: "actors",
    file: "cloud-site-edge.spec.ts",
    title:
      "Cloud's deployment and browser origins keep serving the published skills index to apps that stored its URL",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host serves one origin; it never moved its skills index."),
      local: na("Local serves one origin; it never moved its skills index."),
    },
  },
  marketingIsolation: {
    file: "marketing-isolation.spec.ts",
    title: "Cloud serves marketing documents and assets without regional API placement",
    targets: {
      cloud: { status: "scheduled", runtime: "attached" },
      "self-host": na("Self-host does not serve the marketing site."),
      local: na("Local does not deploy Cloudflare Workers or have regional placement."),
    },
  },
  cloudApiHostClients: {
    fixtures: "actors",
    file: "cloud-api-host-clients.spec.ts",
    title:
      "Cloud's API host serves the SDK's registry, leads the CLI to sign-in by discovery and names the edge for Git",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host serves its registry, sign-in and Git on its one origin."),
      local: na("Local signs the CLI in with an API key."),
    },
  },
  cloudSiteAppsDirectory: {
    file: "cloud-site-apps.spec.ts",
    title:
      "The site's Apps directory on the edge reads the API host's registry, whose public GETs allow any origin",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host does not serve the marketing site."),
      local: na("Local does not serve the marketing site."),
    },
  },
  cloudSiteAppPublication: {
    fixtures: "actors",
    file: "cloud-site-apps.spec.ts",
    title:
      "The site's Apps pages on the edge list a publication and show its source from the API host",
    targets: {
      // Publishing needs app Git storage, which a local Cloud Worker cannot reach.
      cloud: { status: "scheduled", runtime: "attached" },
      "self-host": na("Self-host does not serve the marketing site."),
      local: na("Local does not serve the marketing site."),
    },
  },
  appGitRemotes: {
    fixtures: "actors",
    file: "app-git-remotes.spec.ts",
    title:
      "Git clones and pushes through the remote the host names, with the session the CLI signed in with",
    targets: {
      // Managed local Cloud has no Git storage; deployed stages have Cloudflare's.
      cloud: { status: "scheduled", runtime: "attached" },
      "self-host": scheduled,
      local: na("Local signs the CLI in with an API key, not a saved session."),
    },
  },
  cloudRoleHostGrants: {
    fixtures: "actors",
    file: "cloud-role-hosts.spec.ts",
    title: "a grant is for its one resource and works at the deployment origin and its role host",
    targets: {
      // A new stage orders the role hosts' certificate as it deploys; local Cloud has none to wait for.
      cloud: managedCloud,
      "self-host": na("Role hosts are Cloud's; self-host serves one origin."),
      local: na("Role hosts are Cloud's; local serves one origin."),
    },
  },
  cloudRoleHostSpans: {
    fixtures: "actors",
    file: "cloud-role-hosts.spec.ts",
    title:
      "Cloud request spans name the host each request reached, its role, its path and its route",
    targets: {
      cloud: managedCloud,
      "self-host": na("Role hosts are Cloud's; self-host serves one origin."),
      local: na("Role hosts are Cloud's; local serves one origin."),
    },
  },
  cloudRollbackSwitch: {
    fixtures: "actors",
    file: "cloud-rollback.spec.ts",
    title:
      "Cloud's rollback switch serves sign-in on the deployment origin and keeps mcp., the issuer on the edge and grants",
    targets: {
      cloud: rolledBackCloud,
      "self-host": na("Role hosts are Cloud's; self-host serves one origin."),
      local: na("Role hosts are Cloud's; local serves one origin."),
    },
  },
  cloudOAuthProxyOwnSignIn: {
    file: "cloud-oauth-proxy.spec.ts",
    title: "Cloud's own social sign-ins on app. return through the edge without its OAuth proxy",
    targets: {
      // Only local Cloud runs as the proxy's production; an emulated test stage has no proxy.
      cloud: managedCloud,
      "self-host": na("The OAuth proxy and role hosts are Cloud's."),
      local: na("The OAuth proxy and role hosts are Cloud's."),
    },
  },
  cloudOAuthProxyRollback: {
    file: "cloud-oauth-proxy.spec.ts",
    title:
      "Cloud's own social sign-ins under the rollback switch return through the edge without its OAuth proxy",
    targets: {
      cloud: rolledBackCloud,
      "self-host": na("The OAuth proxy and role hosts are Cloud's."),
      local: na("The OAuth proxy and role hosts are Cloud's."),
    },
  },
  cloudOAuthProxyPreview: {
    file: "cloud-oauth-proxy.spec.ts",
    title:
      "A test stage signs in through production's OAuth proxy and keeps the session on its own origin",
    targets: {
      cloud: oauthProxyPreviewCloud,
      "self-host": na("The OAuth proxy and role hosts are Cloud's."),
      local: na("The OAuth proxy and role hosts are Cloud's."),
    },
  },
  cloudRoleHostResourceSeed: {
    fixtures: "actors",
    file: "cloud-role-host-seed.spec.ts",
    title:
      "the role host resource seed adds missing connection resources once and changes nothing else",
    targets: {
      cloud: managedCloud,
      "self-host": na("Role hosts and their resource seed are Cloud's."),
      local: na("Role hosts and their resource seed are Cloud's."),
    },
  },
  appWorkerBudget: {
    fixtures: "actors",
    file: "app-worker-budget.spec.ts",
    title:
      "at most the configured number of app Workers stay loaded as apps and account selections grow",
    serverEnvironment: { EXECUTOR_APP_WORKERS: String(appWorkerBudgetLimit) },
    targets: {
      "self-host": scheduled,
      cloud: na("Cloudflare unloads Cloud's app Workers itself."),
      local: na("Local is covered by the local app Worker budget scenario."),
    },
  },
  appWorkerBudgetInFlight: {
    fixtures: "actors",
    file: "app-worker-budget.spec.ts",
    title: "an app Worker with a call in flight is never unloaded above the configured limit",
    serverEnvironment: { EXECUTOR_APP_WORKERS: "1" },
    targets: {
      "self-host": scheduled,
      cloud: na("Cloudflare unloads Cloud's app Workers itself."),
      local: na(
        "Self-host covers the shared runner's Worker residency; the local budget scenario covers local's limit.",
      ),
    },
  },
  appDataFacetUnloaded: {
    fixtures: "actors",
    file: "app-worker-budget.spec.ts",
    title: "a data facet replaced for other accounts is unloaded, not kept for the process",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloudflare unloads Cloud's facet Workers itself."),
      local: na(
        "Self-host covers the shared runner's facet unloading; the local budget scenario covers local's limit.",
      ),
    },
  },
  localAppWorkerBudget: {
    file: "app-worker-budget.spec.ts",
    title:
      "local keeps at most the configured number of app Workers loaded as apps and account selections grow",
    serverEnvironment: { EXECUTOR_APP_WORKERS: String(appWorkerBudgetLimit) },
    targets: {
      local: scheduled,
      "self-host": na("Hosted budgets are covered through organization routes."),
      cloud: na("Cloudflare unloads Cloud's app Workers itself."),
    },
  },
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
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted authorization policy"),
    },
  },
  hostedToolRunnerApprovals: {
    fixtures: "actors",
    file: "tool-runner-approvals.spec.ts",
    title:
      "Hosted dashboard runs of approval-gated tools show the saved call and run it only after the person approves",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local covers the same review in its tool runner scenario."),
    },
  },
  hostedToolRunnerApprovalOrigins: {
    fixtures: "actors",
    file: "tool-runner-approvals.spec.ts",
    title:
      "Hosted dashboard approval routes refuse MCP and scheduled approvals, which still complete in their own flow",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local covers approvals from the SDK in its tool runner scenario."),
    },
  },
  hostedToolRunnerApprovalMembers: {
    fixtures: "actors",
    file: "tool-runner-approvals.spec.ts",
    title:
      "Hosted dashboard approvals without a profile are read and answered only by the member who started the run",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local does not have organization memberships."),
    },
  },
  activeDeploymentResume: {
    fixtures: "actors",
    file: "active-deployment-tools.spec.ts",
    title: "Hosted MCP resumes pinned approvals after promotion with current authorization",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted authorization policy"),
    },
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
  mcpCatalogScale: {
    fixtures: "actors",
    file: "mcp-catalog-scale.spec.ts",
    title:
      "MCP execute over 7,000 tools loads only the apps a program uses and isolates stalled apps",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback stalled MCP server; the shared execute path is covered on self-host"),
      local: na("Hosted deployment API scenario"),
    },
  },
  mcpListingCacheChanges: {
    fixtures: "actors",
    file: "mcp-catalog.spec.ts",
    title:
      "MCP execute lists an app's tools again after its cached catalog is refreshed or its server announces changed tools",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback MCP fixture; the shared execute path is covered on self-host"),
      local: na("Hosted deployment API scenario"),
    },
  },
  mcpExecuteSignatures: {
    fixtures: "actors",
    file: "mcp-catalog.spec.ts",
    title:
      "MCP execute renders tool signatures only for a program that searches with CodeMode's search()",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback MCP fixture; the shared execute path is covered on self-host"),
      local: na("Hosted deployment API scenario"),
    },
  },
  mcpSlowListing: {
    fixtures: "actors",
    file: "mcp-catalog-scale.spec.ts",
    title: "MCP execute pays for a slow app's tool listing once and reuses it",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback slow upstream; the shared execute path is covered on self-host"),
      local: na("Hosted deployment API scenario"),
    },
  },
  // The two Cloud listing scenarios read a running listing or a remembered timeout, which live only
  // in the isolate that ran the listing. The local Worker serves every search from one isolate; a
  // deployed one may not.
  mcpBackgroundListingCloud: {
    fixtures: "actors",
    file: "mcp-catalog-scale.spec.ts",
    title:
      "Cloud finishes a slow app's tool listing after discovery stops waiting and serves it to later searches",
    targets: {
      cloud: managedCloud,
      "self-host": na(
        "Self-host keeps background work for the server's lifetime; its slow listing scenario covers the shared path",
      ),
      local: na("Hosted deployment API scenario"),
    },
  },
  mcpStoppedListingCloud: {
    fixtures: "actors",
    file: "mcp-catalog-scale.spec.ts",
    title: "Cloud remembers a stalled tool listing as timed out when its background work ends",
    targets: {
      cloud: managedCloud,
      "self-host": na(
        "Self-host keeps background work for the server's lifetime; its stalled listing scenario covers the load bound",
      ),
      local: na("Hosted deployment API scenario"),
    },
  },
  mcpRememberedListingFailure: {
    fixtures: "actors",
    file: "mcp-catalog-scale.spec.ts",
    title:
      "MCP execute remembers a stalled tool listing's timeout, retries it once in the background and recovers",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback held upstream; the shared execute path is covered on self-host"),
      local: na("Hosted deployment API scenario"),
    },
  },
  mcpListingInputs: {
    fixtures: "actors",
    file: "mcp-catalog-scale.spec.ts",
    title:
      "MCP execute lists tools again for a new deployment, profile revision, selection or credential, never across profiles or revoked access",
    targets: {
      "self-host": scheduled,
      cloud: na("Shared execute path; covered on self-host"),
      local: na("Hosted deployment API scenario"),
    },
  },
  mcpSearchConcise: {
    file: "mcp-search-concise.spec.ts",
    title:
      "A broad MCP tool search returns concise pages within the execute output budget and describe returns full signatures",
    targets: {
      local: scheduled,
      "self-host": na("Shared MCP search; covered on local"),
      cloud: na("Shared MCP search; covered on local"),
    },
  },
  mcpExecuteReach: {
    fixtures: "actors",
    file: "mcp-execute-reach.spec.ts",
    title: "MCP execute discovers every app a program reaches through dynamic access to tools",
    targets: {
      "self-host": scheduled,
      cloud: na("Shared execute path; covered on self-host"),
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
  liveOpenapiYaml: {
    fixtures: "actors",
    file: "live-openapi-yaml.spec.ts",
    title: "Live OpenAPI reads YAML with aliases and refuses alias bombs",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback upstream fixture"),
      local: na("Hosted deployment API scenario"),
    },
  },
  liveOpenapiDiagnostics: {
    fixtures: "actors",
    file: "live-openapi-import.spec.ts",
    title: "Live OpenAPI names the operations, origins and schema pointers it cannot import",
    targets: {
      "self-host": scheduled,
      cloud: na("The importer runs the same app code on every host; covered on self-host."),
      local: na("Hosted deployment API scenario"),
    },
  },
  liveOpenapi32: {
    fixtures: "actors",
    file: "live-openapi-import.spec.ts",
    title:
      "Live OpenAPI imports OpenAPI 3.2 QUERY, querystring and JSON Lines operations under a path prefix",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback upstream fixture"),
      local: na("Hosted deployment API scenario"),
    },
  },
  liveOpenapiNaming: {
    fixtures: "actors",
    file: "live-openapi-import.spec.ts",
    title: "Live OpenAPI keeps its released tool names and lists them without an account",
    targets: {
      "self-host": scheduled,
      cloud: na("The importer runs the same app code on every host; covered on self-host."),
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
  appRouters: {
    fixtures: "actors",
    file: "app-routers.spec.ts",
    title:
      "Routers group tools by path, carry MCP and OpenAPI metadata and isolate a failing server",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback MCP fixture"),
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
  importedJsonSchemaDocuments: {
    fixtures: "actors",
    file: "imported-json-schema-documents.spec.ts",
    title:
      "Apps build imported JSON Schemas with shared or deeply nested parts on every evaluation",
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
  appCacheEvaluation: {
    fixtures: "actors",
    file: "app-cache-evaluation.spec.ts",
    title: "App cache failures during evaluation keep their safe reason in responses and traces",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses the shared runtime contract; self-host delivers its traces to Motel."),
      local: na("Hosted API fixture; the runtime and collector are shared with Local."),
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
  toolsIndexCache: {
    fixtures: "actors",
    file: "tools-index-cache.spec.ts",
    managementProfiles: ["owner", "admin"],
    title:
      "A new organization's first Tools index loads its catalog without redundant cache trips, and later browsing reuses the kept listing",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted management app catalog; the Node cache adapter shares the SQLite store"),
    },
  },
  concurrentAppReads: {
    fixtures: "actors",
    file: "concurrent-app-reads.spec.ts",
    title: "Concurrent reads of one app share its evaluation and each completes with its own I/O",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted organization routes; the shared evaluation path is covered on self-host"),
    },
  },
  dashboardReadBatches: {
    fixtures: "actors",
    file: "dashboard-read-batches.spec.ts",
    title:
      "Batched dashboard reads answer through their endpoints under the page's identity, each as it finishes",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("The local dashboard does not batch its reads; most of them are live streams"),
    },
  },
  appCacheStalledLoader: {
    fixtures: "actors",
    file: "app-cache-stalled-loader.spec.ts",
    title: "App cache callers outlast a stalled loader and the cache recovers after it",
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
  toolTreePrefixes: {
    fixtures: "actors",
    file: "tool-tree-prefixes.spec.ts",
    title: "The tool tree does not repeat a group whose tools restate its name",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("The hosted Tools page owns this tree."),
    },
  },
  toolRouterMetadata: {
    fixtures: "actors",
    file: "tool-router-metadata.spec.ts",
    title: "Tool groups show each router's title and description",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local is covered by the local tool router metadata scenario."),
    },
  },
  localToolRouterMetadata: {
    file: "tool-router-metadata.spec.ts",
    title: "Local tool groups show each router's title and description",
    targets: {
      local: scheduled,
      "self-host": na("Hosted Tools pages are covered through organization routes."),
      cloud: na("Hosted Tools pages are covered through organization routes."),
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
  failureEvidence: {
    // The cases it runs in their own process start their own products.
    fixtures: "cli",
    file: "failure-evidence.spec.ts",
    title: "Failed cases keep the trace of every request they sent",
    targets: {
      "self-host": scheduled,
      local: na("Evidence selection is the same test-side code for every target."),
      cloud: na("Evidence selection is the same test-side code for every target."),
    },
  },
  testingSdk: {
    fixtures: "actors",
    file: "testing-sdk.spec.ts",
    title: "Testing SDK isolates overlapping populated organizations and cleans failed scenarios",
    sdkScenarios: ["Overlapping organization"],
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
  localBootstrapKeyFile: {
    file: "local-bootstrap.spec.ts",
    title:
      "local first launch without an OS credential store saves a private key file and never switches key storage",
    targets: {
      local: {
        status: "not-run",
        reason: "Runs against the installed release archive with local-bootstrap.config.ts.",
      },
      cloud: na("Local key file setup"),
      "self-host": na("Local key file setup"),
    },
  },
  localBootstrapDenied: {
    file: "local-bootstrap.spec.ts",
    title:
      "local first launch with denied OS credential store access stops without a key file and asks again",
    targets: {
      local: {
        status: "not-run",
        reason: "Runs against the installed release archive with local-bootstrap.config.ts.",
      },
      cloud: na("Local OS credential setup"),
      "self-host": na("Local OS credential setup"),
    },
  },
  localBootstrapKeyStorage: {
    file: "local-bootstrap.spec.ts",
    title:
      "local EXECUTOR_KEY_STORAGE chooses key storage only for a new directory and never switches it",
    targets: {
      local: {
        status: "not-run",
        reason: "Runs against the installed release archive with local-bootstrap.config.ts.",
      },
      cloud: na("Local key storage setup"),
      "self-host": na("Local key storage setup"),
    },
  },
  desktopCrashRecovery: {
    file: "desktop-recovery.spec.ts",
    title:
      "desktop restarts a stopped or crashed local server with backoff, stops after a crash loop and restarts from the recovery page",
    targets: {
      local: {
        status: "not-run",
        reason:
          "Runs against the packaged desktop in the release workflow with desktop-recovery.config.ts.",
      },
      cloud: na("Desktop process supervision"),
      "self-host": na("Desktop process supervision"),
    },
  },
  desktopLateLoadFailure: {
    file: "desktop-recovery.spec.ts",
    title:
      "desktop keeps running when the dashboard it replaced reports a failed load after the startup page commits",
    targets: {
      local: {
        status: "not-run",
        reason:
          "Runs against the packaged desktop in the release workflow with desktop-recovery.config.ts.",
      },
      cloud: na("Desktop window loading"),
      "self-host": na("Desktop window loading"),
    },
  },
  desktopClipboard: {
    file: "desktop-recovery.spec.ts",
    title: "desktop copy buttons write to the system clipboard",
    targets: {
      local: {
        status: "not-run",
        reason:
          "Runs against the packaged desktop in the release workflow with desktop-recovery.config.ts.",
      },
      cloud: na("Desktop clipboard permission"),
      "self-host": na("Desktop clipboard permission"),
    },
  },
  desktopReset: {
    file: "desktop-recovery.spec.ts",
    title:
      "desktop missing-key failure offers reset, which backs up the data with a manifest and starts fresh, or leaves it in place when the move fails",
    targets: {
      local: {
        status: "not-run",
        reason:
          "Runs against the packaged desktop in the release workflow with desktop-recovery.config.ts.",
      },
      cloud: na("Desktop data reset"),
      "self-host": na("Desktop data reset"),
    },
  },
  desktopResetWithheld: {
    file: "desktop-recovery.spec.ts",
    title:
      "desktop does not offer reset when its data is in use, its key settings do not match, or the OS credential store is unavailable or denies access",
    targets: {
      local: {
        status: "not-run",
        reason:
          "Runs against the packaged desktop in the release workflow with desktop-recovery.config.ts.",
      },
      cloud: na("Desktop data reset"),
      "self-host": na("Desktop data reset"),
    },
  },
  localBootstrapRotation: {
    file: "local-bootstrap.spec.ts",
    title:
      "local rotate-key replaces the saved API key where it is kept and retains the encryption key",
    targets: {
      local: {
        status: "not-run",
        reason: "Runs against the installed release archive with local-bootstrap.config.ts.",
      },
      cloud: na("Local key storage"),
      "self-host": na("Local key storage"),
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
  localWorkflowEngineMemory: {
    file: "local-workflow-engine-memory.spec.ts",
    title: "local releases finished workflow runs' engines from memory",
    targets: {
      local: scheduled,
      "self-host": na("The self-host image's engines are covered by the Docker release suite."),
      cloud: na("Cloudflare runs Cloud's workflow engines."),
    },
  },
  localWorkflowEngineSteps: {
    file: "local-workflow-engine-steps.spec.ts",
    title: "local's evictable workflow engine finishes long steps on runs no caller holds",
    targets: {
      local: scheduled,
      "self-host": na("The self-host image's engine is covered by the Docker release suite."),
      cloud: na("Cloudflare runs Cloud's workflow engines."),
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
  browserErrorProvenance: {
    fixtures: "actors",
    file: "browser-error-provenance.spec.ts",
    title: "automatic browser error reports include only failures raised by first-party scripts",
    targets: {
      cloud: managedCloud,
      "self-host": na("Cloud Sentry receiver"),
      local: na("Cloud Sentry receiver"),
    },
  },
  safariErrorProvenance: {
    file: "safari-error-provenance.spec.ts",
    title: "Safari reports only the page's own failures, not code evaluated into it",
    targets: {
      cloud: managedCloud,
      "self-host": na("Cloud Sentry receiver"),
      local: na("Cloud Sentry receiver"),
    },
  },
  hostedMalformedResourceLinks: {
    fixtures: "actors",
    file: "malformed-resource-links.spec.ts",
    title: "Hosted resource links with malformed identifiers show the missing-page state",
    targets: {
      cloud: scheduled,
      "self-host": scheduled,
      local: na("Local has no organization routes; its links run in the local scenario."),
    },
  },
  localMalformedResourceLinks: {
    file: "malformed-resource-links.spec.ts",
    title: "Local resource links with malformed identifiers show the missing-page state",
    targets: {
      local: scheduled,
      "self-host": na("Hosted links run in the organization-scoped scenario."),
      cloud: na("Hosted links run in the organization-scoped scenario."),
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
  retainedAssets: {
    fixtures: "actors",
    file: "retained-assets.spec.ts",
    title:
      "Cloud copies each build's browser files for pages on a replaced build, and files no build kept or unhashed names still 404",
    targets: {
      cloud: managedCloud,
      "self-host": na(
        "Self-host serves one build from its image; only Cloud keeps earlier deploys' files.",
      ),
      local: na(
        "Local serves one build from its install; only Cloud keeps earlier deploys' files.",
      ),
    },
  },
  browserNavigationTelemetry: {
    fixtures: "actors",
    file: "browser-navigation-telemetry.spec.ts",
    title:
      "Navigation spans cover route changes only and mark ones that started or ran while the page was hidden",
    targets: {
      cloud: scheduled,
      "self-host": scheduled,
      local: na("The hosted dashboard entry is covered on hosted targets"),
    },
  },
  browserConnectionFailures: {
    fixtures: "actors",
    file: "browser-connection-failures.spec.ts",
    title:
      "Browser connection failures explain the lost connection and report only those the browser cannot explain",
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
  emptyAccountTools: {
    fixtures: "actors",
    file: "empty-state-recovery.spec.ts",
    title: "Apps that list tools per account ask for an account instead of reporting no tools",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Shared tool browser exercised through hosted profiles."),
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
  memberLimit: {
    fixtures: "actors",
    file: "member-limit.spec.ts",
    title: "A full Free plan refuses invitations and offers an upgrade",
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
  billingPolling: {
    fixtures: "actors",
    file: "billing-polling.spec.ts",
    title:
      "Billing reconciles only while visible and polls quickly while a returned checkout settles",
    targets: {
      "self-host": na("Billing is cloud only."),
      cloud: scheduled,
      local: na("Billing is cloud only."),
    },
  },
  supersededReads: {
    fixtures: "actors",
    file: "superseded-reads.spec.ts",
    title: "A dashboard read refreshed while in flight cancels its request",
    targets: {
      "self-host": na("Billing, the page whose polled read travels alone, is cloud only."),
      cloud: scheduled,
      local: na("Billing, the page whose polled read travels alone, is cloud only."),
    },
  },
  emptyStates: {
    fixtures: "actors",
    file: "empty-states.spec.ts",
    title: "Empty states guide first use and recover from filters",
    // Account searches filter the provisioned Executor account.
    managementProfiles: ["owner"],
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
  skillCodeHighlighting: {
    fixtures: "actors",
    file: "source-highlighting.spec.ts",
    title: "Skill reader and editor highlight fenced code like the source browser",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("The shared skill reader is exercised through hosted organization routes."),
    },
  },
  skillEditor: {
    fixtures: "actors",
    file: "skill-editor.spec.ts",
    title: "Skill editor saves minimal edits, deploys them and keeps drafts on conflict",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na(
        "The shared editor and commit route are exercised through hosted organization routes.",
      ),
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
    // Statement budgets compare reads against the provisioned personal account, so setup waits for it.
    managementProfiles: ["owner"],
    file: "sdk-query-budgets.spec.ts",
    title: "SDK batches invocation accounts and finished workflow history",
    targets: {
      "self-host": scheduled,
      cloud: na("This query budget reads the self-host Motel collector."),
      local: na("This scenario uses hosted organization routes."),
    },
  },
  invocationSnapshotTransaction: {
    fixtures: "actors",
    file: "invocation-snapshot.spec.ts",
    title: "Tool invocations resolve one saved selection without holding a transaction",
    targets: {
      "self-host": scheduled,
      cloud: na("This scenario reads SQL spans from the self-host Motel collector."),
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
  localToolRunner: {
    file: "local-tool-runner.spec.ts",
    title:
      "Local tools run from the Tools tab form or JSON and show their result without bypassing approval",
    targets: {
      local: scheduled,
      "self-host": na("Hosted tool runs are covered by its organization scenarios."),
      cloud: na("Hosted tool runs are covered by its organization scenarios."),
    },
  },
  localToolRunnerForgedApproval: {
    file: "local-tool-runner.spec.ts",
    title:
      "A tool that writes and then reports it needs approval is declined without the runner claiming it did not run",
    targets: {
      local: scheduled,
      "self-host": na("The runner's completion copy is shared; local exercises it."),
      cloud: na("The runner's completion copy is shared; local exercises it."),
    },
  },
  localToolRunnerRefusal: {
    file: "local-tool-runner.spec.ts",
    title:
      "A request the Tools tab may not review shows why and how to start a new run instead of a retry",
    targets: {
      local: scheduled,
      "self-host": na("Hosted refusals are covered by its dashboard approval member scenario."),
      cloud: na("Hosted refusals are covered by its dashboard approval member scenario."),
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
    title: "Groups protect undeployed apps and independent copies",
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
    title: "Publishing dialog explains readiness, repairs names and keeps copied listings separate",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "The shared dialog is checked with response fixtures on self-host; registry authorization has separate integration coverage.",
      ),
      local: na("Local does not publish apps."),
    },
  },
  appFrameworkPin: {
    fixtures: "actors",
    managementProfiles: ["owner"],
    serverEnvironment: { EXECUTOR_DATA_STEPS: "report" },
    file: "app-framework-pin.spec.ts",
    title: "Existing apps are pinned to an explicit apps framework by a data step",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud runs the same step from its Worker's cron; see the Cloud scenario."),
      local: na("Local runs the same step at its own startup; see the local scenario."),
    },
  },
  cloudCronJobsPlaced: {
    fixtures: "actors",
    file: "cloud-database-placement.spec.ts",
    title: "Cloud cron triggers run their jobs in the API Worker's placed fetch handler",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host runs its background jobs in its own server process."),
      local: na("Local runs its background jobs in its own server process."),
    },
  },
  cloudScheduleCoordinatorPlaced: {
    fixtures: "actors",
    file: "cloud-database-placement.spec.ts",
    title:
      "Cloud cron wakes the schedule coordinator through the placed handler, and it retires the first coordinator once, keeps running scheduled runs as cloud, and is woken by the retired coordinator's minute heartbeat without cron",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host runs schedules in its own server process."),
      local: na("Local runs schedules in its own server process."),
    },
  },
  cloudScheduleWakeStream: {
    fixtures: "actors",
    file: "cloud-schedule-wakes.spec.ts",
    title:
      "Cloud runs a due schedule and requested profile setup while coordinator wakes keep arriving less than a second apart",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host checks for due work every second; it has no coordinator alarm."),
      local: na("Local checks for due work every second; it has no coordinator alarm."),
    },
  },
  deploySetup: {
    fixtures: "actors",
    file: "deploy-setup.spec.ts",
    title:
      "Deploys wake profile setup, which reaches each new deployment, a schedule's change from interval to cron and an unchanged redeploy without a reconcile",
    targets: {
      cloud: managedCloud,
      "self-host": scheduled,
      local: na("Hosted profiles and deployment API scenario"),
    },
  },
  memberSetupWake: {
    fixtures: "actors",
    file: "deploy-setup.spec.ts",
    title: "Member setup wakes profile setup from its background provisioning job",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Cloud installs a new team in its request with an immediate wake, or in its provisioning workflow, whose next step requests the schedule-wake job.",
      ),
      local: na("Local has no hosted provisioning jobs."),
    },
  },
  cloudMcpObjectConnections: {
    fixtures: "actors",
    file: "cloud-database-placement.spec.ts",
    title:
      "Cloud MCP session objects hold their database connections across calls and close them when idle",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host MCP sessions run in its server process with its own pool."),
      local: na("Local MCP sessions use the local database."),
    },
  },
  cloudMcpObjectConnectRetry: {
    fixtures: "actors",
    file: "cloud-database-placement.spec.ts",
    title: "Cloud MCP session objects make a stalled database connection attempt once more",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host MCP sessions run in its server process with its own pool."),
      local: na("Local MCP sessions use the local database."),
    },
  },
  cloudMcpSessionTiming: {
    fixtures: "actors",
    file: "cloud-mcp-session-timing.spec.ts",
    title:
      "Cloud MCP session objects report their own handling time and the requests they were already answering",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host serves MCP sessions in its server process, with no gateway hop."),
      local: na("Local serves MCP sessions in its server process, with no gateway hop."),
    },
  },
  cloudMcpStreamLifetime: {
    fixtures: "actors",
    file: "cloud-mcp-stream-lifetime.spec.ts",
    title:
      "Cloud MCP request spans say whether the session holds the response open, and each close records how long it stayed open",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host serves MCP sessions in its server process, with no gateway hop."),
      local: na("Local serves MCP sessions in its server process, with no gateway hop."),
    },
  },
  cloudAppFrameworkPin: {
    fixtures: "actors",
    file: "app-framework-pin.spec.ts",
    title: "Cloud reports the framework pin data step from the Worker's cron",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host runs the same step at its startup in the hosted scenario."),
      local: na("Local runs the same step at its startup in the local scenario."),
    },
  },
  localAppFrameworkPin: {
    serverEnvironment: { EXECUTOR_DATA_STEPS: "report" },
    file: "app-framework-pin.spec.ts",
    title: "Existing apps are pinned to an explicit apps framework at local startup",
    targets: {
      local: scheduled,
      "self-host": na("Self-host runs the same step at its startup in the hosted scenario."),
      cloud: na("Cloud runs the same step from its Worker's cron in the Cloud scenario."),
    },
  },
  appPackageMetadata: {
    fixtures: "actors",
    file: "app-package-metadata.spec.ts",
    title: "Quick-add MCP apps retain package names independently of installed labels",
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
    title: "Skill-authored templates route shared tools to explicitly selected accounts",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses loopback upstream fixtures for the shared protocol templates."),
      local: na("Exercises the hosted deployment and profile APIs."),
    },
  },
  templateAccountsRecursiveOutput: {
    fixtures: "actors",
    file: "template-accounts.spec.ts",
    title: "Account-routed MCP results are checked against recursive output schemas",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a loopback MCP upstream fixture."),
      local: na("Exercises the hosted deployment and profile APIs."),
    },
  },
  templateAccountsRouterForms: {
    fixtures: "actors",
    file: "template-accounts.spec.ts",
    title:
      "Account routers of hand-written and synchronous callbacks type-check and route per account",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses loopback upstream fixtures for the shared protocol templates."),
      local: na("Exercises the hosted deployment and profile APIs."),
    },
  },
  cloudDashboardRoutes: {
    file: "cloud-dashboard-routes.spec.ts",
    title: "Cloud dashboard deep links preserve API, docs, asset and not-found routing",
    targets: {
      cloud: scheduled,
      "self-host": na("Cloudflare's static asset rewrites are Cloud-only."),
      local: na("Cloudflare's static asset rewrites are Cloud-only."),
    },
  },
  openAiAppsChallenge: {
    file: "openai-apps-challenge.spec.ts",
    title: "Cloud serves the ChatGPT app domain verification token at its exact path",
    targets: {
      cloud: scheduled,
      "self-host": na("ChatGPT app domain verification is for the hosted Cloud domain."),
      local: na("ChatGPT app domain verification is for the hosted Cloud domain."),
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
  appFrameworkUpgrade: {
    fixtures: "actors",
    file: "app-framework-upgrade.spec.ts",
    title: "Single-file apps keep their framework across host upgrades",
    targets: {
      // #843 added this entry without its spec file; CI's runs on main showed it never ran.
      "self-host": {
        status: "not-run",
        reason: "e2e/tests/app-framework-upgrade.spec.ts does not exist yet.",
      },
      cloud: na(
        "This scenario restarts the product with another prepared runtime; Cloud shares the Worker compiler and framework storage.",
      ),
      local: na(
        "This scenario uses hosted routes; Local shares the same workerd compiler and framework storage.",
      ),
    },
  },
  appProtocol1: {
    fixtures: "actors",
    file: "app-older-protocols.spec.ts",
    title: "Protocol-1 builds keep working on the router host",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "This scenario serves archives and restarts the product on loopback; Cloud shares the protocol adapters.",
      ),
      local: na(
        "This scenario uses hosted routes; Local shares the same workerd runtime and protocol adapters.",
      ),
    },
  },
  appProtocol2: {
    fixtures: "actors",
    file: "app-older-protocols.spec.ts",
    title: "Protocol-2 builds keep working on the router host",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "This scenario serves archives and restarts the product on loopback; Cloud shares the protocol adapters.",
      ),
      local: na(
        "This scenario uses hosted routes; Local shares the same workerd runtime and protocol adapters.",
      ),
    },
  },
  appProtocol3: {
    fixtures: "actors",
    file: "app-older-protocols.spec.ts",
    title: "Protocol-3 builds keep working on the router host",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "This scenario serves archives and restarts the product on loopback; Cloud shares the protocol adapters.",
      ),
      local: na(
        "This scenario uses hosted routes; Local shares the same workerd runtime and protocol adapters.",
      ),
    },
  },
  appProtocol5: {
    fixtures: "actors",
    file: "app-router-protocols.spec.ts",
    title: "Protocol-5 builds keep working on the current host",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "This scenario serves archives and restarts the product on loopback; Cloud shares the protocol adapters.",
      ),
      local: na(
        "This scenario uses hosted routes; Local shares the same workerd runtime and protocol adapters.",
      ),
    },
  },
  appProtocol7: {
    fixtures: "actors",
    file: "app-router-protocols.spec.ts",
    title: "Protocol-7 builds keep working on the current host",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "This scenario serves archives and restarts the product on loopback; Cloud shares the protocol adapters.",
      ),
      local: na(
        "This scenario uses hosted routes; Local shares the same workerd runtime and protocol adapters.",
      ),
    },
  },
  appProtocol8: {
    fixtures: "actors",
    file: "app-router-protocols.spec.ts",
    title: "Protocol-8 builds keep working on the current host",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "This scenario serves archives and restarts the product on loopback; Cloud shares the protocol adapters.",
      ),
      local: na(
        "This scenario uses hosted routes; Local shares the same workerd runtime and protocol adapters.",
      ),
    },
  },
  appProtocol5Credentials: {
    fixtures: "actors",
    file: "app-router-protocols.spec.ts",
    title: "Protocol-5 builds read real credential values",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "This scenario serves archives and restarts the product on loopback; Cloud shares the protocol adapters.",
      ),
      local: na(
        "This scenario uses hosted routes; Local shares the same workerd runtime and protocol adapters.",
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
  supportDialog: {
    fixtures: "actors",
    file: "support-dialog.spec.ts",
    title: "Cloud support dialog lists every channel across sidebar layouts and records its use",
    targets: {
      cloud: managedCloud,
      "self-host": scheduled,
      local: na("The local dashboard is covered by its own support scenario."),
    },
  },
  localSupportDialog: {
    file: "local-support-dialog.spec.ts",
    title: "local dashboard keeps its resource links without the Cloud support dialog",
    targets: {
      local: scheduled,
      "self-host": na("The hosted support scenario checks self-host."),
      cloud: na("The hosted support scenario checks Cloud."),
    },
  },
  feedback: {
    fixtures: "actors",
    file: "feedback.spec.ts",
    title: "Hosted feedback enforces its API contract and reaches the local ingestion service",
    targets: {
      cloud: managedCloud,
      "self-host": scheduled,
      local: na("Local feedback has no organization; the local analytics scenario covers it."),
    },
  },
  selfHostAnalytics: {
    fixtures: "actors",
    file: "instance-analytics.spec.ts",
    title:
      "self-host analytics pseudonymize people, report a private domain and send no names or IDs",
    managementProfiles: ["owner"],
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud sends request-owned analytics; the Cloud product analytics scenario."),
      local: na("Local has no people; the local analytics scenario covers its install ID."),
    },
  },
  selfHostAnalyticsOptOut: {
    fixtures: "actors",
    file: "instance-analytics.spec.ts",
    title: "self-host with DO_NOT_TRACK sends nothing and reports feedback as disabled",
    managementProfiles: ["owner"],
    serverEnvironment: { DO_NOT_TRACK: "1" },
    targets: {
      "self-host": scheduled,
      cloud: na("Operators of self-run installations opt out; Cloud has no such setting."),
      local: na("The local opt-out scenario covers local."),
    },
  },
  selfHostAnalyticsRootDomain: {
    file: "instance-analytics.spec.ts",
    title: "self-host analytics report the registrable domain of a public origin",
    serverEnvironment: { BETTER_AUTH_URL: "https://executor.platform.acme.co.uk" },
    targets: {
      "self-host": scheduled,
      cloud: na("Only self-host reports a root domain."),
      local: na("Only self-host reports a root domain."),
    },
  },
  selfHostAnalyticsTunnelDomain: {
    file: "instance-analytics.spec.ts",
    title: "self-host analytics report a tunnel origin as private",
    serverEnvironment: { BETTER_AUTH_URL: "https://agent-box-7f3a.ngrok-free.app" },
    targets: {
      "self-host": scheduled,
      cloud: na("Only self-host reports a root domain."),
      local: na("Only self-host reports a root domain."),
    },
  },
  localAnalytics: {
    file: "instance-analytics.spec.ts",
    title: "CLI analytics use the install ID, accept feedback and send no names or inputs",
    targets: {
      local: scheduled,
      "self-host": na("The self-host analytics scenario covers hosted identity."),
      cloud: na("Cloud sends request-owned analytics; the Cloud product analytics scenario."),
    },
  },
  localAnalyticsOptOut: {
    file: "instance-analytics.spec.ts",
    title: "CLI with EXECUTOR_DISABLE_ANALYTICS sends nothing and reports feedback as disabled",
    serverEnvironment: { EXECUTOR_DISABLE_ANALYTICS: "1" },
    targets: {
      local: scheduled,
      "self-host": na("The self-host opt-out scenario covers self-host."),
      cloud: na("Operators of self-run installations opt out; Cloud has no such setting."),
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
  accountHealth: {
    fixtures: "actors",
    file: "account-health.spec.ts",
    title: "Apps check a shared account their own way and report its identity",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a controlled loopback service through the shared runtime contract."),
      local: na("The shared SDK and account view are exercised through hosted APIs."),
    },
  },
  mcpAccountHealth: {
    fixtures: "actors",
    file: "mcp-account-health.spec.ts",
    title: "An MCP provider checks an account by connecting to its server with it",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a controlled loopback MCP server through the shared runtime contract."),
      local: na("The shared framework check and SDK are exercised through hosted APIs."),
    },
  },
  providerErrorsGraphql: {
    fixtures: "actors",
    file: "provider-errors.spec.ts",
    title: "Provider failures retain safe reasons and account recovery over GraphQL",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses controlled loopback providers through the shared runtime contract."),
      local: na("Shared error views and SDK are exercised through hosted APIs."),
    },
  },
  providerErrorsMcp: {
    fixtures: "actors",
    file: "provider-errors.spec.ts",
    title: "Provider failures retain safe reasons and account recovery over MCP",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses controlled loopback providers through the shared runtime contract."),
      local: na("Shared error views and SDK are exercised through hosted APIs."),
    },
  },
  providerErrorsOpenapi: {
    fixtures: "actors",
    file: "provider-errors.spec.ts",
    title: "Provider failures retain safe reasons and account recovery over OpenAPI",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses controlled loopback providers through the shared runtime contract."),
      local: na("Shared error views and SDK are exercised through hosted APIs."),
    },
  },
  providerErrorsCustom: {
    fixtures: "actors",
    file: "provider-errors.spec.ts",
    title: "Provider failures retain safe reasons and account recovery from custom providers",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses controlled loopback providers through the shared runtime contract."),
      local: na("Shared error views and SDK are exercised through hosted APIs."),
    },
  },
  catalogAgentSetup: {
    fixtures: "actors",
    file: "catalog-agent-setup.spec.ts",
    title: "Catalog services without quick add copy an agent setup prompt",
    targets: {
      "self-host": scheduled,
      cloud: na("The shared catalog view and install rule are exercised through self-host."),
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
  cloudCompilerConcurrency: {
    fixtures: "actors",
    file: "cloud-compiler.spec.ts",
    title: "Concurrent Cloud deploys that install npm packages all compile",
    targets: {
      cloud: { status: "scheduled", runtime: "attached" },
      "self-host": na("This scenario requires Cloudflare's compiler Worker memory limit."),
      local: na("This scenario requires Cloudflare's compiler Worker memory limit."),
    },
  },
  cloudCompilerDeadline: {
    fixtures: "actors",
    file: "cloud-compiler.spec.ts",
    title: "Cloud deploys fail promptly when the compiler does not answer",
    targets: {
      cloud: managedCloud,
      "self-host": na("This scenario exercises the Cloud compiler Worker binding."),
      local: na("This scenario exercises the Cloud compiler Worker binding."),
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
  cloudCompilerUiFiles: {
    fixtures: "actors",
    file: "cloud-compiler.spec.ts",
    title: "Cloud builds keep large UI files out of the server bundle",
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
  oauthPlanetscale: {
    fixtures: "actors",
    file: "oauth-planetscale.spec.ts",
    title: "A registered PlanetScale client completes sign-in and reaches PlanetScale's MCP server",
    targets: {
      "self-host": na(
        "PlanetScale accepts only HTTPS or bare loopback redirects; self-host tests a named loopback callback.",
      ),
      cloud: scheduled,
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthSavedClientRejection: {
    fixtures: "actors",
    file: "oauth-saved-client-rejection.spec.ts",
    title:
      "A rejected client Executor registered is discarded only in the version the sign-in used, and entered clients are kept",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer with controlled wire responses."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthErrorResponses: {
    fixtures: "actors",
    file: "oauth-error-responses.spec.ts",
    title:
      "OAuth classifies token and callback error responses, accepts ID token algorithms advertised only in OpenID metadata, and rejects unsigned and mismatched ID tokens",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer with controlled wire responses."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthDeclaredTokenResponses: {
    fixtures: "actors",
    file: "oauth-provider-token-responses.spec.ts",
    title:
      "Declared OAuth endpoints accept real services' token responses, including Slack, Shopify and Mailchimp shapes and null members, on sign-in and renewal, and reject DPoP",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer with controlled wire responses."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthDiscoveredTokenResponses: {
    fixtures: "actors",
    file: "oauth-provider-token-responses.spec.ts",
    title:
      "Discovered OAuth servers accept real services' token responses, including Slack, Shopify and Mailchimp shapes and null members, on sign-in and renewal, and reject DPoP",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer with controlled wire responses."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthNestedTokenResponse: {
    fixtures: "actors",
    file: "oauth-provider-token-responses.spec.ts",
    title:
      "A declared nested OAuth token response reads Slack's user-only authed_user grant on sign-in and renewal",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer with controlled wire responses."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthJsonTokenRequests: {
    fixtures: "actors",
    file: "oauth-provider-token-responses.spec.ts",
    title:
      "A declared JSON token request format signs in and renews against a service that reads only JSON token requests",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer with controlled wire responses."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthEmptyTokenScope: {
    fixtures: "actors",
    file: "oauth-provider-token-responses.spec.ts",
    title:
      "An empty OAuth token scope reaches app code on sign-in and replaces the granted scope on renewal",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer with controlled wire responses."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  appWorkerCredentialRotation: {
    fixtures: "actors",
    file: "app-worker-reuse.spec.ts",
    title:
      "app Workers stay loaded across credential rotation without sharing one account's state with another",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("Local key replacement is covered by the local app Worker reuse scenario."),
    },
  },
  appWorkerWorkflowRuns: {
    fixtures: "actors",
    file: "app-worker-reuse.spec.ts",
    title: "workflow runs reuse the app Worker and deliver their own run context",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("Local workflow runs are covered by the local app Worker reuse scenario."),
    },
  },
  credentialHostsRefused: {
    fixtures: "actors",
    file: "credential-hosts.spec.ts",
    title:
      "secret fields reach app code as handles that neither undeclared hosts nor other apps can use",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local runs apps through the same workerd runner and outbound as self-host."),
    },
  },
  appFetchPrivateRefused: {
    fixtures: "actors",
    file: "app-fetch-errors.spec.ts",
    title:
      "an app's fetch to a private address fails as Executor's refusal and never reaches the address",
    serverEnvironment: { EXECUTOR_APPS_ALLOW_PRIVATE_FETCH: "false" },
    targets: {
      "self-host": scheduled,
      // The local test Worker lets apps reach the scenarios' loopback fixtures.
      cloud: { status: "scheduled", runtime: "attached" },
      local: na("Local lets app code reach private addresses by design."),
    },
  },
  appEgressFailures: {
    fixtures: "actors",
    file: "app-egress-failures.spec.ts",
    title:
      "an app request Executor's network failed to send fails every fetch the app can reach, and only Executor's own failures are reported",
    targets: {
      "self-host": scheduled,
      // Reads the local Sentry collector; the scenario reaches loopback fixtures.
      cloud: managedCloud,
      local: na(
        "Hosted app routes; local runs apps with the same runner and has no outbound network in front of it.",
      ),
    },
  },
  appFetchUnsupportedOption: {
    fixtures: "actors",
    file: "app-fetch-errors.spec.ts",
    title: "ctx.fetch names a RequestInit option the app runtime does not implement",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na(
        "Hosted app routes; local runs the same framework fetch in the same workerd runner.",
      ),
    },
  },
  credentialHostsRefusedData: {
    fixtures: "actors",
    file: "credential-hosts.spec.ts",
    title: "a data facet's secret fields are handles that undeclared hosts cannot use",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local runs apps through the same workerd runner and outbound as self-host."),
    },
  },
  credentialHostsForm: {
    fixtures: "actors",
    file: "credential-hosts.spec.ts",
    title: "the connect form says where credentials can go and shows plain fields",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("The hosted and local dashboards share the credential form."),
    },
  },
  credentialHostsGranted: {
    fixtures: "actors",
    file: "credential-hosts.spec.ts",
    title:
      "an account sends its secrets only to the hosts it was connected for, in every app that selects it",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a loopback service; Cloud app Workers reach only public addresses."),
      local: na("Local runs apps through the same workerd runner and outbound as self-host."),
    },
  },
  credentialHostsProduct: {
    fixtures: "actors",
    file: "credential-hosts.spec.ts",
    title: "a sealed API key reaches the product's own API through the app's outbound network",
    targets: {
      "self-host": scheduled,
      cloud: { status: "scheduled", runtime: "attached" },
      local: na("Local runs apps through the same workerd runner and outbound as self-host."),
    },
  },
  credentialHostsSubstituted: {
    fixtures: "actors",
    file: "credential-hosts.spec.ts",
    title:
      "the outbound network substitutes secret fields for declared hosts and hides echoed values",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a loopback service; Cloud app Workers reach only public addresses."),
      local: na("Local runs apps through the same workerd runner and outbound as self-host."),
    },
  },
  appWorkerSharedContexts: {
    fixtures: "actors",
    file: "app-worker-reuse.spec.ts",
    title:
      "tool calls and workflow runs share one account's app Worker, its outbound fetch and no other account's state",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Uses a loopback resource; Cloud app Workers fetch through one fixed service binding.",
      ),
      local: na("Local calls and runs are covered by the local app Worker reuse scenario."),
    },
  },
  localAppWorkerReuse: {
    file: "local-app-worker-reuse.spec.ts",
    title:
      "local key replacement, tool calls and workflow runs reuse one account's app Worker and its outbound fetch",
    targets: {
      local: scheduled,
      "self-host": na("Hosted Worker reuse is covered through organization routes."),
      cloud: na("Hosted Worker reuse is covered through organization routes."),
    },
  },
  appWorkerColdStartFailure: {
    fixtures: "actors",
    file: "app-worker-reuse.spec.ts",
    title:
      "an app Worker whose cold start failed loads on the next call once its build is readable",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Cloud builds are read from R2 through the Cache API, which a scenario cannot make unreadable; the shared runner's recovery is covered on self-host.",
      ),
      local: na(
        "Self-host covers the shared runner's cold start recovery; the local reuse scenario covers local's app Workers.",
      ),
    },
  },
  appBuildLoads: {
    fixtures: "actors",
    file: "app-worker-reuse.spec.ts",
    title:
      "warm app calls load no build, and accounts sharing or neighbouring a Worker keep their own credentials",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na(
        "Self-host covers the shared build loader; the local reuse scenario covers local's app Workers.",
      ),
    },
  },
  appWorkerAttribution: {
    fixtures: "actors",
    file: "app-worker-reuse.spec.ts",
    title: "Cloud app calls attribute their loaded Worker to the calling organization and user",
    targets: {
      "self-host": na("Only Cloud's Worker Loader bills each loaded Worker."),
      cloud: managedCloud,
      local: na("Only Cloud's Worker Loader bills each loaded Worker."),
    },
  },
  appWorkerOAuthRefresh: {
    fixtures: "actors",
    file: "app-worker-reuse.spec.ts",
    title: "OAuth token renewal reuses the app Worker and delivers each renewed token",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  appWorkerReleaseHeld: {
    fixtures: "actors",
    file: "app-worker-budget.spec.ts",
    title: "an app Worker whose release outlives its limit stays loaded until the release settles",
    serverEnvironment: { EXECUTOR_APP_WORKERS: "1" },
    targets: {
      "self-host": scheduled,
      cloud: na("Cloudflare unloads Cloud's app Workers itself."),
      local: na(
        "Self-host covers the shared runner's Worker residency; the local budget scenario covers local's limit.",
      ),
    },
  },
  appDataFacetUnloadedAfterEviction: {
    fixtures: "actors",
    file: "app-worker-budget.spec.ts",
    title: "a data facet replaced after its supervisor was evicted is still unloaded",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloudflare unloads Cloud's facet Workers itself."),
      local: na(
        "Self-host covers the shared runner's facet unloading; the local budget scenario covers local's limit.",
      ),
    },
  },
  oauthRefreshResilience: {
    fixtures: "actors",
    file: "oauth-refresh-resilience.spec.ts",
    title:
      "OAuth renewal keeps the grant through outages and unreadable responses, reconnects only when refused, and traces the cause",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer with controlled token endpoint failures."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthRenewalAheadOfExpiry: {
    fixtures: "actors",
    file: "oauth-refresh-resilience.spec.ts",
    title:
      "OAuth renewal ahead of expiry that fails transiently uses the still-valid token and traces the failure, renews after recovery, and fails once the token has expired",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer with controlled token endpoint failures."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  accountCacheScope: {
    fixtures: "actors",
    file: "account-cache-scope.spec.ts",
    title:
      "Account cache scopes stay the same across sealed calls, ignore credential size and never share",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local runs apps through the same workerd runner and cache as self-host."),
    },
  },
  oauthCacheScope: {
    fixtures: "actors",
    file: "oauth-cache-scope.spec.ts",
    title: "Account cache scopes survive OAuth renewal and start empty after a reconnect",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer that renews tokens on every use."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthRenewalOnRefusal: {
    fixtures: "actors",
    file: "oauth-refresh-resilience.spec.ts",
    title:
      "OAuth renews a grant without a stated lifetime when the service refuses its token, repeats only queries, and reconnects when renewal is refused",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer and resource with controlled token expiry."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthListingRenewalOnRefusal: {
    fixtures: "actors",
    file: "oauth-refresh-resilience.spec.ts",
    title:
      "OAuth tool listing renews a grant the service refuses while the catalog is evaluated, keeps only the renewed listing, and reconnects when renewal is refused",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer and resource with controlled token expiry."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthScheduledRenewal: {
    fixtures: "actors",
    file: "oauth-scheduled-renewal.spec.ts",
    title:
      "Scheduled and approved calls renew a grant without a stated lifetime when the service refuses its token",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer and resource with controlled token expiry."),
      local: na("Exercises the shared scheduler and OAuth lifecycle through hosted APIs."),
    },
  },
  oauthReconnectSchedules: {
    fixtures: "actors",
    file: "oauth-reconnect-schedules.spec.ts",
    title:
      "A schedule whose account must reconnect skips its occurrences without running, shows the account, and resumes after reconnecting",
    targets: {
      "self-host": scheduled,
      cloud: na("Advances the wall clock of a runner-owned product process."),
      local: na("Exercises the shared scheduler and OAuth lifecycle through hosted APIs."),
    },
  },
  oauthRenewalKilledBeforeProvider: {
    fixtures: "actors",
    file: "oauth-renewal-interruption.spec.ts",
    title:
      "OAuth renewal recovers within an execute deadline after the process dies before the service processes it",
    targets: {
      "self-host": scheduled,
      cloud: na("Kills and restarts a runner-owned product process."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthRenewalKilledAfterRotation: {
    fixtures: "actors",
    file: "oauth-renewal-interruption.spec.ts",
    title:
      "OAuth renewal reports an interruption after the process dies holding a rotated token it never saved",
    targets: {
      "self-host": scheduled,
      cloud: na("Kills and restarts a runner-owned product process."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthRenewalKilledInReuseWindow: {
    fixtures: "actors",
    file: "oauth-renewal-interruption.spec.ts",
    title:
      "OAuth renewal recovers after the process dies holding a rotated token while the service still accepts the replaced one",
    targets: {
      "self-host": scheduled,
      cloud: na("Kills and restarts a runner-owned product process."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthRenewalKilledAfterSave: {
    fixtures: "actors",
    file: "oauth-renewal-interruption.spec.ts",
    title: "OAuth renewal keeps a saved rotated token after the process dies",
    targets: {
      "self-host": scheduled,
      cloud: na("Kills and restarts a runner-owned product process."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthRenewalSlowLiveHolder: {
    fixtures: "actors",
    file: "oauth-renewal-interruption.spec.ts",
    title: "OAuth renewal keeps its claim through a slow token response while other calls wait",
    targets: {
      "self-host": scheduled,
      cloud: na("Holds a runner-owned token endpoint response for longer than a lease."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthRenewalCallerDisconnects: {
    fixtures: "actors",
    file: "oauth-renewal-interruption.spec.ts",
    title: "OAuth renewal saves a rotated token after its caller disconnects",
    targets: {
      "self-host": scheduled,
      cloud: na("Holds a runner-owned token endpoint response while its caller disconnects."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthRenewalDiesDuringRecovery: {
    fixtures: "actors",
    file: "oauth-renewal-interruption.spec.ts",
    title: "OAuth renewal converges after the process dies again during its recovery",
    targets: {
      "self-host": scheduled,
      cloud: na("Kills and restarts a runner-owned product process."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthRenewalRecoveredNewestToken: {
    fixtures: "actors",
    file: "oauth-renewal-interruption.spec.ts",
    title: "OAuth renewal recovered after a crash and an outage keeps the newest refresh token",
    targets: {
      "self-host": scheduled,
      cloud: na("Kills and restarts a runner-owned product process."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  appBuildFailureDetails: {
    fixtures: "actors",
    managementProfiles: ["owner"],
    file: "app-failure-details.spec.ts",
    title: "Failed deploys report their build stage, source location and underlying error",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted deploy routes and management app; local shares the workerd build path."),
    },
  },
  appSourceImports: {
    fixtures: "actors",
    file: "app-source-imports.spec.ts",
    title: "Deploys load NodeNext .js imports from TypeScript sources and npm package subpaths",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted deploy routes; local shares the workerd build path."),
    },
  },
  appOperationFailureDetails: {
    fixtures: "actors",
    managementProfiles: ["owner"],
    file: "app-failure-details.spec.ts",
    title: "Failed app operations return the app's own error message to HTTP and MCP callers",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted app routes; the framework failure path is shared with local."),
    },
  },
  importDiagnostics: {
    fixtures: "actors",
    managementProfiles: ["owner"],
    file: "import-diagnostics.spec.ts",
    title: "Agents learn safely when an MCP server needs them to write the app",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a loopback MCP server to exercise the shared importer."),
      local: na("The shared importer is exercised through the hosted import route."),
    },
  },
  oauthRevocation: {
    fixtures: "actors",
    file: "oauth-revocation.spec.ts",
    title: "OAuth account deletion revokes the refresh token and succeeds when revocation fails",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer that records revocation requests."),
      local: na("Exercises the shared SDK account deletion through hosted APIs."),
    },
  },
  credentialAdapterRenewal: {
    fixtures: "actors",
    file: "oauth-credential-adapter.spec.ts",
    title:
      "with a credential adapter configured, the adapter makes every OAuth renewal and keeps the rotated refresh token, a restarted host renews from the adapter's seal, and a renewal interrupted after the token rotated resumes from the adapter's new seal",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud has no credential adapter setting; only self-host reads it."),
      local: na(
        "Local has no credential adapter setting; the shared OAuth lifecycle runs through hosted APIs.",
      ),
    },
  },
  credentialAdapterRefusals: {
    fixtures: "actors",
    file: "oauth-credential-adapter.spec.ts",
    title:
      "a credential adapter's refusals and outages are classified like the service's own answers: a refused client, a rate limit, an unknown error code and an outage keep the grant, invalid_grant reconnects, and a grant without a refresh token reconnects without asking the adapter",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud has no credential adapter setting; only self-host reads it."),
      local: na(
        "Local has no credential adapter setting; the shared OAuth lifecycle runs through hosted APIs.",
      ),
    },
  },
  credentialAdapterRevocation: {
    fixtures: "actors",
    file: "oauth-credential-adapter.spec.ts",
    title:
      "deleting an account under a credential adapter revokes the refresh token the adapter holds",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud has no credential adapter setting; only self-host reads it."),
      local: na(
        "Local has no credential adapter setting; the shared OAuth lifecycle runs through hosted APIs.",
      ),
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
  oauthFailureDiagnostics: {
    fixtures: "actors",
    file: "oauth-diagnostics.spec.ts",
    title:
      "OAuth failures deliver safe provider, challenge, claim and callback diagnostics, and a successful discovery fallback records no error",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer to provoke OAuth failures."),
      local: na("Exercises shared OAuth instrumentation through hosted APIs."),
    },
  },
  mcpAuthDiscovery: {
    fixtures: "actors",
    file: "mcp-auth-discovery.spec.ts",
    title:
      "MCP quick add confirms public or OAuth servers, checks OAuth accounts against the server and sends others to agent setup",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback MCP issuer."),
      local: na("Exercises the shared import and OAuth implementation through hosted APIs."),
    },
  },
  mcpAuthDetectionPublic: {
    fixtures: "actors",
    file: "mcp-auth-detection.spec.ts",
    title: "MCP quick add imports public servers and keeps the OAuth a public server also offers",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud egress refuses loopback MCP hosts, so no Cloud scenario imports one."),
      local: na("Exercises the shared importer through the hosted import route."),
    },
  },
  mcpAuthDetectionOAuth: {
    fixtures: "actors",
    file: "mcp-auth-detection.spec.ts",
    title: "MCP quick add imports OAuth servers and connects each with the client it needs",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud egress refuses loopback MCP hosts, so no Cloud scenario imports one."),
      local: na("Exercises the shared importer and OAuth setup through hosted APIs."),
    },
  },
  mcpAuthDetectionSetup: {
    fixtures: "actors",
    file: "mcp-auth-detection.spec.ts",
    title: "MCP quick add explains servers it cannot add with the signals that decided",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud egress refuses loopback MCP hosts, so no Cloud scenario imports one."),
      local: na("Exercises the shared importer and its error view through hosted pages."),
    },
  },
  importApprovals: {
    fixtures: "actors",
    file: "import-approvals.spec.ts",
    title: "Imported destructive tools wait for approval through rules in the app's source",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud egress refuses loopback MCP hosts, so no Cloud scenario imports one."),
      local: na("Exercises the hosted import, API key and MCP resume APIs."),
    },
  },
  mcpUrlDefaults: {
    fixtures: "actors",
    file: "mcp-url-defaults.spec.ts",
    title: "Custom MCP imports apply provider tool defaults",
    targets: {
      "self-host": scheduled,
      cloud: na("Import generation is shared; self-host covers it without contacting providers."),
      local: na("Exercises the shared import implementation through hosted APIs."),
    },
  },
  mcpDeferredSetup: {
    fixtures: "actors",
    file: "mcp-deferred-setup.spec.ts",
    title: "MCP outages block quick add with a retry and recover in account setup and tools",
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
  apiDocumentPatterns: {
    file: "api-document-patterns.spec.ts",
    title: "the published API document keeps the string patterns requests must match",
    targets: { local: scheduled, "self-host": scheduled, cloud: scheduled },
  },
  toolIndexRedeploy: {
    fixtures: "actors",
    file: "tool-index-redeploy.spec.ts",
    title: "a deploy changes a profile's MCP tools and its setup settles without a profile update",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted profiles and deployment API scenario"),
    },
  },
  appDeclarations: {
    fixtures: "actors",
    file: "app-declarations.spec.ts",
    title:
      "evaluated app declarations are reused only for identical inputs and never bypass access",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted members and app access use organization routes; see localAppDeclarations."),
    },
  },
  appDeclarationsOAuth: {
    fixtures: "actors",
    file: "app-declarations-oauth.spec.ts",
    title:
      "kept app declarations and tool listings are refused once an OAuth grant needs reconnecting",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback token service; the grant check is shared SDK code."),
      local: na("Exercises shared OAuth through the hosted API."),
    },
  },
  localAppDeclarations: {
    file: "local-app-declarations.spec.ts",
    title:
      "local app declarations follow credentials and deployments and refresh in the background while stale",
    targets: {
      local: scheduled,
      "self-host": na("Hosted declaration reuse is covered by appDeclarations."),
      cloud: na("Hosted declaration reuse is covered by appDeclarations."),
    },
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
  workspaceSourceWrites: {
    fixtures: "actors",
    file: "workspace-source-writes.spec.ts",
    title: "Workspace reads return source saved by Git pushes and commits",
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
  providerPhoto: {
    file: "provider-photo.spec.ts",
    title: "Linking Google adds its photo to the account menu and members list",
    targets: cloudOnboarding,
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
  desktopDownloads: {
    fixtures: "actors",
    file: "desktop-downloads.spec.ts",
    title:
      "Homepage desktop downloads link to the newest published v2 release and fall back to the releases page",
    targets: {
      cloud: scheduled,
      "self-host": na("Self-host does not serve the marketing site."),
      local: na("Local does not serve the marketing site."),
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
      "Signed-in root restores Apps at its canonical address without a browser organization lookup or reload",
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
  pastedCredentialsNamedAfterSaving: {
    fixtures: "actors",
    file: "account-naming.spec.ts",
    title:
      "Pasted credentials are named in a dialog over the app after saving, default to the first free name, and keep the name when replaced",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local naming is covered by the local account naming scenarios."),
    },
  },
  accountCheckFailureDetail: {
    fixtures: "actors",
    file: "account-check-failures.spec.ts",
    title:
      "The credential form shows an app check's own failure message with the credential redacted",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("The hosted and local dashboards share the credential form and check contract."),
    },
  },
  accountDescriptions: {
    fixtures: "actors",
    file: "account-descriptions.spec.ts",
    title:
      "An account description is set when naming a new account, shown in the account list, edited and cleared",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na(
        "The local dashboard shares the naming and edit forms; its API and MCP have their own scenario.",
      ),
    },
  },
  localAccountDescriptions: {
    file: "local-account-descriptions.spec.ts",
    title:
      "An account description set through the account API is returned with the account, shown to agents once with its profile, kept on rename and removed with null",
    targets: {
      local: scheduled,
      "self-host": na(
        "The local account API and MCP backend; hosted descriptions have their own scenario.",
      ),
      cloud: na(
        "The local account API and MCP backend; hosted descriptions have their own scenario.",
      ),
    },
  },
  localPastedCredentialsNamedAfterSaving: {
    file: "local-account-naming.spec.ts",
    title:
      "Local pasted credentials connect only through an app, are named in a dialog on the app's accounts, and keep the name when replaced there",
    targets: {
      local: scheduled,
      "self-host": na("Paired local dashboard; hosted naming has its own scenario."),
      cloud: na("Paired local dashboard; hosted naming has its own scenario."),
    },
  },
  localOAuthNamedAfterReturn: {
    file: "local-account-naming.spec.ts",
    title:
      "A new local OAuth account is named in a dialog after sign-in returns to its app, and a reconnect from the app keeps its name",
    targets: {
      local: scheduled,
      "self-host": na("Paired local dashboard; hosted OAuth naming has its own scenario."),
      cloud: na("Paired local dashboard; hosted OAuth naming has its own scenario."),
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
      "Rejected OAuth clients remain editable, other failures retry without blaming the client, and replacements commit only after successful sign-in",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Hosted callback routing and saved-client management."),
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
  oauthNameAfterConnect: {
    fixtures: "actors",
    file: "oauth-connect-storyboard.spec.ts",
    title:
      "A new OAuth account returns to its app to be named, keeps its default name when closed, and a reconnect from the app keeps its name",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Hosted redirect returns to the app; local OAuth naming has its own scenario."),
    },
  },
  connectionLinkTargetChanged: {
    fixtures: "actors",
    file: "connection-link-target-changed.spec.ts",
    title:
      "A connection link issued before its app switched from OAuth to an API key reports the change without contacting the old sign-in",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer to count registrations."),
      local: na("Local links call the SDK without a read first; they have their own scenario."),
    },
  },
  localConnectionLinkTargetChanged: {
    file: "connection-link-target-changed.spec.ts",
    title:
      "A local connection page opened before its app changed provider replaces its sign-in or key form with the change",
    targets: {
      local: scheduled,
      "self-host": na(
        "Hosted connection routes read the request first; they have their own scenario.",
      ),
      cloud: na("Hosted connection routes read the request first; they have their own scenario."),
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
  oauthMicrosoftEntra: {
    fixtures: "actors",
    file: "oauth-interop.spec.ts",
    title:
      "OAuth signs in to Microsoft Entra without a resource indicator and checks each tenant's ID token issuer",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Exercises shared OAuth discovery and exchange through the hosted API."),
    },
  },
  oauthEntraRefreshTenant: {
    fixtures: "actors",
    file: "oauth-interop.spec.ts",
    title:
      "OAuth renews a Microsoft Entra multi-tenant grant only while refreshed ID tokens keep the signed-in tenant's issuer",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Exercises the shared OAuth refresh through the hosted API."),
    },
  },
  oauthDiscoveryLocations: {
    fixtures: "actors",
    file: "oauth-interop.spec.ts",
    title:
      "OAuth discovery tries MCP's metadata locations in order when one redirects, refuses or is missing",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Exercises shared OAuth discovery through the hosted API."),
    },
  },
  oauthRegistrationInterop: {
    fixtures: "actors",
    file: "oauth-interop.spec.ts",
    title:
      "OAuth registration requests only advertised grant types and explains a refused callback URL",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Exercises shared OAuth registration through the hosted API."),
    },
  },
  oauthAhrefs: {
    fixtures: "actors",
    file: "oauth-interop.spec.ts",
    title:
      "OAuth signs in to an Ahrefs-style MCP server whose token endpoint refuses a charset on the form media type",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Exercises shared OAuth discovery and exchange through the hosted API."),
    },
  },
  oauthCallbackNewTab: {
    fixtures: "actors",
    file: "oauth-callback-new-tab.spec.ts",
    title: "OAuth completes when the service's sign-in link opens in a new tab",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Covers the hosted callback page; the local page has its own scenario."),
    },
  },
  oauthCallbackOtherUser: {
    fixtures: "actors",
    file: "oauth-callback-new-tab.spec.ts",
    title: "Another member cannot finish a sign-in from its link, and its creator still can",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Local has one owner; hosted connections belong to the member who started them."),
    },
  },
  localOAuthCallbackNewTab: {
    file: "local-oauth-callback-new-tab.spec.ts",
    title: "Local OAuth completes when the service's sign-in link opens in a new tab",
    targets: {
      "self-host": na("Covers the local callback page; hosted has its own scenario."),
      cloud: na("Covers the local callback page; hosted has its own scenario."),
      local: scheduled,
    },
  },
  localOAuthCallbackFragment: {
    file: "local-oauth-callback-fragment.spec.ts",
    title: "Local OAuth completes when the service appends a fragment to the callback",
    targets: {
      "self-host": na("Hosted rebuilds the callback from its query; this covers the local page."),
      cloud: na("Hosted rebuilds the callback from its query; this covers the local page."),
      local: scheduled,
    },
  },
  oauthMetadataOverride: {
    fixtures: "actors",
    file: "oauth-metadata-override.spec.ts",
    title: "OAuth metadata overrides validate ES256 and issuer while MCP challenges select scopes",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthDiscoveryFallback: {
    fixtures: "actors",
    file: "oauth-discovery-fallback.spec.ts",
    title: "OAuth discovery falls back to the origin only when path metadata is missing",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Exercises shared OAuth discovery through the hosted API."),
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
  localCustomImport: {
    file: "local-custom-import.spec.ts",
    title: "Local custom MCP imports generate app source on concurrent first use",
    targets: {
      local: scheduled,
      "self-host": na("Hosted custom MCP imports are covered by the MCP auth discovery scenario."),
      cloud: na("Cloud egress refuses loopback MCP hosts, so no Cloud scenario imports one."),
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
  localOAuthRenewalInterrupted: {
    file: "local-oauth-renewal-interruption.spec.ts",
    title: "Local dashboard keeps an account signed in after the app stops mid-renewal",
    targets: {
      "self-host": na("Local dashboard sign-in state."),
      cloud: na("Local dashboard sign-in state."),
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
  oauthClientCredentialsRequestOptions: {
    fixtures: "actors",
    file: "oauth-client-credentials.spec.ts",
    title:
      "Client credentials sends JSON token requests with comma-separated scopes when the provider declares them, on connect and renewal",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback token service."),
      local: na("Exercises shared OAuth through the hosted API."),
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
  oauthCompletionReasons: {
    fixtures: "actors",
    file: "oauth-completion-reasons.spec.ts",
    title:
      "OAuth completion names each callback failure, and the callback page offers only the recovery that reason allows",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Hosted callback page and account dialogs."),
    },
  },
  oauthClientAuthentication: {
    fixtures: "actors",
    file: "oauth-client-authentication.spec.ts",
    title:
      "OAuth clients authenticate to services that accept only Basic credentials, read them literally, or read only the request body, through sign-in, registration, refresh and revocation",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Exercises shared OAuth through the hosted API."),
    },
  },
  oauthDeclaredEndpoints: {
    fixtures: "actors",
    file: "oauth-declared-endpoints.spec.ts",
    title:
      "Declared OAuth endpoints accept the service's callback and ID token issuer, refresh, and, like discovered servers open to public and secret clients, leave client authentication to the client",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Hosted account dialogs and saved-client management."),
    },
  },
  oauthAuthorizationParams: {
    fixtures: "actors",
    file: "oauth-authorization-params.spec.ts",
    title:
      "OAuth authorization parameters, URL queries and a declared scope separator reach sign-in without replacing protocol parameters",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Exercises shared OAuth through the hosted API."),
    },
  },
  oauthClientMetadataDocument: {
    fixtures: "actors",
    file: "oauth-client-metadata.spec.ts",
    title:
      "a host with a client metadata document signs in without registering a client, and still registers where the server does not accept documents",
    serverEnvironment: {
      EXECUTOR_OAUTH_CLIENT_METADATA_URL: "https://executor.example/oauth/client-metadata.json",
      EXECUTOR_OAUTH_CALLBACK_URL: oauthRelayCallback,
    },
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Managed Cloud runs on loopback without a public HTTPS origin; deployed stages serve the document.",
      ),
      local: na("Local's loopback callback has no public document; it registers dynamically."),
    },
  },
  oauthClientMetadataEnabled: {
    fixtures: "actors",
    file: "oauth-client-metadata.spec.ts",
    title:
      "turning on a client metadata URL keeps the clients owners already registered, and new owners use the document",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Managed Cloud has no public HTTPS origin to serve a document; this restarts a runner-owned self-host with the setting.",
      ),
      local: na("Local's loopback callback has no public document; it registers dynamically."),
    },
  },
  oauthClientMetadataUnset: {
    fixtures: "actors",
    file: "oauth-client-metadata.spec.ts",
    title: "a host without a client metadata URL serves no document and registers a client",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Managed Cloud leaves the setting unset like self-host; one host proves the default.",
      ),
      local: na("Local's loopback callback has no public document; it registers dynamically."),
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
      "App account sign-in starts OAuth without asking for a name and returns cancellation to the same app",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted browser sign-in and callback recovery."),
    },
  },
  dashboardRequestVolume: {
    fixtures: "actors",
    file: "dashboard-request-volume.spec.ts",
    title: "App tabs reconcile shared reads periodically only while the page is visible",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local streams its overview; this bound covers hosted organization reads."),
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
  retainedReturn: {
    fixtures: "actors",
    file: "query-refresh.spec.ts",
    title: "Returning to the apps list shows its apps at once and refreshes them in the background",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na(
        "This journey checks hosted query retention after organization identity resolution.",
      ),
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
  earlyFormSubmission: {
    fixtures: "actors",
    file: "early-form-submission.spec.ts",
    title:
      "A form submitted before the page is interactive is held, never sent natively, and completes after hydration",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud sign-in has no password form; the guard is shared and runs on self-host."),
      local: na("Local has no sign-in form."),
    },
  },
  documentRateLimit: {
    fixtures: "actors",
    file: "document-rate-limit.spec.ts",
    title: "Pages render beyond the per-address auth limit while credential routes stay limited",
    targets: {
      "self-host": scheduled,
      cloud: na("Automated Cloud stages disable auth rate limiting to isolate scenarios."),
      local: na("Local has no auth rate limit."),
    },
  },
  cloudAuthRateLimit: {
    file: "cloud-auth-rate-limit.spec.ts",
    title: "Cloud limits sign-in and OAuth client registration per address and says when to retry",
    targets: {
      cloud: rateLimitedCloud,
      "self-host": na("The self-host auth limit is covered by the document rate limit scenario."),
      local: na("Local has no auth rate limit."),
    },
  },
  cloudAuthRateLimitRace: {
    file: "cloud-auth-rate-limit.spec.ts",
    title:
      "Cloud counts two first requests from one address that race, and reports no database fault",
    targets: {
      cloud: rateLimitedCloud,
      "self-host": na("Self-host's Better Auth does not run on Cloud's auth database driver."),
      local: na("Local has no auth rate limit."),
    },
  },
  cloudAuthDatabaseFailureCode: {
    file: "cloud-auth-rate-limit.spec.ts",
    title: "Cloud reports a Better Auth query the database failed with its failure code",
    targets: {
      cloud: rateLimitedCloud,
      "self-host": na("Self-host's Better Auth does not run on Cloud's auth database driver."),
      local: na("Local has no hosted sign-in."),
    },
  },
  cloudTokenRateLimitTelemetry: {
    file: "cloud-auth-rate-limit.spec.ts",
    title: "Cloud records a rate-limited OAuth token request with its grant type",
    targets: {
      cloud: rateLimitedCloud,
      "self-host": na("Cloud OAuth token endpoint instrumentation."),
      local: na("Local has no auth rate limit."),
    },
  },
  serverRenderedDashboard: {
    fixtures: "actors",
    file: "server-rendered-dashboard.spec.ts",
    title:
      "Dashboard pages render on the server behind sign-in, keep their framing protections and hydrate without repeating reads",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na(
        "Local pairs through a URL fragment; the local server-rendered scenario covers it.",
      ),
    },
  },
  serverRenderedAccess: {
    fixtures: "actors",
    file: "server-rendered-access.spec.ts",
    title:
      "An organization page's server render sends its page data only after access succeeds, whatever its reads returned",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "The access check fixture is mounted by the self-host test entry point; the registry and organization boundary are shared with Cloud.",
      ),
      local: na("Local has no organization access check."),
    },
  },
  serverRenderedSkills: {
    fixtures: "actors",
    file: "server-rendered-skills.spec.ts",
    title: "An editable app's server-rendered skills hydrate without reading its source again",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("Hosted authoring scenario; local skills share the same view."),
    },
  },
  localServerRenderedDashboard: {
    file: "local-server-rendered-dashboard.spec.ts",
    title: "Local dashboard pages render on the server and hydrate to the same markup",
    targets: {
      local: scheduled,
      "self-host": na("Hosted pages are covered by the server-rendered dashboard scenario."),
      cloud: na("Hosted pages are covered by the server-rendered dashboard scenario."),
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
    title: "Settings render on the server and keep their layout while members load in the browser",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Organization settings are hosted only."),
    },
  },
  apiKeysLoading: {
    fixtures: "actors",
    file: "settings-loading.spec.ts",
    title: "Account tokens loading keeps its page identity while tokens load",
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
  routeLoading: {
    fixtures: "actors",
    file: "route-loading.spec.ts",
    title:
      "Before a route's data or code arrives, it shows that route's own heading and loading shape, never another page's",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local renders complete documents and has no hosted sign-in, accounts or groups."),
    },
  },
  signInSettingsStalled: {
    file: "sign-in-settings.spec.ts",
    title:
      "Self-host sign-in renders without waiting for a stalled settings read, the browser reads them itself, and no other page waits for them",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud's sign-in has no instance settings to read."),
      local: na("Local has no hosted sign-in."),
    },
  },
  signInSettingsSso: {
    file: "sign-in-settings.spec.ts",
    title:
      "On a self-host instance with SSO, sign-in opened after a session ends draws nothing until its form arrives, and the form fits",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud's sign-in has no instance settings to read."),
      local: na("Local has no hosted sign-in."),
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
  frameworkReferenceCoverage: {
    fixtures: "actors",
    file: "framework-discovery.spec.ts",
    managementProfiles: ["owner"],
    title: "framework describe answers every symbol the apps package exports",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted discovery journey; local serves the same framework reference."),
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
  appFailureTelemetry: {
    fixtures: "actors",
    file: "app-failure-telemetry.spec.ts",
    title:
      "an app's failure text reaches its caller but not Executor's spans, logs or incident reports",
    targets: {
      cloud: managedCloud,
      "self-host": scheduled,
      local: na("Hosted app routes; local shares the runtime and telemetry paths."),
    },
  },
  deferredServerPaths: {
    fixtures: "actors",
    file: "deferred-server-paths.spec.ts",
    title:
      "Hosted API document and authoring skills load on demand and match the installed Executor app",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("The API document and catalog installation are hosted product surfaces."),
    },
  },
  appUiApiDocument: {
    fixtures: "actors",
    managementProfiles: ["owner"],
    file: "app-ui.spec.ts",
    title: "the API document and Executor app configuration keep browser-only app routes private",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted Better Auth and organization routes."),
    },
  },
  appUiMcpSearch: {
    fixtures: "actors",
    managementProfiles: ["owner"],
    file: "app-ui.spec.ts",
    title: "MCP search lists the app URL tool without browser-only operations",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted Better Auth and organization routes."),
    },
  },
  appUiMcpFailures: {
    fixtures: "actors",
    managementProfiles: ["owner"],
    file: "app-ui.spec.ts",
    title: "MCP explains why an app has no URL and names the app holding a taken address",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted Better Auth and organization routes."),
    },
  },
  appUiDiscovery: {
    fixtures: "actors",
    managementProfiles: ["owner"],
    file: "app-ui.spec.ts",
    appOrigin: true,
    title: "MCP discovers private app URLs only in the granted organization",
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
  appUiFileProbes: {
    fixtures: "actors",
    file: "app-ui.spec.ts",
    appOrigin: true,
    title: "private app fetches are refused while document navigations reach sign-in",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app domains."),
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
  appUiSignedOutOpen: {
    fixtures: "actors",
    file: "app-ui.spec.ts",
    appOrigin: true,
    title: "Opening an app while signed out records sign-in and every return step",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted Better Auth and organization routes."),
    },
  },
  appUiDashboardOpen: {
    fixtures: "actors",
    file: "app-ui.spec.ts",
    appOrigin: true,
    title: "Open app from the dashboard records every sign-in step and a reload in the new tab",
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
  durableEvaluatedResults: {
    fixtures: "actors",
    file: "durable-evaluated-results.spec.ts",
    title:
      "Cloud serves a tool listing its isolate cannot keep from the app's supervisor until an app cache invalidation",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host keeps evaluated results in its single server process."),
      local: na("Local keeps evaluated results in its single server process."),
    },
  },
  buildFrameworkColdLoad: {
    fixtures: "actors",
    file: "build-framework-storage.spec.ts",
    title: "A cold app load links its small build record with the stored framework",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na(
        "Local retains builds through the same SDK storage; its deploys and cold loads run in the local Worker scenarios.",
      ),
    },
  },
  buildFrameworkShared: {
    fixtures: "actors",
    file: "build-framework-storage.spec.ts",
    title: "Apps on the same apps release store its framework once",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na(
        "Local retains builds through the same SDK storage; its deploys and cold loads run in the local Worker scenarios.",
      ),
    },
  },
  buildFrameworkVersions: {
    fixtures: "actors",
    file: "build-framework-storage.spec.ts",
    title: "Builds on two apps releases each link their own stored framework",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na(
        "Local retains builds through the same SDK storage; its deploys and cold loads run in the local Worker scenarios.",
      ),
    },
  },
  executorAppRedeploy: {
    fixtures: "actors",
    legacyStorage: true,
    managementProfiles: ["owner"],
    serverEnvironment: { EXECUTOR_DATA_STEPS: "report" },
    file: "executor-app-redeploy.spec.ts",
    title:
      "Executor apps built on an apps release before beta.10 are redeployed once with only their pin changed",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Cloud runs the same step from its Worker's cron; the local Worker never reaches it because the earlier framework pin step keeps retrying there without Cloudflare Artifacts.",
      ),
      local: na(
        "Local regenerates its own Executor app from the template at every start whose template changed.",
      ),
    },
  },
  buildFrameworkMigration: {
    fixtures: "actors",
    serverEnvironment: { EXECUTOR_DATA_STEPS: "report" },
    file: "build-framework-migration.spec.ts",
    title: "Builds stored with an inlined framework are split by a data step at startup",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Cloud runs the same step from its Worker's cron; the local Worker never reaches it because the earlier framework pin step keeps retrying there without Cloudflare Artifacts.",
      ),
      local: na("Local runs the same step at its own startup; see the local scenario."),
    },
  },
  localBuildFrameworkMigration: {
    serverEnvironment: { EXECUTOR_DATA_STEPS: "report" },
    file: "build-framework-migration.spec.ts",
    title: "Builds stored with an inlined framework are split by a data step at local startup",
    targets: {
      local: scheduled,
      "self-host": na("Self-host runs the same step at its startup in the hosted scenario."),
      cloud: na("Cloud runs the same step from its Worker's cron; see the hosted scenario."),
    },
  },
  durableEvaluatedRefresh: {
    fixtures: "actors",
    file: "durable-evaluated-results.spec.ts",
    title:
      "Cloud writes the background refresh of a stale tool listing back to the app's supervisor",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host keeps evaluated results in its single server process."),
      local: na("Local keeps evaluated results in its single server process."),
    },
  },
  durableEvaluatedSharedDefinitions: {
    fixtures: "actors",
    file: "durable-evaluated-results.spec.ts",
    title:
      "Cloud keeps each JSON Schema definition a tool listing repeats once, in the isolate and in the app's supervisor",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host keeps evaluated results in its single server process."),
      local: na("Local keeps evaluated results in its single server process."),
    },
  },
  durableEvaluatedDistinctDefinitions: {
    fixtures: "actors",
    file: "durable-evaluated-results.spec.ts",
    title:
      "A tool listing whose definitions share a name and length but not their JSON evaluates as fast as one whose definitions have their own names",
    targets: {
      cloud: managedCloud,
      "self-host": scheduled,
      local: na("Hosted app deploy fixture; self-host runs the same listing code in process."),
    },
  },
  durableEvaluatedLongDefinitionNames: {
    fixtures: "actors",
    file: "durable-evaluated-results.spec.ts",
    title:
      "A tool listing whose definition names are long and of one length evaluates as fast as one whose names differ in length",
    targets: {
      cloud: managedCloud,
      "self-host": scheduled,
      local: na("Hosted app deploy fixture; self-host runs the same listing code in process."),
    },
  },
  appWorkerModules: {
    fixtures: "actors",
    file: "app-worker-modules.spec.ts",
    title: "a cold app Worker receives only the modules its entry can import",
    targets: {
      cloud: managedCloud,
      "self-host": na("The module counts are read from Cloud's delivered traces."),
      local: na("The module counts are read from Cloud's delivered traces."),
    },
  },
  cloudBuildReuse: {
    fixtures: "actors",
    file: "cloud-build-reuse.spec.ts",
    title: "Cold app Workers read their build in the runner, from the cache the deploy warmed",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host loads retained builds without the Cloud isolate cache."),
      local: na("Local loads retained builds without the Cloud isolate cache."),
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
  appQueryFailureBackoff: {
    fixtures: "actors",
    file: "app-query-failure.spec.ts",
    appOrigin: true,
    title: "a failing app query backs off, shows its failure and recovers by subscribing again",
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
  oauthTokenTelemetry: {
    fixtures: "actors",
    file: "oauth-token-telemetry.spec.ts",
    title:
      "Cloud OAuth token requests record their grant type, OAuth error, refresh-family revocation and client family without reporting them",
    targets: {
      cloud: managedCloud,
      "self-host": na("Cloud OAuth token endpoint instrumentation."),
      local: na("Local has no hosted OAuth token endpoint."),
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
  authInvocations: {
    fixtures: "actors",
    file: "auth-invocations.spec.ts",
    title: "Concurrent users read their own sessions and trace auth SQL to their own requests",
    targets: {
      cloud: scheduled,
      "self-host": na(
        "Self-host serves Better Auth from one process with its own database; Cloud binds each Worker invocation's connection.",
      ),
      local: na("Local has no hosted sign-in sessions."),
    },
  },
  authCleanupAfterResponse: {
    fixtures: "actors",
    file: "auth-cleanup.spec.ts",
    title:
      "A Better Auth query left running past its response finishes on the request's connection",
    targets: {
      cloud: managedCloud,
      "self-host": na(
        "Self-host serves Better Auth from one process with its own long-lived database pool.",
      ),
      local: na("Local has no hosted sign-in sessions."),
    },
  },
  authCleanupTimeout: {
    fixtures: "actors",
    file: "auth-cleanup.spec.ts",
    title: "A Better Auth query held past the request's cleanup bound is cancelled and reported",
    targets: {
      cloud: managedCloud,
      "self-host": na(
        "Self-host serves Better Auth from one process with its own long-lived database pool.",
      ),
      local: na("Local has no hosted sign-in sessions."),
    },
  },
  authCleanupStalled: {
    fixtures: "actors",
    file: "auth-cleanup.spec.ts",
    title:
      "A Better Auth query whose database stops answering is given up within the cleanup window",
    targets: {
      cloud: managedCloud,
      "self-host": na(
        "Self-host serves Better Auth from one process with its own long-lived database pool.",
      ),
      local: na("Local has no hosted sign-in sessions."),
    },
  },
  clientRejectionReporting: {
    fixtures: "actors",
    file: "client-rejection-reporting.spec.ts",
    title: "client request rejections are recorded on their request span, not as server incidents",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("This scenario uses hosted APIs; localRejectionRecording covers Local."),
    },
  },
  appEvaluationReporting: {
    fixtures: "actors",
    file: "app-evaluation-reporting.spec.ts",
    title: "app evaluation failures explain the likely cause and still report as incidents",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("The hosted Sentry reporter owns this behavior."),
    },
  },
  localRejectionRecording: {
    file: "client-rejection-reporting.spec.ts",
    title: "local request rejections are recorded on their request span",
    targets: {
      local: scheduled,
      "self-host": na("clientRejectionReporting covers hosted request rejections."),
      cloud: na("clientRejectionReporting covers hosted request rejections."),
    },
  },
  mcpTelemetryPrivacy: {
    fixtures: "actors",
    file: "mcp-telemetry-privacy.spec.ts",
    title:
      "MCP tool calls deliver their tool name and outcome, never the caller's arguments, results or names",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na(
        "Local serves the same MCP package; the delivered spans are checked on hosted targets.",
      ),
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
  toolCallOverhead: {
    fixtures: "actors",
    file: "tool-call-overhead.spec.ts",
    title: "a tool call records its Executor time apart from its upstream wait",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("This scenario uses hosted MCP; the runtime and collector are shared with Local."),
    },
  },
  toolCallOverheadParallel: {
    fixtures: "actors",
    file: "tool-call-overhead.spec.ts",
    title: "concurrent upstream waits count once against a tool call's Executor time",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("This scenario uses hosted MCP; the runtime and collector are shared with Local."),
    },
  },
  toolCallOverheadAuthored: {
    fixtures: "actors",
    file: "tool-call-overhead.spec.ts",
    title: "a tool call's Executor time excludes the app's factory, approval policy and handler",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("This scenario uses hosted MCP; the runtime and collector are shared with Local."),
    },
  },
  toolCallOverheadElicitation: {
    fixtures: "actors",
    file: "tool-call-overhead.spec.ts",
    title: "a person's answer is not Executor time, whether the app or its MCP server asked",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("This scenario uses hosted MCP; the runtime and collector are shared with Local."),
    },
  },
  toolCallOverheadStale: {
    fixtures: "actors",
    file: "tool-call-overhead.spec.ts",
    title: "Executor time flags an app isolate whose clock reads more than its caller waited",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("This scenario uses hosted MCP; the runtime and collector are shared with Local."),
    },
  },
  toolCallOverheadFailure: {
    fixtures: "actors",
    file: "tool-call-overhead.spec.ts",
    title: "a failed tool call still records its Executor time",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("This scenario uses hosted MCP; the runtime and collector are shared with Local."),
    },
  },
  toolCallOverheadCancelled: {
    fixtures: "actors",
    file: "tool-call-overhead.spec.ts",
    title: "a cancelled tool call records no Executor time it could not measure",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("This scenario uses hosted MCP; the runtime and collector are shared with Local."),
    },
  },
  toolCallOverheadApproved: {
    fixtures: "actors",
    file: "tool-call-overhead.spec.ts",
    title: "an approved tool call records its Executor time when it resumes",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("This scenario uses hosted MCP; the runtime and collector are shared with Local."),
    },
  },
  toolCallOverheadServiceInUpstream: {
    fixtures: "actors",
    file: "tool-call-overhead.spec.ts",
    title: "Executor time keeps Executor's cache work inside an upstream session",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("This scenario uses hosted MCP; the runtime and collector are shared with Local."),
    },
  },
  toolCallOverheadLoader: {
    fixtures: "actors",
    file: "tool-call-overhead.spec.ts",
    title: "Executor time excludes an app's cache loader inside Executor's cache",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("This scenario uses hosted MCP; the runtime and collector are shared with Local."),
    },
  },
  toolCallOverheadAuthoredCache: {
    fixtures: "actors",
    file: "tool-call-overhead.spec.ts",
    title: "Executor time excludes an app's own cache methods that Executor's catalog calls",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("This scenario uses hosted MCP; the runtime and collector are shared with Local."),
    },
  },
  toolCallOverheadAuthoredCacheReceiver: {
    fixtures: "actors",
    file: "tool-call-overhead.spec.ts",
    title: "Executor's catalog calls an app's own cache methods on the cache itself",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("This scenario uses hosted MCP; the runtime and collector are shared with Local."),
    },
  },
  toolCallOverheadDatabase: {
    fixtures: "actors",
    file: "tool-call-overhead.spec.ts",
    title: "Executor time covers a tool that writes and reads its SQL database",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("This scenario uses hosted MCP; the runtime and collector are shared with Local."),
    },
  },
  toolCallOverheadStart: {
    fixtures: "actors",
    file: "tool-call-overhead.spec.ts",
    title: "Executor time does not count the app's work while its isolate starts",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("This scenario uses hosted MCP; the runtime and collector are shared with Local."),
    },
  },
  toolCallOverheadDispatch: {
    fixtures: "actors",
    file: "tool-call-overhead.spec.ts",
    title: "Executor time includes the framework's work around the app's call span",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("This scenario uses hosted MCP; the runtime and collector are shared with Local."),
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
  executorOrganizationDefault: {
    fixtures: "actors",
    managementProfiles: ["owner"],
    file: "executor-organization-default.spec.ts",
    title: "Executor platform operations default to the managed key's organization over MCP",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local management routes have no organization."),
    },
  },
  teamInstallationFromRequest: {
    fixtures: "actors",
    file: "team-installation.spec.ts",
    title:
      "A new Cloud team's Executor app is installed by its request while the workflow stands by",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host installs teams from its own provisioning worker."),
      local: na("Local uses its configured instance and has no teams."),
    },
  },
  teamInstallationConcurrent: {
    fixtures: "actors",
    file: "team-installation.spec.ts",
    title: "Request and workflow attempts at one team leave one Executor app and one profile each",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host runs each provisioning job once, on its single worker."),
      local: na("Local uses its configured instance and has no teams."),
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
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted OAuth grant scenario"),
    },
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
  scopedConnectionAccess: {
    fixtures: "actors",
    file: "mcp-connections.spec.ts",
    title:
      "Scoped connections issue their own MCP URL and follow live edits, read-only rules and revocation",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local connections are covered by the local scoped connection scenario."),
    },
  },
  scopedConnectionProfiles: {
    fixtures: "actors",
    file: "mcp-connections.spec.ts",
    title:
      "Scoped connections run apps only as selected profiles and save bare accounts as profiles",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted profile ownership and account sharing."),
    },
  },
  scopedConnectionConsent: {
    fixtures: "actors",
    file: "mcp-connections.spec.ts",
    title: "Scoped connection consent rejects other users and other organizations",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has one operator and no organizations."),
    },
  },
  scopedConnectionDashboard: {
    fixtures: "actors",
    file: "mcp-connections.spec.ts",
    title: "Members create and revoke a scoped connection from the dashboard",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("The shared connections page is exercised through the hosted dashboard."),
    },
  },
  localScopedConnections: {
    file: "local-mcp-connections.spec.ts",
    title: "Local scoped connections limit an OAuth client to their tools and revoke it",
    targets: {
      local: scheduled,
      "self-host": na("Hosted connections are covered by the hosted scoped connection scenarios."),
      cloud: na("Hosted connections are covered by the hosted scoped connection scenarios."),
    },
  },
  localMcpOAuthWithoutResource: {
    file: "local-mcp-connections.spec.ts",
    title: "Local MCP OAuth without a resource parameter grants the plain /mcp URL",
    targets: {
      local: scheduled,
      "self-host": na("Hosted consent is covered by mcpOAuthWithoutResource."),
      cloud: na("Hosted consent is covered by mcpOAuthWithoutResource."),
    },
  },
  bearerAuthRefusals: {
    fixtures: "actors",
    file: "bearer-auth-refusals.spec.ts",
    title: "MCP and API bearer authentication refuses every stored state Better Auth refuses",
    targets: {
      cloud: managedCloud,
      "self-host": na(
        "Stored-row cases write the product database directly; self-host's PGlite lives inside its workerd product object. Both hosts run the same bearer statement.",
      ),
      local: na("Local uses its instance credential."),
    },
  },
  bearerAuthStatements: {
    fixtures: "actors",
    file: "bearer-auth-statements.spec.ts",
    title: "MCP and API bearer authentication reads its grant in one SQL statement",
    targets: {
      "self-host": scheduled,
      cloud: na("This scenario reads SQL spans from the self-host Motel collector."),
      local: na("Local uses its instance credential."),
    },
  },
  toolCallStatements: {
    fixtures: "actors",
    file: "tool-call-statements.spec.ts",
    title: "An MCP tool call checks its access in one statement and its subject in one more",
    targets: {
      "self-host": scheduled,
      cloud: na("This scenario reads SQL spans from the self-host Motel collector."),
      local: na("Local has no hosted organization policies."),
    },
  },
  toolCallHeldCheck: {
    fixtures: "actors",
    file: "tool-call-held-check.spec.ts",
    title:
      "a tool call whose read-only check waits on the app runs the profile and credentials saved meanwhile",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Holds the app's listing on a loopback resource; Cloud app Workers fetch through one fixed service binding.",
      ),
      local: na("Local has no hosted organization policies."),
    },
  },
  toolCallHeldAccess: {
    fixtures: "actors",
    file: "tool-call-held-check.spec.ts",
    title:
      "a tool call runs the profile and the key or OAuth account saved while its access check waits",
    targets: {
      "self-host": scheduled,
      cloud: na("The statement hold is mounted by the self-host test entry point."),
      local: na("Local has no hosted organization policies."),
    },
  },
  localMcpGrantRefusals: {
    file: "local-mcp-connections.spec.ts",
    title: "Local MCP names the tool, runs-as target or app a narrowed connection excludes",
    targets: {
      local: scheduled,
      "self-host": na("Hosted grant restrictions are covered by liveGrantRestrictions."),
      cloud: na("Hosted grant restrictions are covered by liveGrantRestrictions."),
    },
  },
  connectionLinkReadAgain: {
    fixtures: "actors",
    file: "connection-link.spec.ts",
    title:
      "agents read a pending connection's sign-in link back, are told to connect a new account after a provider change, and another organization's admin cannot read the link",
    managementProfiles: ["owner"],
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local issues bearer links through accountConnect.issue, not hosted connections."),
    },
  },
  appManagementContractsHosted: {
    fixtures: "actors",
    file: "app-management-contracts.spec.ts",
    title:
      "hosted agents read the apps release, are refused create without files, deploy the documented two-file app, and get commit and deploy results as objects",
    managementProfiles: ["owner"],
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local runs the same agent programs in its own scenario."),
    },
  },
  appManagementContractsLocal: {
    file: "app-management-contracts.spec.ts",
    title:
      "local agents read the apps release, are refused create without files, deploy the documented two-file app, and get commit and deploy results as objects",
    targets: {
      local: scheduled,
      "self-host": na("Hosted organizations run the same agent programs in their own scenario."),
      cloud: na("Hosted organizations run the same agent programs in their own scenario."),
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
  localMcpResumeAcrossSessions: {
    file: "local-mcp-connections.spec.ts",
    title: "Local MCP model-mode resume continues from a new MCP session of the same grant only",
    targets: {
      local: scheduled,
      "self-host": na("Hosted products cover the same partition in patMcpResumeAcrossSessions."),
      cloud: na("Hosted products cover the same partition in patMcpResumeAcrossSessions."),
    },
  },
  patMcpResumeAcrossSessions: {
    fixtures: "actors",
    file: "pat-mcp.spec.ts",
    title: "PAT MCP model-mode resume continues from a new MCP session of the same token only",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no personal access tokens."),
    },
  },
  patMcpRenamedOrganization: {
    fixtures: "actors",
    file: "pat-mcp.spec.ts",
    title: "PAT MCP calls keep their organization when its slug is renamed mid-request",
    targets: {
      "self-host": na(
        "Self-host permits one organization, which every parallel scenario shares; renaming it would move theirs.",
      ),
      cloud: scheduled,
      local: na("Local has no organizations."),
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
  mcpExecuteApprovalAfterRefresh: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title: "Hosted MCP approvals are requested without waiting for background cache refreshes",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted self-host covers the shared execution driver."),
    },
  },
  mcpExecuteRefreshNotAwaited: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title: "Hosted MCP executions return without waiting for background cache refreshes",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted self-host covers the shared execution driver."),
    },
  },
  mcpExecuteUnavailableApp: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title: "MCP calls into an app that could not load report why it is unavailable",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted account selection covers the shared catalog diagnostics."),
    },
  },
  mcpExecuteAppThrew: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title: "MCP discovery reports the error an app threw with its code and fields",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses the shared app runtime error mapping that self-host covers."),
      local: na("Hosted self-host covers the shared catalog diagnostics."),
    },
  },
  mcpExecuteInputShape: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title: "MCP calls with misshaped input name the keys and alternatives the input expects",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted self-host covers the shared app runtime input formatting."),
    },
  },
  mcpExecuteToolBlocked: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title: "MCP calls an app's approval policy denies say why and not to retry them unchanged",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na(
        "Hosted self-host covers the shared MCP execute error presentation; the local tool runner covers the local dashboard.",
      ),
    },
  },
  mcpExecuteServerRefused: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title: "MCP apps whose server refuses connections report the MCP failure",
    targets: {
      "self-host": scheduled,
      cloud: na("The refusing MCP server is a loopback listener."),
      local: na("Hosted self-host covers the shared app runtime error mapping."),
    },
  },
  mcpExecuteCallRefused: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title: "MCP tool calls report the JSON-RPC error their server answered with",
    targets: {
      "self-host": scheduled,
      cloud: na("The refusing MCP server is a loopback listener."),
      local: na("Hosted self-host covers the shared app runtime error mapping."),
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
  mcpProtocolVersions: {
    fixtures: "actors",
    file: "mcp-protocol-versions.spec.ts",
    title: "Hosted MCP negotiates older protocol versions and explains rejected requests",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local runs the same protocol checks in localMcpProtocolVersions."),
    },
  },
  // The app tool signals a loopback listener when it starts, and the Sentry check reads the managed
  // Cloud collector; a deployed Worker can reach neither.
  mcpCancelledCalls: {
    fixtures: "actors",
    file: "mcp-protocol-versions.spec.ts",
    title: "Hosted MCP ends a cancelled call without a result and keeps serving the session",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("Cancellation is a hosted MCP session behavior."),
    },
  },
  localMcpProtocolVersions: {
    file: "mcp-protocol-versions.spec.ts",
    title: "Local MCP negotiates older protocol versions and explains rejected requests",
    targets: {
      local: scheduled,
      "self-host": na("Hosted products run the same protocol checks in mcpProtocolVersions."),
      cloud: na("Hosted products run the same protocol checks in mcpProtocolVersions."),
    },
  },
  mcpToolInput: {
    fixtures: "actors",
    file: "mcp-tool-input.spec.ts",
    title:
      "Hosted MCP model and browser modes return an account-free tool's input request and resume it with the answer",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local runs the same flow in localMcpToolInput."),
    },
  },
  localMcpToolInput: {
    file: "mcp-tool-input.spec.ts",
    title:
      "Local MCP model and browser modes return an account-free tool's input request and resume it with the answer",
    targets: {
      local: scheduled,
      "self-host": na("Hosted products run the same flow in mcpToolInput."),
      cloud: na("Hosted products run the same flow in mcpToolInput."),
    },
  },
  accountSettings: {
    fixtures: "actors",
    file: "account-settings.spec.ts",
    title:
      "Account settings rename the signed-in user, list and revoke their sessions, and change the self-host password",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local pairs a device instead of signing a user in."),
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
  apiKeyStorageOutage: {
    fixtures: "actors",
    file: "api-key-storage-outage.spec.ts",
    title: "A database failure while verifying an API key answers 503 on MCP and the API, not 401",
    targets: {
      cloud: managedCloud,
      "self-host": {
        status: "not-run",
        reason:
          "Self-host verifies keys the same way, but its database runs inside the product's Worker, where the runner cannot fail its writes.",
      },
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
    title: "local account groups choose single and multiple accounts in place without copying apps",
    targets: {
      local: scheduled,
      "self-host": na("Local pairing journey."),
      cloud: na("Local pairing journey."),
    },
  },
  codeFormattingSource: {
    fixtures: "actors",
    file: "code-formatting.spec.ts",
    title: "code blocks format deployed source and copy without changing stored content",
    targets: {
      local: na("Shared source viewer covered through hosted."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  codeFormattingWorkspace: {
    fixtures: "actors",
    file: "code-formatting.spec.ts",
    title: "code blocks format workspace source and copy without changing stored content",
    targets: {
      local: na("Shared source viewer covered through hosted."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  codeFormattingLarge: {
    fixtures: "actors",
    file: "code-formatting.spec.ts",
    title:
      "code blocks load a large file formatted on its own and copy without changing stored content",
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
    targets: {
      local: na("Hosted membership only."),
      "self-host": scheduled,
      cloud: scheduled,
    },
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
  hostedProfileStaticSchedules: {
    fixtures: "actors",
    file: "hosted-profile-scheduling.spec.ts",
    title: "profile setup and schedules do not depend on dynamic tool discovery",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted profile setup"),
    },
  },
  hostedProfileRevocation: {
    fixtures: "actors",
    file: "hosted-profiles.spec.ts",
    title: "hosted profiles recheck shared accounts after deletion and revocation",
    targets: {
      local: na("Hosted membership only."),
      "self-host": scheduled,
      cloud: scheduled,
    },
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
  workflowStarts: {
    fixtures: "actors",
    file: "workflows.spec.ts",
    title:
      "app workflow starts enforce permissions, input and idempotency keys in isolated app code",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app and account management routes."),
    },
  },
  workflowsInUse: {
    fixtures: "actors",
    file: "workflows.spec.ts",
    title: "running app workflows keep their account and app from deletion",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app and account management routes."),
    },
  },
  workflows: {
    fixtures: "actors",
    file: "workflows.spec.ts",
    title: "app workflows pin deployments and accounts and retry steps",
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
    title: "app workflow runs report approval and execution failure reasons",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app and account management routes."),
    },
  },
  workflowFailureDetails: {
    fixtures: "actors",
    file: "workflows.spec.ts",
    title: "errored app workflow runs name the failing step and redact account credentials",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app and account management routes."),
    },
  },
  workflowStepTimeout: {
    fixtures: "actors",
    file: "workflows.spec.ts",
    title: "app workflow step timeouts roll back the step's writes",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app and account management routes."),
    },
  },
  workflowTermination: {
    fixtures: "actors",
    file: "workflows.spec.ts",
    title: "terminating an app workflow requires permission and stops later steps",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app and account management routes."),
    },
  },
  workflowTimeout: {
    fixtures: "actors",
    file: "workflow-durability.spec.ts",
    title: "a timed-out workflow step keeps its committed write exactly once across retries",
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
  appDataLimits: {
    fixtures: "actors",
    file: "app-data-limits.spec.ts",
    title:
      "app SQL migrations keep their history and apply all or nothing, and queries never commit",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app deploy and tool call routes."),
    },
  },
  mcpEvents: {
    fixtures: "actors",
    file: "mcp-events.spec.ts",
    title:
      "an MCP client lists app events, subscribes with a verified webhook and receives signed, retried, filtered deliveries until it unsubscribes or loses access",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted account, webhook and personal access token routes."),
    },
  },
  mcpEventChanges: {
    fixtures: "actors",
    file: "mcp-events-changes.spec.ts",
    title:
      "a refresh after a redeploy removed a subscription's filter or event is refused with -32014 or -32011 and stops that subscription",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted personal access token and webhook routes."),
    },
  },
  mcpEventGrants: {
    fixtures: "actors",
    file: "mcp-events-grants.spec.ts",
    title:
      "an OAuth grant selects an app's events beside its tools, all by default or by name, and selecting none hides them, refuses subscribing and stops its deliveries",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted OAuth grant narrowing and webhook routes."),
    },
  },
  localMcpEvents: {
    file: "local-mcp-events.spec.ts",
    title:
      "local delivers MCP events to a verified loopback receiver, retries a refused delivery and stops after unsubscribing",
    targets: {
      local: scheduled,
      "self-host": na("Self-host and Cloud cover events in the MCP events scenarios."),
      cloud: na("Self-host and Cloud cover events in the MCP events scenarios."),
    },
  },
  mcpEventAccounts: {
    fixtures: "actors",
    file: "mcp-events-accounts.spec.ts",
    title:
      "an event reaches only subscribers who may use every account its invocation used, and a grant limited to some profiles only those from their accounts",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has one user, who may use every account."),
    },
  },
  appCallbacks: {
    fixtures: "actors",
    file: "app-callbacks.spec.ts",
    title:
      "an app with storage answers its webhook verification and other calls while one call waits",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted account and webhook management routes."),
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
  invitationDialog: {
    fixtures: "actors",
    file: "invitation-dialog.spec.ts",
    title: "sending an invitation shows a success view with its link",
    targets: {
      local: na("Hosted organization invitations."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  invitationReaccept: {
    fixtures: "actors",
    file: "invitation-reaccept.spec.ts",
    title: "reopening an accepted invitation says the member already joined",
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
  remoteRegistryFailures: {
    file: "registry-failures.spec.ts",
    title: "Public app catalog refuses registry redirects and reports distinct registry failures",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud serves the registry from its own database instead of a remote origin."),
      local: na(
        "Local uses the same registry client; only self-host starts a scenario-owned server.",
      ),
    },
  },
  telemetryBackpressure: {
    file: "telemetry-backpressure.spec.ts",
    title:
      "Crash reports a shedding collector refuses are resent after its Retry-After, within budget",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Cloud's Worker reads its collector address at start; only self-host starts a scenario-owned server.",
      ),
      local: na("Local uses the same relay; only self-host starts a scenario-owned server."),
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
    title:
      "Cloud onboarding from Get started signs up by email, registers a passkey and uses it for returning sign-in",
    targets: cloudOnboarding,
  },
  onboardingSkip: {
    file: "cloud-onboarding.spec.ts",
    title:
      "Cloud onboarding can skip a passkey and returning email sign-in keeps the existing team",
    targets: cloudOnboarding,
  },
  v1SignInStop: {
    file: "cloud-v1-sign-in.spec.ts",
    title:
      "Cloud sign-in keeps a new v1 organization member on v1 and fails closed while WorkOS is unavailable",
    targets: cloudOnboarding,
  },
  v1SignInInvited: {
    file: "cloud-v1-sign-in.spec.ts",
    title:
      "Cloud sign-in keeps a new v1 organization member who joins an invited team from creating another, and fails closed while WorkOS is unavailable",
    targets: cloudOnboarding,
  },
  v1SignInExisting: {
    file: "cloud-v1-sign-in.spec.ts",
    title: "Cloud sign-in skips the v1 check for accounts from before it and for v2 team members",
    targets: {
      ...cloudOnboarding,
      // Backdating an account writes the managed Cloud's own database.
      cloud: managedCloud,
    },
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
  skillReadTelemetry: {
    fixtures: "actors",
    managementProfiles: ["owner"],
    file: "skill-read-telemetry.spec.ts",
    title: "hosted skill reads trace only the Executor app's own skill names",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Self-host runs the same hosted MCP options and skill routes; Cloud adds only its transport.",
      ),
      local: na("localSkillReadTelemetry covers Local's MCP and management API."),
    },
  },
  localSkillReadTelemetry: {
    file: "skill-read-telemetry.spec.ts",
    title: "Local skill reads trace only the Executor app's own skill names",
    targets: {
      local: scheduled,
      "self-host": na("skillReadTelemetry covers hosted skill reads."),
      cloud: na("skillReadTelemetry covers hosted skill reads."),
    },
  },
  wildcardRouteTelemetry: {
    fixtures: "actors",
    managementProfiles: ["owner"],
    file: "wildcard-route-telemetry.spec.ts",
    title: "hosted wildcard routes trace their template, not the path under it",
    targets: {
      "self-host": scheduled,
      // Reads the local collector; probes Cloud's SSO, analytics and site routes too.
      cloud: managedCloud,
      local: na("localWildcardRouteTelemetry covers Local's wildcard routes."),
    },
  },
  localWildcardRouteTelemetry: {
    file: "wildcard-route-telemetry.spec.ts",
    title: "Local wildcard routes trace their template, not the path under it",
    targets: {
      local: scheduled,
      "self-host": na("wildcardRouteTelemetry covers hosted wildcard routes."),
      cloud: na("wildcardRouteTelemetry covers hosted wildcard routes."),
    },
  },
  localAppsCli: {
    file: "local-apps-cli.spec.ts",
    title:
      "apps CLI explains sign-in, reads host skills, creates from a directory and commits the current directory",
    targets: {
      local: scheduled,
      "self-host": na("The CLI's hosted path needs a browser OAuth login; local uses an API key."),
      cloud: na("The CLI's hosted path needs a browser OAuth login; local uses an API key."),
    },
  },
  localAppsCliRelease: {
    file: "local-apps-cli.spec.ts",
    title:
      "apps CLI prints the host's apps release, requires --files, and deploys the documented two-file app; the local Executor app pins the same release",
    targets: {
      local: scheduled,
      "self-host": na("The CLI's hosted path needs a browser OAuth login; local uses an API key."),
      cloud: na("The CLI's hosted path needs a browser OAuth login; local uses an API key."),
    },
  },
  skillFolder: {
    fixtures: "actors",
    file: "skill-folder.spec.ts",
    title:
      "skill folders share one loader, ignore loose files and ui/, and respect explicit catalogs",
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
  privateGithubSkills: {
    fixtures: "actors",
    file: "dynamic-skills.spec.ts",
    title:
      "GitHub skills read a private repository with the selected account's token, scoped to that account",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a loopback service; Cloud app Workers reach only public addresses."),
      local: na("Local runs apps through the same workerd runner and outbound as self-host."),
    },
  },
  cachedSkillsRefresh: {
    fixtures: "actors",
    file: "cached-skills.spec.ts",
    title: "a stale remote skill catalog is checked with one request before it is served",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na(
        "Shared runtime and HTTP behavior are covered on hosted targets; local MCP has its own skill scenario.",
      ),
    },
  },
  revalidatedSkills: {
    fixtures: "actors",
    file: "cached-skills.spec.ts",
    title:
      "a skill read without a revision gets a new publication at once and pinned reads keep theirs",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na(
        "Shared runtime and HTTP behavior are covered on hosted targets; local MCP has its own skill scenario.",
      ),
    },
  },
  cachedSkillsCustomCacheCancel: {
    fixtures: "actors",
    file: "cached-skills.spec.ts",
    title: "an app's own cache that abandons a GitHub skills load aborts its download",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na(
        "Shared runtime and HTTP behavior are covered on hosted targets; local MCP has its own skill scenario.",
      ),
    },
  },
  cachedSkills: {
    fixtures: "actors",
    file: "cached-skills.spec.ts",
    title: "remote skill catalogs are served from the app cache",
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
  scheduleSourceRemoval: {
    fixtures: "actors",
    file: "hosted-schedule-browser.spec.ts",
    title: "schedules removed from app source are deleted when a deployment activates",
    targets: {
      cloud: scheduled,
      "self-host": scheduled,
      local: na("Local covers removal with run history and approvals in scheduledRuns."),
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
  legacyOrphanSchedules: {
    legacyStorage: true,
    file: "legacy-orphan-schedules.spec.ts",
    title: "legacy orphan schedules are paused without starving a live schedule",
    targets: {
      local: scheduled,
      "self-host": na(
        "Reaching the live schedule's due time needs the stopped-process clock, which only Local provides; both hosts run the same SDK scheduler.",
      ),
      cloud: na(
        "Legacy rows need a runner-owned database; Cloud cases share one Worker and database.",
      ),
    },
  },
  legacyConnectionFailure: {
    legacyStorage: true,
    file: "legacy-connection-failure.spec.ts",
    title:
      "a connection whose recorded sign-in failure uses a retired reason stays readable and can sign in again",
    targets: {
      local: scheduled,
      "self-host": na(
        "Both hosts read connections through the same SDK; Local reaches the stored row without organization fixtures.",
      ),
      cloud: na(
        "Legacy rows need a runner-owned database; Cloud cases share one Worker and database.",
      ),
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
  scheduledRunRedeploy: {
    fixtures: "actors",
    file: "scheduled-run-redeploy.spec.ts",
    title: "a scheduled run after a redeploy executes the new build",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local does not have organization memberships."),
    },
  },
  scheduledRuns: {
    file: "local-schedule-runs.spec.ts",
    title:
      "scheduled runs honor approval policy, browser review, overlap exclusion and removal from source",
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
  localMcp: {
    file: "local-claude-mcp.spec.ts",
    title:
      "Claude Code connects to Local through /mcp, paired browser consent and a real tool call",
    targets: {
      local: scheduled,
      "self-host": na("Hosted consent is covered by the organization Claude Code scenario."),
      cloud: na("Hosted consent is covered by the organization Claude Code scenario."),
    },
  },
  connectedAgents: {
    fixtures: "actors",
    file: "connected-agents.spec.ts",
    title: "Members see the agents they connected over OAuth and revoking one ends its MCP access",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no organization members or hosted OAuth consent."),
    },
  },
  connectedAgentsActivity: {
    fixtures: "actors",
    file: "connected-agents.spec.ts",
    title: "Connected agents list only usable agents, by last use, and each can be revoked",
    targets: {
      "self-host": scheduled,
      cloud: na("Advances the wall clock of a runner-owned product process."),
      local: na("Local has no organization members or hosted OAuth consent."),
    },
  },
  connectedAgentsReauthorize: {
    fixtures: "actors",
    file: "connected-agents.spec.ts",
    title:
      "Authorizing a client again revokes its idle grants, but not its live ones or another client's",
    targets: {
      "self-host": scheduled,
      cloud: na("Advances the wall clock of a runner-owned product process."),
      local: na("Local has no organization members or hosted OAuth consent."),
    },
  },
  connectedAgentsIdleExpiry: {
    fixtures: "actors",
    file: "connected-agents.spec.ts",
    title:
      "Grants idle for 30 days without a usable token are revoked; one with a valid refresh token is kept",
    targets: {
      "self-host": scheduled,
      cloud: na("Advances the wall clock of a runner-owned product process."),
      local: na("Local has no organization members or hosted OAuth consent."),
    },
  },
  mcpStaleRefresh: {
    fixtures: "actors",
    file: "mcp-oauth-refresh.spec.ts",
    title: "A sibling MCP client refreshing a rotated grant keeps every instance signed in",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario tests hosted organization consent, which Local does not have."),
    },
  },
  mcpLateRefreshReuse: {
    fixtures: "actors",
    file: "mcp-oauth-refresh.spec.ts",
    title: "A rotated MCP refresh token replayed after the access-token hour ends every copy",
    targets: {
      "self-host": scheduled,
      cloud: na("Advances the wall clock of a runner-owned product process."),
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
  mcpOAuthWithoutResource: {
    fixtures: "actors",
    file: "mcp-server.spec.ts",
    title: "MCP OAuth without a resource parameter grants the plain /mcp URL",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local's consent is covered by localMcpOAuthWithoutResource."),
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
  organizationRemovalRecovery: {
    fixtures: "actors",
    file: "organization-removal-recovery.spec.ts",
    title:
      "Cloud starts organization removals whose Workflow start stalled from the recovery alarm without cron, past a full page of older tombstones, keeps the alarm for a removal that arms during a run, and stops it once none is pending",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host has a single instance organization and no organization removal."),
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
});

/**
 * How the run reaches Cloud. Managed Cloud is local and turns the per-address auth limit off, as
 * deployed test stages do; a rate-limited run starts it with the limit on for the scenarios that
 * prove it, and runs only those. A rolled-back run starts it with its rollback switch on, sign-in
 * on the deployment origin, and runs only the scenarios that prove the switch.
 */
export type CloudMode =
  | "managed"
  | "attached"
  | "rate-limited"
  | "rolled-back"
  | "oauth-proxy-preview";

const cloudRuntimeReasons = {
  managed: "Requires the managed local Cloud target and its local collectors.",
  attached: "Requires a deployed Cloud target with Cloudflare's placement and runtime limits.",
  "rate-limited":
    "Requires a managed local Cloud with the per-address auth limit on: e2e:cloud --auth-rate-limit.",
  "rolled-back":
    "Requires a managed local Cloud with its rollback switch on: e2e:cloud --rollback.",
  "oauth-proxy-preview":
    "Requires a managed test stage signing in through a second local Cloud's OAuth proxy: e2e:cloud --oauth-proxy-preview.",
} as const;

/**
 * The deployed suite's default `--test-name`, which Cloud tests on main runs after every merge.
 * Claude Code's scenario needs a model API key. Exhausting the shared compiler can interrupt other
 * scenarios' builds, so the compiler memory scenario runs alone, by hand (see e2e/README.md).
 */
export const deployedSuitePattern =
  "^(?!.*(?:Claude Code connects|Cloud compiler memory failures))";

/** Hosted parity includes every scenario scheduled on both hosted products. */
export const scenariosForSuite = (suite: "all" | "hosted", cloudMode: CloudMode = "managed") =>
  Object.values(scenarios)
    .filter(
      (scenario) =>
        suite === "all" ||
        (scenario.targets["self-host"].status === "scheduled" &&
          scenario.targets.cloud.status === "scheduled"),
    )
    .map((scenario): typeof TestPlan.Type => {
      const cloud = scenario.targets.cloud;
      if (cloud.status !== "scheduled") return scenario;
      const runs =
        cloud.runtime === undefined
          ? cloudMode !== "rate-limited" &&
            cloudMode !== "rolled-back" &&
            cloudMode !== "oauth-proxy-preview"
          : cloud.runtime === cloudMode;
      return runs
        ? scenario
        : {
            ...scenario,
            targets: {
              ...scenario.targets,
              cloud: na(
                cloud.runtime === undefined
                  ? cloudMode === "rolled-back"
                    ? "Runs on Cloud with sign-in on app., without the rollback switch."
                    : cloudMode === "oauth-proxy-preview"
                      ? "Runs on Cloud as the OAuth proxy's production, not on a stage signing in through it."
                      : "Runs on Cloud without the per-address auth limit."
                  : cloudRuntimeReasons[cloud.runtime],
              ),
            },
          };
    });

/** Select only explicitly scheduled files for a target; cloud scale stays disabled. */
export const filesForTarget = (
  target: typeof Target.Type,
  suite: "all" | "hosted",
  cloudMode: CloudMode = "managed",
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
  cloudMode: CloudMode = "managed",
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
