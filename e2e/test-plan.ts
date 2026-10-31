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
  managementApps: Schema.optional(Schema.Array(Schema.Literals(["owner", "admin", "member"]))),
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
/** Reads or writes app source, which needs Cloudflare Artifacts: managed local Cloud has none. */
const sourceStorageCloud = { status: "scheduled", runtime: "attached" } as const;
/**
 * Registers Executor's OAuth callback with a service that accepts only HTTPS or bare loopback
 * redirects: managed local Cloud's callback is plain HTTP on a named `.localhost` host.
 */
const httpsCallbackCloud = { status: "scheduled", runtime: "attached" } as const;
/**
 * Installs an app from the official app feed production publishes, which deployed stages read:
 * managed local Cloud reads no feed and lists only the built-in Executor app.
 */
const officialFeedCloud = { status: "scheduled", runtime: "attached" } as const;
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
/**
 * The execute budget of the lazy stall scenario: longer than execute's 10 s discovery wait, so a
 * stalled app reached during the program is told apart from one discovery gave up on.
 */
export const lazyStallTimeoutMs = 15_000;
/**
 * Seconds after which the aged search rows scenarios' server renews the rows a search serves
 * (`EXECUTOR_TOOL_LISTING_RENEW_SECONDS`), in place of the default day: MCP readers never renew
 * the rows they read, so every app's rows age past it together.
 */
export const agedRowsRenewSeconds = 30;
/** Seconds an idle app Worker stays loaded in the idle unloading scenario. */
export const appWorkerIdleSeconds = 4;
/** A relay callback in a valid form other than its serialization, which the SDK sends. */
export const oauthRelayCallback =
  "https://Relay.Executor.example:443/api/oauth/callback?tenant=fixture";
/** The same, on the origin of the client metadata document the scenarios publish. */
export const oauthDocumentOriginCallback =
  "https://Executor.example:443/api/oauth/callback?tenant=fixture";

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
      "Cloud connected-account sign-ins return through the edge's callback to the browser origin, and saved clients' deployment-origin callback still finishes there",
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
  releasedClientPackageNames: {
    fixtures: "actors",
    file: "released-client-package-names.spec.ts",
    title:
      "Clients released before publisher scopes read Cloud's app source and public listings by names they decode",
    targets: {
      cloud: sourceStorageCloud,
      "self-host": na("Self-host does not publish apps or serve the public registry."),
      local: na("Local does not publish apps or serve the public registry."),
    },
  },
  releasedClientWriteBinding: {
    fixtures: "actors",
    file: "released-client-package-names.spec.ts",
    title:
      "Clients released before publisher scopes cannot remove a listing by its short name, and copy only the commit they were shown across a replacement, a rename and a reused slug",
    targets: {
      cloud: sourceStorageCloud,
      "self-host": na("Self-host does not publish apps or serve the public registry."),
      local: na("Local does not publish apps or serve the public registry."),
    },
  },
  packageScopes: {
    fixtures: "actors",
    file: "package-scopes.spec.ts",
    title:
      "Package names follow the organization's current slug, and a rename releases the old one to its next holder",
    targets: {
      // Publishing needs app Git storage, which a local Cloud Worker cannot reach.
      cloud: { status: "scheduled", runtime: "attached" },
      "self-host": na("Self-host does not publish apps."),
      local: na("Local does not publish apps."),
    },
  },
  appGitRemotes: {
    fixtures: "actors",
    file: "app-git-remotes.spec.ts",
    title:
      "Git clones and pushes through the remote the host names, with the session the CLI signed in with, streams a 42 MiB push, accepts a shallow push, refuses protected refs as Git reports them, and reads source and history that is larger than one Git response a Worker holds",
    targets: {
      // Managed local Cloud has no Git storage; deployed stages have Cloudflare's.
      cloud: { status: "scheduled", runtime: "attached" },
      "self-host": scheduled,
      local: na("Local signs the CLI in with an API key, not a saved session."),
    },
  },
  appGitKeptCredentials: {
    fixtures: "actors",
    file: "app-git-remotes.spec.ts",
    title:
      "Git does not send a copy of the CLI's token that another credential helper kept past the point where the CLI refreshes it, and gets a refreshed one instead",
    targets: {
      cloud: { status: "scheduled", runtime: "attached" },
      "self-host": scheduled,
      local: na("Local signs the CLI in with an API key, not a saved session."),
    },
  },
  deviceLoginCli: {
    fixtures: "actors",
    file: "device-login.spec.ts",
    title:
      "The CLI signs in with a code typed on the device page when no browser opens, and keeps an ordinary session",
    targets: {
      cloud: scheduled,
      "self-host": scheduled,
      local: na("Local signs the CLI in with an API key, not a saved session."),
    },
  },
  deviceLoginNoOsStore: {
    fixtures: "actors",
    file: "device-login.spec.ts",
    title:
      "Over SSH without an OS credential store, the CLI opens no browser, saves its session in a file only the user can read, and keeps working",
    targets: {
      cloud: scheduled,
      "self-host": scheduled,
      local: na("Local signs the CLI in with an API key, not a saved session."),
    },
  },
  deviceLoginDenied: {
    fixtures: "actors",
    file: "device-login.spec.ts",
    title:
      "The CLI opens the device page with its code, and a denial there ends the CLI with that reason",
    targets: {
      cloud: scheduled,
      "self-host": scheduled,
      local: na("Local signs the CLI in with an API key, not a saved session."),
    },
  },
  deviceLoginBrowserStays: {
    fixtures: "actors",
    file: "device-login.spec.ts",
    title:
      "The CLI polls while the browser it started stays open, signs in once approved and leaves that browser open",
    targets: {
      cloud: scheduled,
      "self-host": scheduled,
      local: na("Local signs the CLI in with an API key, not a saved session."),
    },
  },
  deviceAuthorizationGrant: {
    fixtures: "actors",
    file: "device-login.spec.ts",
    title:
      "Device authorization polls with RFC 8628 errors and redeems an approved code once for the chosen organization",
    targets: {
      cloud: scheduled,
      "self-host": scheduled,
      local: na("Local has no device verification page; its clients open a browser."),
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
  cloudInvocationSurface: {
    fixtures: "actors",
    file: "cloud-role-hosts.spec.ts",
    title:
      "Cloud invocation records name each request's host role, route group and client family, never its URL or user agent",
    targets: {
      // Records come from the Tail receiver. Alchemy's local runtime delivers no tail events to it.
      cloud: { status: "scheduled", runtime: "attached" },
      "self-host": na("The Tail receiver and role hosts are Cloud's."),
      local: na("The Tail receiver and role hosts are Cloud's."),
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
  cloudOAuthProxyPreviewAccount: {
    fixtures: "actors",
    file: "cloud-oauth-proxy.spec.ts",
    title:
      "A test stage connects an account with production's OAuth callback, which returns the sign-in to the stage",
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
    title: "at most the configured number of app Workers stay loaded as apps and accounts grow",
    serverEnvironment: { EXECUTOR_APP_WORKERS: String(appWorkerBudgetLimit) },
    targets: {
      "self-host": scheduled,
      cloud: na("Cloudflare unloads Cloud's app Workers itself."),
      local: na("Local is covered by the local app Worker budget scenario."),
    },
  },
  appWorkerIdleUnloaded: {
    fixtures: "actors",
    file: "app-worker-budget.spec.ts",
    title: "app Workers and data facets left idle unload below the limit; busy ones stay loaded",
    serverEnvironment: { EXECUTOR_APP_WORKER_IDLE_SECONDS: String(appWorkerIdleSeconds) },
    targets: {
      "self-host": scheduled,
      cloud: na("Cloudflare unloads Cloud's app Workers itself."),
      local: na(
        "Self-host covers the shared runner's Worker residency; the local budget scenario covers local's limit.",
      ),
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
      "local keeps at most the configured number of app Workers loaded as apps and accounts grow",
    serverEnvironment: { EXECUTOR_APP_WORKERS: String(appWorkerBudgetLimit) },
    targets: {
      local: scheduled,
      "self-host": na("Hosted budgets are covered through organization routes."),
      cloud: na("Cloudflare unloads Cloud's app Workers itself."),
    },
  },
  keptListingsAfterRestart: {
    fixtures: "actors",
    file: "kept-listings.spec.ts",
    title:
      "after a restart and past their freshness, search and the skills index serve kept results without loading any app's Worker",
    targets: {
      "self-host": scheduled,
      cloud: na("Kills and restarts a runner-owned product process."),
      local: na("Local is covered by the local kept listings scenario."),
    },
  },
  localKeptListingsAfterRestart: {
    file: "kept-listings.spec.ts",
    title:
      "local search and skills index serve kept results after a restart without loading any app's Worker",
    targets: {
      local: scheduled,
      "self-host": na("Hosted kept listings are covered through organization routes."),
      cloud: na("Kills and restarts a runner-owned product process."),
    },
  },
  workflowReplayAccess: {
    fixtures: "actors",
    file: "workflow-replay-access.spec.ts",
    title: "workflow replay checks retained account access after the caller's links change",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario exercises hosted account sharing and account links."),
    },
  },
  activeVersionTools: {
    fixtures: "actors",
    file: "active-version-tools.spec.ts",
    title: "Hosted new tool calls reject retired versions and preserve active approval policy",
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
      "Hosted dashboard approvals of an app without accounts are read and answered only by the member who started the run",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local does not have organization memberships."),
    },
  },
  hostedToolRunnerPreviousServer: {
    fixtures: "actors",
    file: "tool-runner-approvals.spec.ts",
    title:
      "Hosted dashboard reviews show what the previous release's server answered and never offer an answer Executor received again",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local shares the review card and its decoder with hosted dashboards."),
    },
  },
  activeVersionResume: {
    fixtures: "actors",
    file: "active-version-tools.spec.ts",
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
    title: "Public GraphQL callers share metadata while query results remain live",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback introspection fixture"),
      local: na("Hosted app version scenario"),
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
      local: na("Hosted app version scenario"),
    },
  },
  graphqlStatedErrors: {
    fixtures: "actors",
    file: "graphql-errors.spec.ts",
    title: "GraphQL failures carry the errors the server stated, bounded and with secrets replaced",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback GraphQL fixture"),
      local: na("Hosted app version scenario"),
    },
  },
  mcpCatalogCache: {
    fixtures: "actors",
    file: "mcp-catalog.spec.ts",
    title: "MCP catalog cache skips repeated discovery and revalidates account revisions",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback default; external emulators.dev fixture used for remote measurement"),
      local: na("Hosted version API scenario"),
    },
  },
  mcpCatalogAccountsOneCommand: {
    fixtures: "actors",
    file: "mcp-catalog.spec.ts",
    title:
      "MCP catalog warm calls alternating between two accounts read each catalog and tool in one cache command",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Framework catalog code, the same on Cloud; Cloud's hop is covered by tool-call-overhead",
      ),
      local: na("Hosted version API scenario"),
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
      local: na("Hosted version API scenario"),
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
      local: na("Hosted version API scenario"),
    },
  },
  mcpListingUpstreamChange: {
    fixtures: "actors",
    file: "mcp-catalog.spec.ts",
    title:
      "MCP execute and search reach tools an MCP server adds without announcing them, after the app's routine refresh and without a redeploy",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback MCP fixture; the shared execute path is covered on self-host"),
      local: na("Hosted version API scenario"),
    },
  },
  mcpExecuteSignatures: {
    fixtures: "actors",
    file: "mcp-catalog.spec.ts",
    title: "MCP execute renders tool signatures only for the results CodeMode's search() returns",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback MCP fixture; the shared execute path is covered on self-host"),
      local: na("Hosted version API scenario"),
    },
  },
  mcpSlowListing: {
    fixtures: "actors",
    file: "mcp-catalog-scale.spec.ts",
    title: "MCP execute pays for a slow app's tool listing once and reuses it",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback slow upstream; the shared execute path is covered on self-host"),
      local: na("Hosted version API scenario"),
    },
  },
  mcpAgedSearchRows: {
    fixtures: "actors",
    file: "mcp-catalog-scale.spec.ts",
    title:
      "MCP execute serves a search from rows past the renewal age at once and renews them in the background",
    serverEnvironment: { EXECUTOR_TOOL_LISTING_RENEW_SECONDS: String(agedRowsRenewSeconds) },
    targets: {
      "self-host": scheduled,
      cloud: na("Needs a short renewal age; Cloud serves search through the same listings code"),
      local: na("Hosted version API scenario"),
    },
  },
  mcpAgedRowsFailedRenewal: {
    fixtures: "actors",
    file: "mcp-catalog-scale.spec.ts",
    title:
      "MCP execute keeps searching an app's aged rows when renewing them fails, reports why, and renews them once its upstream recovers",
    serverEnvironment: { EXECUTOR_TOOL_LISTING_RENEW_SECONDS: String(agedRowsRenewSeconds) },
    targets: {
      "self-host": scheduled,
      cloud: na("Needs a short renewal age and a loopback upstream; same listings code"),
      local: na("Hosted version API scenario"),
    },
  },
  // The Cloud listing scenarios read a running listing or a remembered timeout, which live only
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
      local: na("Hosted version API scenario"),
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
      local: na("Hosted version API scenario"),
    },
  },
  mcpStoppedRenewalCloud: {
    fixtures: "actors",
    file: "mcp-catalog-scale.spec.ts",
    title:
      "Cloud keeps serving aged search rows when it stops their renewal, and does not start it again at once",
    targets: {
      cloud: managedCloud,
      "self-host": na(
        "Self-host never refuses background work, so its aged-row renewals always run as their own and stop at the load bound",
      ),
      local: na("Hosted version API scenario"),
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
      local: na("Hosted version API scenario"),
    },
  },
  mcpListingInputs: {
    fixtures: "actors",
    file: "mcp-catalog-scale.spec.ts",
    title:
      "MCP execute lists tools again for a new version, link change or credential, never across callers or after revoked access",
    targets: {
      "self-host": scheduled,
      cloud: na("Shared execute path; covered on self-host"),
      local: na("Hosted version API scenario"),
    },
  },
  mcpSearchConcise: {
    file: "mcp-search-concise.spec.ts",
    title:
      "A broad MCP tool search returns concise pages within their byte budget and describe returns full signatures",
    targets: {
      local: scheduled,
      "self-host": na("Shared MCP search; covered on local"),
      cloud: na("Shared MCP search; covered on local"),
    },
  },
  mcpLargeResult: {
    file: "mcp-large-result.spec.ts",
    title:
      "MCP execute and call return a result far over 100,000 bytes whole, as a success that parses, with every log line",
    targets: {
      local: scheduled,
      "self-host": na("Hosted scenario covers self-host"),
      cloud: na("Hosted scenario covers Cloud"),
    },
  },
  mcpRpcLimitForged: {
    file: "mcp-large-result.spec.ts",
    title:
      "A tool failure that only imitates the runtime's 32 MiB RPC limit is a likely cause a read may retry, and the unchanged retry succeeds",
    targets: {
      local: scheduled,
      "self-host": na("Shared runtime classification; covered on local"),
      cloud: na("Shared runtime classification; covered on local"),
    },
  },
  mcpLargeResultHosted: {
    fixtures: "actors",
    file: "mcp-large-result.spec.ts",
    title:
      "Self-host and Cloud return an MCP result far over 100,000 bytes whole from execute and call, as a success that parses",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local scenario covers local"),
    },
  },
  mcpLargeResultMemoryLimit: {
    fixtures: "actors",
    file: "mcp-large-result.spec.ts",
    title:
      "A Cloud MCP result too large for the session object's 128 MB memory gets an error naming that limit at once, and the session keeps working",
    targets: {
      cloud: { status: "scheduled", runtime: "attached" },
      "self-host": na("Cloud's Durable Object memory limit; self-host returns the value whole"),
      local: na("Cloud's Durable Object memory limit; local returns the value whole"),
    },
  },
  mcpExecuteConcurrency: {
    fixtures: "actors",
    file: "mcp-execute-concurrency.spec.ts",
    title:
      "Hosted MCP execute runs async jobs one at a time and in JavaScript's order, so concurrent updates are never lost and reactions run when Node runs them",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local runs the same programs in localMcpExecuteConcurrency."),
    },
  },
  localMcpExecuteConcurrency: {
    file: "mcp-execute-concurrency.spec.ts",
    title:
      "Local MCP execute runs async jobs one at a time and in JavaScript's order, so concurrent updates are never lost and reactions run when Node runs them",
    targets: {
      local: scheduled,
      "self-host": na("Hosted products run the same programs in mcpExecuteConcurrency."),
      cloud: na("Hosted products run the same programs in mcpExecuteConcurrency."),
    },
  },
  mcpExecuteRecursion: {
    fixtures: "actors",
    file: "mcp-execute-concurrency.spec.ts",
    title:
      "Hosted MCP execute fails runaway async recursion with the nesting-depth error instead of hanging, and still returns from a deep chain of async calls",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local runs the same programs in localMcpExecuteRecursion."),
    },
  },
  localMcpExecuteRecursion: {
    file: "mcp-execute-concurrency.spec.ts",
    title:
      "Local MCP execute fails runaway async recursion with the nesting-depth error instead of hanging, and still returns from a deep chain of async calls",
    targets: {
      local: scheduled,
      "self-host": na("Hosted products run the same programs in mcpExecuteRecursion."),
      cloud: na("Hosted products run the same programs in mcpExecuteRecursion."),
    },
  },
  mcpExecuteCallDepth: {
    fixtures: "actors",
    file: "mcp-execute-concurrency.spec.ts",
    title:
      "Hosted MCP execute leaves a generator usable after a step fails at the call depth limit, and returns from deep generator chains",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local runs the same programs in localMcpExecuteCallDepth."),
    },
  },
  localMcpExecuteCallDepth: {
    file: "mcp-execute-concurrency.spec.ts",
    title:
      "Local MCP execute leaves a generator usable after a step fails at the call depth limit, and returns from deep generator chains",
    targets: {
      local: scheduled,
      "self-host": na("Hosted products run the same programs in mcpExecuteCallDepth."),
      cloud: na("Hosted products run the same programs in mcpExecuteCallDepth."),
    },
  },
  mcpExecuteReach: {
    fixtures: "actors",
    file: "mcp-execute-reach.spec.ts",
    title: "MCP execute discovers only the apps a program reaches through dynamic access to tools",
    targets: {
      "self-host": scheduled,
      cloud: na("Shared execute path; covered on self-host"),
      local: na("Hosted version API scenario"),
    },
  },
  mcpGlobalSearchLoadsNoListings: {
    fixtures: "actors",
    file: "mcp-execute-lazy.spec.ts",
    title:
      "MCP execute serves CodeMode's search() from the backend search, loads no tool listing for it, and loads only a called result's app",
    targets: {
      "self-host": scheduled,
      cloud: na("Shared execute path; covered on self-host"),
      local: na("Hosted version API scenario"),
    },
  },
  mcpDynamicToolsLoadOneApp: {
    fixtures: "actors",
    file: "mcp-execute-lazy.spec.ts",
    title:
      "MCP execute loads an app a program reaches through dynamic access to tools when it first uses it, and lists apps without loading them",
    targets: {
      "self-host": scheduled,
      cloud: na("Shared execute path; covered on self-host"),
      local: na("Hosted version API scenario"),
    },
  },
  mcpDynamicToolsStallTimesOut: {
    fixtures: "actors",
    file: "mcp-execute-lazy.spec.ts",
    title:
      "MCP execute reports a program reaching a stalled app through dynamic access to tools as timed out at its own deadline, not as a failed app",
    serverEnvironment: { EXECUTOR_MCP_TIMEOUT_MS: String(lazyStallTimeoutMs) },
    targets: {
      "self-host": scheduled,
      cloud: na("Shared execute path; covered on self-host"),
      local: na("Hosted version API scenario"),
    },
  },
  mcpDirectCalls: {
    fixtures: "actors",
    file: "mcp-direct-calls.spec.ts",
    title: "MCP search, describe and call reach app tools without an execute program",
    targets: {
      "self-host": scheduled,
      cloud: na("Shared MCP path; covered on self-host"),
      local: na("Hosted version API scenario"),
    },
  },
  mcpNativeCallApproval: {
    fixtures: "actors",
    file: "mcp-direct-calls.spec.ts",
    title: "Native MCP call leaves approval to the client's confirmation of the call",
    targets: {
      "self-host": scheduled,
      cloud: na("Shared MCP path; covered on self-host"),
      local: na("Hosted version API scenario"),
    },
  },
  mcpCatalogRefresh: {
    fixtures: "actors",
    file: "mcp-catalog.spec.ts",
    title: "MCP catalog notifications invalidate schemas and failed refreshes retain values",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback notification fixture"),
      local: na("Hosted version API scenario"),
    },
  },
  liveOpenapi: {
    fixtures: "actors",
    file: "live-openapi.spec.ts",
    title: "Live OpenAPI refreshes operations while preserving static credential placement",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback upstream fixture; deployed Cloud API benchmark covers the live runtime"),
      local: na("Hosted version API scenario"),
    },
  },
  liveOpenapiRetired: {
    fixtures: "actors",
    file: "live-openapi.spec.ts",
    title:
      "Live OpenAPI reports an operation its upstream removed as an unknown tool after one shared recheck",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback upstream fixture"),
      local: na("Hosted version API scenario"),
    },
  },
  liveOpenapiYaml: {
    fixtures: "actors",
    file: "live-openapi-yaml.spec.ts",
    title: "Live OpenAPI reads YAML with aliases and refuses alias bombs",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback upstream fixture"),
      local: na("Hosted version API scenario"),
    },
  },
  liveOpenapiExampleIds: {
    fixtures: "actors",
    file: "live-openapi-example-ids.spec.ts",
    title: "Live OpenAPI validates and calls tools whose schema examples repeat an id",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback upstream fixture"),
      local: na("Hosted version API scenario"),
    },
  },
  liveOpenapiDiagnostics: {
    fixtures: "actors",
    file: "live-openapi-import.spec.ts",
    title: "Live OpenAPI names the operations, origins and schema pointers it cannot import",
    targets: {
      "self-host": scheduled,
      cloud: na("The importer runs the same app code on every host; covered on self-host."),
      local: na("Hosted version API scenario"),
    },
  },
  liveOpenapiAlternatives: {
    fixtures: "actors",
    file: "live-openapi-import.spec.ts",
    title:
      "Live OpenAPI ignores security alternatives naming undeclared schemes and sends only the met one's credentials",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback upstream fixture"),
      local: na("Hosted version API scenario"),
    },
  },
  liveOpenapiExtensions: {
    fixtures: "actors",
    file: "live-openapi-import.spec.ts",
    title:
      "Live OpenAPI lists and calls account tools whose schemas carry extensions holding references",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback upstream fixture"),
      local: na("Hosted version API scenario"),
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
      local: na("Hosted version API scenario"),
    },
  },
  liveOpenapiV1Documents: {
    fixtures: "actors",
    file: "live-openapi-import.spec.ts",
    title:
      "Live OpenAPI imports the documents Executor v1 imported: loose schema references, event streams beside JSON, paths with a query or fragment, and fields v1 ignored",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback upstream fixture"),
      local: na("Hosted version API scenario"),
    },
  },
  liveOpenapiNaming: {
    fixtures: "actors",
    file: "live-openapi-import.spec.ts",
    title: "Live OpenAPI keeps its released tool names and lists them without an account",
    targets: {
      "self-host": scheduled,
      cloud: na("The importer runs the same app code on every host; covered on self-host."),
      local: na("Hosted version API scenario"),
    },
  },
  liveOpenapiCache: {
    fixtures: "actors",
    file: "live-openapi-cache.spec.ts",
    title: "Live OpenAPI reuses fresh definitions and validates input before dispatch",
    targets: {
      "self-host": scheduled,
      cloud: na("Loopback upstream fixture; deployed Cloud API benchmark covers the live runtime"),
      local: na("Hosted version API scenario"),
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
      local: na("Hosted version API scenario"),
    },
  },
  providerIcons: {
    fixtures: "actors",
    file: "provider-icons.spec.ts",
    title: "Renamed providers use only an unambiguous public host for their fallback logo",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted deployment fixture; the shared dashboard renders local provider icons"),
    },
  },
  appIcons: {
    fixtures: "actors",
    file: "app-icons.spec.ts",
    title: "Apps show the icons they declare on defineApp, in the light or dark variant",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted version API scenario; the local overview carries the same requirements"),
    },
  },
  dynamicOnlyApp: {
    fixtures: "actors",
    file: "dynamic-only-app.spec.ts",
    title: "Dynamic-only apps resolve and call tools without a static catalog",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted app API fixture; Node adapter exercised by self-host"),
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
      local: na("Hosted app API fixture; Node adapter exercised by self-host"),
    },
  },
  appCacheAccounts: {
    fixtures: "actors",
    file: "app-cache-accounts.spec.ts",
    title: "App cache isolates accounts, credential rotations and unlinked accounts",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted app API fixture; Node adapter exercised by self-host"),
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
  appCacheLimits: {
    fixtures: "actors",
    file: "app-cache-limits.spec.ts",
    title:
      "App cache shortens lifetimes past its retention and names the size limit a value exceeds",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted app deploy and tool call routes."),
    },
  },
  appCache: {
    fixtures: "actors",
    file: "app-cache.spec.ts",
    title: "App cache shares values, coalesces loads and retains values after refresh failure",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted app API fixture; Node adapter exercised by self-host"),
    },
  },
  toolsIndexCache: {
    fixtures: "actors",
    file: "tools-index-cache.spec.ts",
    managementApps: ["owner", "admin"],
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
  dashboardReadStatus: {
    fixtures: "actors",
    file: "dashboard-read-batches.spec.ts",
    title:
      "Each batched dashboard read's span records the status it answered, and a server error fails it",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("The local dashboard does not batch its reads; most of them are live streams"),
    },
  },
  dashboardBuildChange: {
    fixtures: "actors",
    file: "dashboard-read-batches.spec.ts",
    title:
      "A dashboard tab left open across a server upgrade offers a reload and explains its refused reads as the update",
    targets: {
      "self-host": scheduled,
      cloud: na("Managed Cloud cannot restart its Workers as another build"),
      local: na("The local dashboard does not batch its reads; self-host covers the shared check"),
    },
  },
  appCacheStalledLoader: {
    fixtures: "actors",
    file: "app-cache-stalled-loader.spec.ts",
    title: "App cache callers outlast a stalled loader and the cache recovers after it",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted app API fixture; Node adapter exercised by self-host"),
    },
  },
  appCacheFences: {
    fixtures: "actors",
    file: "app-cache-fences.spec.ts",
    title: "App cache fences invalidated loaders and retains background refreshes",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted app API fixture; Node adapter exercised by self-host"),
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
  selfHostSsoDiscoveryRedirect: {
    file: "self-host-sso.spec.ts",
    title: "Self-host SSO stays unavailable when its HTTPS discovery redirects to cleartext",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud customer SSO has its own OIDC scenario."),
      local: na("Local has no sign-in or SSO."),
    },
  },
  selfHostSsoCleartextSignIn: {
    file: "self-host-sso.spec.ts",
    title: "Self-host SSO stays unavailable when discovery names a cleartext sign-in page",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud customer SSO has its own OIDC scenario."),
      local: na("Local has no sign-in or SSO."),
    },
  },
  selfHostSsoCleartextTokenOrKeys: {
    file: "self-host-sso.spec.ts",
    title: "Self-host SSO stays unavailable when discovery names cleartext token or key endpoints",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud customer SSO has its own OIDC scenario."),
      local: na("Local has no sign-in or SSO."),
    },
  },
  selfHostSsoHttpsEndpoints: {
    file: "self-host-sso.spec.ts",
    title: "Self-host SSO signs in over HTTPS endpoints and refuses token or key redirects",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud customer SSO has its own OIDC scenario."),
      local: na("Local has no sign-in or SSO."),
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
      "desktop shows a background server stopped on purpose as stopped without starting one, joins the next one the CLI starts or starts one from that page, replaces a crashed one, shows recovery after three crashes within a minute and reconnects from the recovery page",
    targets: {
      local: {
        status: "not-run",
        reason:
          "Runs against the packaged desktop in the release workflow with desktop-recovery.config.ts.",
      },
      cloud: na("Desktop background server connection"),
      "self-host": na("Desktop background server connection"),
    },
  },
  desktopSharedService: {
    file: "desktop-recovery.spec.ts",
    title:
      "desktop and CLI share one background server for a data directory, which keeps running after the desktop quits",
    targets: {
      local: {
        status: "not-run",
        reason:
          "Runs against the packaged desktop in the release workflow with desktop-recovery.config.ts.",
      },
      cloud: na("Desktop background server connection"),
      "self-host": na("Desktop background server connection"),
    },
  },
  desktopMigrationMoved: {
    file: "desktop-recovery.spec.ts",
    title:
      "desktop moves its old data and port into the CLI's empty data directory once, before starting the server, leaves it private whatever the old directory's mode, and explains a move it cannot make yet",
    targets: {
      local: {
        status: "not-run",
        reason:
          "Runs against the packaged desktop in the release workflow with desktop-recovery.config.ts.",
      },
      cloud: na("Desktop data migration"),
      "self-host": na("Desktop data migration"),
    },
  },
  desktopMigrationReplaced: {
    file: "desktop-recovery.spec.ts",
    title:
      "desktop data replaces the CLI's data in the shared directory, which is stopped, archived and named in a notice that shows once, on the launch that moved it",
    targets: {
      local: {
        status: "not-run",
        reason:
          "Runs against the packaged desktop in the release workflow with desktop-recovery.config.ts.",
      },
      cloud: na("Desktop data migration"),
      "self-host": na("Desktop data migration"),
    },
  },
  desktopMigrationReplacedClosed: {
    file: "desktop-recovery.spec.ts",
    title:
      "desktop window closed while its data replaces the CLI's data ends the app once the move is done, before any server starts and with only the app's own menu meanwhile, and the next launch names the archived CLI data in a notice that shows once",
    targets: {
      local: {
        status: "not-run",
        reason:
          "Runs against the packaged desktop in the release workflow with desktop-recovery.config.ts.",
      },
      cloud: na("Desktop data migration"),
      "self-host": na("Desktop data migration"),
    },
  },
  desktopMigrationSettings: {
    file: "desktop-recovery.spec.ts",
    title:
      "desktop moving its data into a CLI data directory that holds only settings keeps the CLI's env settings with the desktop's port, leaves out the CLI's key settings and turns the service back on, uses the CLI's settings as they are when a move kept from an earlier launch finishes, and names where its settings went and what changed in a notice",
    targets: {
      local: {
        status: "not-run",
        reason:
          "Runs against the packaged desktop in the release workflow with desktop-recovery.config.ts.",
      },
      cloud: na("Desktop data migration"),
      "self-host": na("Desktop data migration"),
    },
  },
  desktopSlowStop: {
    file: "desktop-recovery.spec.ts",
    title:
      "desktop shows a background server that takes seconds to stop, answering that it is stopping, as stopped, without starting one or counting a crash, and joins the next one the CLI starts",
    targets: {
      local: {
        status: "not-run",
        reason:
          "Runs against the packaged desktop in the release workflow with desktop-recovery.config.ts.",
      },
      cloud: na("Desktop background server connection"),
      "self-host": na("Desktop background server connection"),
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
  desktopDashboardRetry: {
    file: "desktop-recovery.spec.ts",
    title:
      "desktop loads a dashboard that failed to load again with a fresh pairing link, shows the dashboard's own recovery page, without reset, with the failure after three failures in a row, and pairs the window again from that page",
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
  desktopStarterDeadline: {
    file: "desktop-recovery.spec.ts",
    title:
      "desktop shows the start recovery page when its server starter stops answering after starting a server, ends the start attempt a hung starter left, and starts a server from that page",
    targets: {
      local: {
        status: "not-run",
        reason:
          "Runs against the packaged desktop in the release workflow with desktop-recovery.config.ts.",
      },
      cloud: na("Desktop background server connection"),
      "self-host": na("Desktop background server connection"),
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
      "desktop missing-key failure offers reset, which backs up the data with a manifest and starts fresh, or leaves it in place when the move fails, and resets data whose background server was killed",
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
      "desktop does not offer reset when its data is in use, its key settings do not match, EXECUTOR_KEY_STORAGE is invalid, which creates nothing, or the OS credential store is unavailable or denies access",
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
  localBootstrapPair: {
    file: "local-bootstrap.spec.ts",
    title:
      "local pair needs no saved keys, and executor --server sends the key where the directory keeps it to its running server, never creating, replacing or moving keys",
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
      cloud: sourceStorageCloud,
      local: na("Local has no organization member roles."),
    },
  },
  memberControlsMobile: {
    fixtures: "actors",
    file: "member-controls.spec.ts",
    title: "Mobile member restrictions keep controls visible and the app overview stable",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
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
  localPair: {
    file: "local-pair.spec.ts",
    title:
      "local pair prints a link from the registered server whatever EXECUTOR_PORT says, and explains no running server, a rejected supplied key, a bad port or another service on it without changing keys",
    targets: {
      local: scheduled,
      cloud: na("Local CLI pairing"),
      "self-host": na("Local CLI pairing"),
    },
  },
  localUpgrade: {
    file: "local-upgrade.spec.ts",
    title:
      "executor upgrade installs the newest release with the detected or chosen package manager, refuses an old Node, prints commands for one-shot and unknown installs, verifies the new command, and stops a running background server for the install and starts it again on the new version, or the old one when the install fails",
    targets: {
      local: scheduled,
      cloud: na("Local CLI upgrade"),
      "self-host": na("Local CLI upgrade"),
    },
  },
  localCliLegacyCommands: {
    file: "local-cli-legacy-commands.spec.ts",
    title:
      "local CLI answers Executor 1 commands and their flags with the Executor 2 replacement and keeps them out of help",
    targets: {
      local: scheduled,
      cloud: na("Local CLI commands"),
      "self-host": na("Local CLI commands"),
    },
  },
  localServiceSharedStart: {
    // The CLI starts and stops its own servers; an outer managed server would compete with them.
    fixtures: "cli",
    file: "local-service.spec.ts",
    title:
      "two concurrent `executor service start` share one background server on the configured port, registered in a private server.json",
    targets: {
      local: scheduled,
      cloud: na("Local CLI background service"),
      "self-host": na("Local CLI background service"),
    },
  },
  localServiceJoin: {
    fixtures: "cli",
    file: "local-service.spec.ts",
    title:
      "`executor` joins the running background server, prints where it runs, opens a one-use link that pairs a browser and exits; the start that created keys.json names it",
    targets: {
      local: scheduled,
      cloud: na("Local CLI background service"),
      "self-host": na("Local CLI background service"),
    },
  },
  localServiceVersion: {
    fixtures: "cli",
    file: "local-service.spec.ts",
    title:
      "`executor` replaces a background server of another version, and `executor service start` keeps the version that runs",
    targets: {
      local: scheduled,
      cloud: na("Local CLI background service"),
      "self-host": na("Local CLI background service"),
    },
  },
  localServiceStandalone: {
    fixtures: "cli",
    file: "local-service.spec.ts",
    title:
      "`executor --standalone` runs a private server on another port without registering it, which a background start cannot stop, stops it when interrupted, fails once it stops on its own, and states its own reason when the background server holds the data directory",
    targets: {
      local: scheduled,
      cloud: na("Local CLI background service"),
      "self-host": na("Local CLI background service"),
    },
  },
  localServicePortInUse: {
    fixtures: "cli",
    file: "local-service.spec.ts",
    title:
      "`executor service start` names EXECUTOR_PORT or `executor service set port`, whichever chose the port another program holds, and `executor apps` reports it as a LocalServerUnavailable failure",
    targets: {
      local: scheduled,
      cloud: na("Local CLI background service"),
      "self-host": na("Local CLI background service"),
    },
  },
  localServiceLifecycle: {
    fixtures: "cli",
    file: "local-service.spec.ts",
    title:
      "`executor service status`, `restart` and `stop` report, replace and stop the background server, which starts with a lone EXECUTOR_API_KEY in the client's environment",
    targets: {
      local: scheduled,
      cloud: na("Local CLI background service"),
      "self-host": na("Local CLI background service"),
    },
  },
  localServiceRegistration: {
    fixtures: "cli",
    file: "local-service.spec.ts",
    title: "a background server stops within ten seconds once its server.json is removed",
    targets: {
      local: scheduled,
      cloud: na("Local CLI background service"),
      "self-host": na("Local CLI background service"),
    },
  },
  localServicePortSetting: {
    fixtures: "cli",
    file: "local-service.spec.ts",
    title:
      "`executor service set port` stops the background server, and the next start listens on the new port",
    targets: {
      local: scheduled,
      cloud: na("Local CLI background service"),
      "self-host": na("Local CLI background service"),
    },
  },
  localServiceDirectoryLock: {
    fixtures: "cli",
    file: "local-service.spec.ts",
    title:
      "a second `executor serve` for a data directory the registered server holds exits with the directory-in-use message naming that server's URL, on its port or another",
    targets: {
      local: scheduled,
      cloud: na("Local CLI background service"),
      "self-host": na("Local CLI background service"),
    },
  },
  localServiceAppsCli: {
    fixtures: "cli",
    file: "local-service.spec.ts",
    title:
      "`executor apps list` without --host starts the background server, and the next command reuses it; with the service disabled it runs a private server instead",
    targets: {
      local: scheduled,
      cloud: na("Local CLI background service"),
      "self-host": na("Local CLI background service"),
    },
  },
  localServiceEarlierServer: {
    fixtures: "cli",
    file: "local-service.spec.ts",
    title:
      "`executor service start` and `executor serve` refuse a data directory whose server.json names a running Executor from before the background service, and ignore such a record once nothing answers at its URL",
    targets: {
      local: scheduled,
      cloud: na("Local CLI background service"),
      "self-host": na("Local CLI background service"),
    },
  },
  localServiceImpostor: {
    fixtures: "cli",
    file: "local-service.spec.ts",
    title:
      "a process that replays a killed background server's service info on its port is not trusted: `executor service status` reports stopped, and `executor` neither pairs with it nor sends it the password",
    targets: {
      local: scheduled,
      cloud: na("Local CLI background service"),
      "self-host": na("Local CLI background service"),
    },
  },
  localServiceStopping: {
    fixtures: "cli",
    file: "local-service.spec.ts",
    title:
      "`executor service status` reports a background server that is stopping as stopping, and `executor service start` waits for it to exit, without joining it or asking it to stop, and then starts one",
    targets: {
      local: scheduled,
      cloud: na("Local CLI background service"),
      "self-host": na("Local CLI background service"),
    },
  },
  localServiceSuspendedLock: {
    fixtures: "cli",
    file: "local-service.spec.ts",
    title:
      "a suspended background server keeps its data directory however long ago it refreshed its lock: `executor --standalone` and a foreground `executor serve` on another port refuse it after a minute, `executor service status` says it is not responding, and once resumed it serves and refreshes its lock as before",
    targets: {
      local: scheduled,
      cloud: na("Local CLI background service"),
      "self-host": na("Local CLI background service"),
    },
  },
  localServiceCrashedLock: {
    fixtures: "cli",
    file: "local-service.spec.ts",
    title:
      "the next server takes over the lock a killed background server left at once, also when its process ID now names another running program, and when that program also listens on its port",
    targets: {
      local: scheduled,
      cloud: na("Local CLI background service"),
      "self-host": na("Local CLI background service"),
    },
  },
  localServiceReusedPid: {
    fixtures: "cli",
    file: "local-service.spec.ts",
    title:
      "`executor service stop` and `executor service start` never signal a program that now has a killed background server's process ID while its port accepts connections and never answers: they remove the registration and leave that program running",
    targets: {
      local: scheduled,
      cloud: na("Local CLI background service"),
      "self-host": na("Local CLI background service"),
    },
  },
  localServiceKeyStorageInvalid: {
    fixtures: "cli",
    file: "local-service.spec.ts",
    title:
      "an invalid EXECUTOR_KEY_STORAGE, in the environment or saved with `executor service set env`, makes `executor`, `executor service start`, `executor --standalone` and `executor serve` refuse before they create anything in the data directory",
    targets: {
      local: scheduled,
      cloud: na("Local CLI background service"),
      "self-host": na("Local CLI background service"),
    },
  },
  localServeStalledOutput: {
    file: "local-serve-shutdown.spec.ts",
    title: "serve stops promptly on SIGTERM while nothing reads its output",
    targets: {
      local: scheduled,
      cloud: na("Local process shutdown"),
      "self-host": na("Local process shutdown"),
    },
  },
  localServeClosedOutput: {
    file: "local-serve-shutdown.spec.ts",
    title:
      "the local server keeps serving after the reader of its stdout or stderr closes the pipe",
    targets: {
      local: scheduled,
      cloud: na("Local process output"),
      "self-host": na("Local process output"),
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
      "Cloud lists each build's browser files to keep and serves them immutable, and files no build kept or unhashed names still 404",
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
      cloud: sourceStorageCloud,
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
      local: na("Shared tool browser exercised through hosted account links."),
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
    managementApps: ["owner"],
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
      cloud: sourceStorageCloud,
      local: na("The shared source browser is exercised through hosted organization routes."),
    },
  },
  skillCodeHighlighting: {
    fixtures: "actors",
    file: "source-highlighting.spec.ts",
    title: "Skill reader and editor highlight fenced code like the source browser",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
      local: na("The shared skill reader is exercised through hosted organization routes."),
    },
  },
  skillEditor: {
    fixtures: "actors",
    file: "skill-editor.spec.ts",
    title: "Skill editor saves minimal edits, deploys them and keeps drafts on conflict",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
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
    managementApps: ["owner"],
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
    title:
      "Tool invocations resolve one committed set of linked accounts without holding a transaction",
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
    title:
      "Local tools identify their accounts and replace catalogs after the linked accounts change",
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
      cloud: sourceStorageCloud,
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
    title: "Array account deletion preserves authoring access and removes its app links",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
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
    managementApps: ["owner"],
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
  cloudJobOutcomes: {
    fixtures: "actors",
    file: "cloud-job-outcomes.spec.ts",
    title:
      "Cloud cron jobs record their outcome on their dispatch span, including a failure the job handled and still answered 204 for",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host runs its background jobs in its own server process."),
      local: na("Local runs its background jobs in its own server process."),
    },
  },
  cloudJobBatchOutcomes: {
    fixtures: "actors",
    file: "cloud-job-outcomes.spec.ts",
    title:
      "Cloud cron jobs record their outcome over a batch: partial when the mail provider refuses one welcome of two, failed when it refuses the only one",
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
  cloudScheduleConnectionsClose: {
    fixtures: "actors",
    file: "cloud-database-placement.spec.ts",
    title:
      "Cloud's schedule coordinator closes its database connections when a pass ends, so it can hibernate between wakes",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host runs schedules in its own server process."),
      local: na("Local runs schedules in its own server process."),
    },
  },
  cloudScheduleCapacity: {
    fixtures: "actors",
    file: "cloud-schedule-capacity.spec.ts",
    title:
      "Cloud's schedule coordinator keeps nine slow scheduled runs in flight at once and starts another due schedule while they run",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host runs schedules in its own server process, with its own pool."),
      local: na("Local runs schedules in its own server process, with its own pool."),
    },
  },
  cloudScheduleWakeStream: {
    fixtures: "actors",
    file: "cloud-schedule-wakes.spec.ts",
    title:
      "Cloud runs a due schedule and requested webhook source setup while coordinator wakes keep arriving less than a second apart",
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
      "Deploys wake webhook source setup, which reaches each new version, a schedule's change from interval to cron and an unchanged redeploy without a reconcile",
    targets: {
      cloud: managedCloud,
      "self-host": scheduled,
      local: na("Hosted app account links and version API scenario"),
    },
  },
  memberSetupWake: {
    fixtures: "actors",
    file: "deploy-setup.spec.ts",
    title: "Member setup wakes webhook source setup from its background provisioning job",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Cloud installs a new team in its request with an immediate wake, or in its provisioning workflow, whose next step requests the schedule-wake job.",
      ),
      local: na("Local has no hosted provisioning jobs."),
    },
  },
  cloudDashboardBatchResources: {
    fixtures: "actors",
    file: "cloud-dashboard-batch-resources.spec.ts",
    title: "Cloud dashboard batches share one SQL pool and executor within each request",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host builds its executor and SQL pool at startup."),
      local: na("The local dashboard does not batch its reads."),
    },
  },
  cloudMcpObjectConnections: {
    fixtures: "actors",
    file: "cloud-database-placement.spec.ts",
    title:
      "Cloud MCP session objects hold their database connections across calls and pauses and close them when idle",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host MCP sessions run in its server process with its own pool."),
      local: na("Local MCP sessions use the local database."),
    },
  },
  cloudMcpParallelCalls: {
    fixtures: "actors",
    file: "cloud-database-placement.spec.ts",
    title:
      "Cloud MCP session objects run parallel tool calls, each call's reads on one connection, beside resumed approvals, each with its own result",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host MCP sessions run in its server process with its own pool."),
      local: na("Local MCP sessions use the local database."),
    },
  },
  cloudMcpAbandonedStatement: {
    fixtures: "actors",
    file: "cloud-database-placement.spec.ts",
    title:
      "Cloud MCP session objects cancel a statement a caller gave up on while it waits on a lock, and the next call does not wait for it",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host MCP sessions run in its server process with its own pool."),
      local: na("Local MCP sessions use the local database."),
    },
  },
  cloudMcpDiscoveryListings: {
    fixtures: "actors",
    file: "cloud-database-placement.spec.ts",
    title:
      "Cloud MCP session objects discover the other apps of an execute while one app's listing waits on a lock",
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
  cloudMcpSessionRouting: {
    fixtures: "actors",
    file: "cloud-mcp-session-routing.spec.ts",
    title:
      "Cloud MCP routes a request inside a session by its signed session id and checks its bearer only in the session object",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host serves MCP sessions in its server process, with no gateway hop."),
      local: na("Local serves MCP sessions in its server process, with no gateway hop."),
    },
  },
  cloudMcpSessionRestore: {
    fixtures: "actors",
    file: "cloud-mcp-session-restore.spec.ts",
    title:
      "Cloud MCP sessions continue after their session object is evicted, restored from its storage only for a bearer that names the object, a program waiting for approval keeps its object, and a later resume says only what the object recorded",
    targets: {
      cloud: managedCloud,
      "self-host": na(
        "Self-host serves MCP sessions in its server process, with no session object.",
      ),
      local: na("Local serves MCP sessions in its server process, with no session object."),
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
    // The restarted report's first pass must find the organization's Executor app installed.
    managementApps: ["owner"],
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
  mcpUserAgent: {
    fixtures: "actors",
    file: "mcp-user-agent.spec.ts",
    title: "Remote MCP requests supply User-Agent and preserve an app's own",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a loopback upstream to exercise the shared Worker MCP transport."),
      local: na("Exercises the hosted app deploy and tool call APIs."),
    },
  },
  mcpAccountFailureIsolated: {
    fixtures: "actors",
    file: "mcp-account-failures.spec.ts",
    title: "One account whose MCP server fails discovery leaves the app's other accounts usable",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a loopback upstream to exercise the shared Worker MCP transport."),
      local: na("Exercises the hosted app deploy, tool call and MCP execute APIs."),
    },
  },
  mcpRefusedEventStream: {
    fixtures: "actors",
    file: "mcp-event-stream.spec.ts",
    title: "Remote MCP tools stay available when the server refuses the optional event stream",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a loopback upstream to exercise the shared Worker MCP transport."),
      local: na("Exercises the hosted app deploy and tool call APIs."),
    },
  },
  templateAccounts: {
    fixtures: "actors",
    file: "template-accounts.spec.ts",
    title: "Skill-authored templates route shared tools to explicitly selected accounts",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses loopback upstream fixtures for the shared protocol templates."),
      local: na("Exercises the hosted version and app account link APIs."),
    },
  },
  templateAccountsRecursiveOutput: {
    fixtures: "actors",
    file: "template-accounts.spec.ts",
    title: "Account-routed MCP results are checked against recursive output schemas",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a loopback MCP upstream fixture."),
      local: na("Exercises the hosted version and app account link APIs."),
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
      local: na("Exercises the hosted version and app account link APIs."),
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
  cloudSignInErrors: {
    file: "cloud-sign-in-errors.spec.ts",
    title: "Cloud sign-in explains a refused social sign-in by its error code",
    targets: {
      cloud: scheduled,
      "self-host": na("Self-host has its own sign-in page without social providers."),
      local: na("Local has no sign-in."),
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
  siteVisitorAttribution: {
    file: "site-visitor-attribution.spec.ts",
    title:
      "Cloud links the site's anonymous visitor to the account they sign up for, then clears it",
    targets: {
      // The server's events are read from the managed run's loopback collector.
      cloud: managedCloud,
      "self-host": na("Self-host does not serve the marketing site or export product analytics."),
      local: na("Local does not serve the marketing site or export product analytics."),
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
  productAnalyticsOnboarding: {
    file: "product-analytics.spec.ts",
    title:
      "Cloud product events record onboarding replay with masked team details and setup secrets, but not OAuth returns or consent",
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
    managementApps: ["owner"],
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
    managementApps: ["owner"],
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
  openapiBulkWritePartlyCommitted: {
    fixtures: "actors",
    file: "openapi-errors.spec.ts",
    title:
      "OpenAPI writes that partly commit before a declared error tell agents not to repeat them",
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
  catalogOfficialApps: {
    fixtures: "actors",
    file: "catalog-official-apps.spec.ts",
    title: "Add app lists official apps and installs one's own source as a copy",
    targets: {
      "self-host": scheduled,
      cloud: na("The shared catalog view and install rule are exercised through self-host."),
      local: na("The shared catalog form is exercised through hosted installation."),
    },
  },
  catalogAgentSearch: {
    fixtures: "actors",
    managementApps: ["owner"],
    file: "catalog-agent-search.spec.ts",
    title:
      "Agents search the official app catalog, and an install by URL or unlisted id is refused with the steps to take next",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "The catalog filters and install refusal are shared code, exercised through self-host.",
      ),
      local: na("Local's catalog routes do not take the hosted API's filters."),
    },
  },
  catalogCachedDocument: {
    fixtures: "actors",
    file: "catalog-agent-search.spec.ts",
    title:
      "An Executor app on apps beta.9 refuses catalog filters from its cached document until a pin-only redeploy",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "This scenario serves the published beta.9 archive on loopback; Cloud shares the framework and its cache.",
      ),
      local: na(
        "Local regenerates its own Executor app from the template at every start whose template changed.",
      ),
    },
  },
  cloudCatalogInstall: {
    fixtures: "actors",
    file: "cloud-compiler.spec.ts",
    title: "Cloud catalog installs Axiom through the browser and reaches account setup",
    targets: {
      cloud: officialFeedCloud,
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
    title: "Cloud compiler memory failures preserve the active version",
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
      "OAuth accepts compatible registration and token variants, sends no nonce, ignores ID tokens, and classifies registration failures",
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
      cloud: httpsCallbackCloud,
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthSavedClientRejection: {
    fixtures: "actors",
    file: "oauth-saved-client-rejection.spec.ts",
    title:
      "A rejected client Executor registered is discarded only in the version the sign-in used, and administrator-registered clients are kept",
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
      "OAuth classifies token and callback error responses, ignores ID tokens it cannot validate on sign-in, and renews when a refreshed ID token names another subject",
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
  appFetchBrotliUndecoded: {
    fixtures: "actors",
    file: "app-fetch-brotli.spec.ts",
    title:
      "an app's fetch receives a Brotli-encoded response as the bytes the service sent, never decoded by the runtime",
    targets: {
      "self-host": scheduled,
      // The scenario reaches a loopback fixture.
      cloud: managedCloud,
      local: na(
        "Hosted app routes; local runs apps with the same runner and the same compatibility flags.",
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
      "an account sends its secrets only to the hosts it was connected for, in every app that links it",
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
  credentialHostsRestart: {
    fixtures: "actors",
    file: "credential-hosts.spec.ts",
    title:
      "a credential handle app code keeps still opens after a restart with the same encryption key",
    targets: {
      "self-host": scheduled,
      cloud: na("Restarts a runner-owned product; Cloud keeps its handle secret across deploys."),
      local: na("Local derives the handle key the same way through the same workerd runner."),
    },
  },
  credentialPlacementMatched: {
    fixtures: "actors",
    file: "credential-placement.spec.ts",
    title: "placed credentials are substituted only where a request matches their template exactly",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a loopback service; Cloud app Workers reach only public addresses."),
      local: na("Local runs apps through the same workerd runner and outbound as self-host."),
    },
  },
  credentialPlacementDeclared: {
    fixtures: "actors",
    file: "credential-placement.spec.ts",
    title: "a provider's credential placements are checked when it is declared",
    targets: {
      "self-host": scheduled,
      cloud: na("Declarations are evaluated by the same framework on every host."),
      local: na("Declarations are evaluated by the same framework on every host."),
    },
  },
  credentialOutboundOwn: {
    fixtures: "actors",
    file: "credential-placement.spec.ts",
    title:
      "the outbound never sends a credential with TRACE, and its own errors never quote a substituted value",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a loopback service; Cloud app Workers reach only public addresses."),
      local: na("Local runs apps through the same workerd runner and outbound as self-host."),
    },
  },
  credentialManagedOffered: {
    fixtures: "actors",
    file: "credential-placement.spec.ts",
    title:
      "the operator's OAuth client is offered only to providers on its server whose scopes it allows",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Restarts a runner-owned product with the operator's client; managed Cloud has no per-case operator settings.",
      ),
      local: na("Local products have no operator OAuth clients."),
    },
  },
  credentialManagedUnlisted: {
    fixtures: "actors",
    file: "credential-placement.spec.ts",
    title:
      "an unlisted operator client shaped like Executor for Slack renews and reconnects its accounts with its own resource and Slack's nested grant, but signs in no new ones",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Restarts a runner-owned product with the operator's client; managed Cloud has no per-case operator settings.",
      ),
      local: na("Local products have no operator OAuth clients."),
    },
  },
  credentialManagedGoogle: {
    fixtures: "actors",
    file: "credential-placement.spec.ts",
    title:
      "Executor for Google is offered to providers on Google's endpoints whose scopes it allows, once its credentials are set",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Restarts a runner-owned product with the client's credentials; Cloud composes the same reviewed definitions.",
      ),
      local: na("Local products have no operator OAuth clients."),
    },
  },
  credentialManagedPlaced: {
    fixtures: "actors",
    file: "credential-placement.spec.ts",
    title:
      "a token from the operator's OAuth client goes only in the operator's header, to its hosts, and nowhere else in a request",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Restarts a runner-owned product with the operator's client; managed Cloud has no per-case operator settings.",
      ),
      local: na("Local products have no operator OAuth clients."),
    },
  },
  credentialManagedKept: {
    fixtures: "actors",
    file: "credential-placement.spec.ts",
    title:
      "app updates, a provider's own placements and older builds cannot widen where a token from the operator's OAuth client goes",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Restarts a runner-owned product with the operator's client; managed Cloud has no per-case operator settings.",
      ),
      local: na("Local products have no operator OAuth clients."),
    },
  },
  credentialManagedEndpoints: {
    fixtures: "actors",
    file: "credential-placement.spec.ts",
    title:
      "the operator's OAuth client signs in, renews and revokes only at the operator's endpoints",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Restarts a runner-owned product with the operator's client; managed Cloud has no per-case operator settings.",
      ),
      local: na("Local products have no operator OAuth clients."),
    },
  },
  credentialManagedHostPatterns: {
    fixtures: "actors",
    file: "credential-placement.spec.ts",
    title: "the operator's wildcard hosts admit exactly the provider hosts they match",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Restarts a runner-owned product with the operator's client; managed Cloud has no per-case operator settings.",
      ),
      local: na("Local products have no operator OAuth clients."),
    },
  },
  credentialManagedReconnect: {
    fixtures: "actors",
    file: "credential-placement.spec.ts",
    title:
      "a reconnect to the operator's client during a renewal is read as managed by calls, checks and retries already running",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Restarts a runner-owned product with the operator's client; managed Cloud has no per-case operator settings.",
      ),
      local: na("Local products have no operator OAuth clients."),
    },
  },
  credentialManagedScopes: {
    fixtures: "actors",
    file: "credential-placement.spec.ts",
    title:
      "the operator's OAuth client keeps no grant holding a scope outside its allowed scopes, read with the server's granted-scope separator",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Restarts a runner-owned product with the operator's client; managed Cloud has no per-case operator settings.",
      ),
      local: na("Local products have no operator OAuth clients."),
    },
  },
  credentialManagedSettingsInvalid: {
    fixtures: "actors",
    file: "credential-placement.spec.ts",
    title:
      "an operator OAuth client with only one of its credentials stops the product, naming the missing setting and never a value",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Cloud reads the same settings with the same code; a deploy fails on them before any request.",
      ),
      local: na("Local products have no operator OAuth clients."),
    },
  },
  credentialManagedCloud: {
    fixtures: "actors",
    file: "credential-placement.spec.ts",
    title:
      "Cloud's operator OAuth client signs in, and its outbound sends the token only in the operator's header",
    targets: {
      "self-host": na(
        "Self-host scenarios above restart the product with the operator's client; this one proves Cloud's own configuration path.",
      ),
      cloud: managedCloud,
      local: na("Local products have no operator OAuth clients."),
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
  appWorkerGarbageCollected: {
    fixtures: "actors",
    file: "app-worker-budget.spec.ts",
    title:
      "app Workers and data facets collect a call's garbage after it, though their heaps stay small",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloudflare collects Cloud's isolates itself."),
      local: na(
        "Self-host covers the shared runner's bridges; local starts its workerd with the same flags.",
      ),
    },
  },
  appDataFacetBudget: {
    fixtures: "actors",
    file: "app-worker-budget.spec.ts",
    title: "data facets count against the configured app Worker limit as apps with databases grow",
    serverEnvironment: { EXECUTOR_APP_WORKERS: String(appWorkerBudgetLimit) },
    targets: {
      "self-host": scheduled,
      cloud: na("Cloudflare unloads Cloud's facet Workers itself."),
      local: na(
        "Self-host covers the shared runner's Worker residency; the local budget scenario covers local's limit.",
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
  oauthRenewalEndedGrantCodes: {
    fixtures: "actors",
    file: "oauth-refresh-resilience.spec.ts",
    title:
      "OAuth renewal refused with a service's own code for a dead refresh token, at any HTTP status, asks to reconnect, stops renewing, and traces the code",
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
  oauthUnconfirmedReadRenewal: {
    fixtures: "actors",
    file: "oauth-refresh-resilience.spec.ts",
    title:
      "A refused query no kept listing confirms, unlisted or built on apps beta.95, renews the grant without repeating the call, and the next call uses the renewed token",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer and resource with controlled token expiry."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthRenewalFailedAfterWrite: {
    fixtures: "actors",
    file: "oauth-refresh-resilience.spec.ts",
    title:
      "A write whose token the service refuses and whose renewal then fails reports an unknown outcome, while a read keeps the renewal's retry advice",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer, resource and recording service."),
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  oauthUnnamedKindRenewal: {
    fixtures: "actors",
    file: "oauth-refresh-resilience.spec.ts",
    title:
      "A call without a kind whose app code wrote and then had its token refused is not evaluated again, whether renewal fails or succeeds, in the Worker and the data facet, while a query still renews and repeats",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer, resource and recording service."),
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
      "A schedule whose account is unlinked or must reconnect skips its occurrences without running, shows why, and resumes once resolved",
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
  oauthRenewalAppAccessEnds: {
    fixtures: "actors",
    file: "oauth-renewal-interruption.spec.ts",
    title:
      "a call refuses to run the app once its caller loses app access during a slow OAuth renewal",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer whose token response the scenario holds."),
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
  oauthBackgroundRenewalAfterBatch: {
    fixtures: "actors",
    file: "oauth-background-renewal.spec.ts",
    title:
      "A skill catalog refreshed in the background after a dashboard batch read saves the OAuth token its renewal rotated",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("Exercises the shared OAuth lifecycle through hosted APIs."),
    },
  },
  appBuildFailureDetails: {
    fixtures: "actors",
    managementApps: ["owner"],
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
    managementApps: ["owner"],
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
    managementApps: ["owner"],
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
    title:
      "OAuth account deletion revokes the refresh token, succeeds when revocation fails, and the delete dialog says beforehand whether it will",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer that records revocation requests."),
      local: na("Exercises the shared SDK account deletion through hosted APIs."),
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
      "OAuth failures deliver safe provider, challenge and callback diagnostics, and a successful discovery fallback records no error",
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
  mcpDetectionUserAgent: {
    fixtures: "actors",
    file: "mcp-detection-user-agent.spec.ts",
    title: "MCP quick add and OAuth discovery send a User-Agent to the server",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud egress refuses loopback MCP hosts, so no Cloud scenario imports one."),
      local: na("Exercises the shared importer and OAuth setup through hosted APIs."),
    },
  },
  appNameValidation: {
    fixtures: "actors",
    file: "app-name-validation.spec.ts",
    title: "App names with control or invisible-only characters are refused with a bad request",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud egress refuses loopback MCP hosts, so no Cloud scenario imports one."),
      local: na("Exercises the shared importer and app rename through hosted APIs."),
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
  privateHttpsMcp: {
    fixtures: "actors",
    file: "mcp-auth-detection.spec.ts",
    title: "Private HTTPS MCP import and OAuth require an exact origin opt-in",
    targets: {
      "self-host": scheduled,
      local: na("Exercises self-host operator settings through hosted import and account APIs."),
      cloud: na("Cloud does not permit operator-configured private network origins."),
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
    title: "a deploy changes an app's MCP tools without relinking its accounts",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted app account links and version API scenario"),
    },
  },
  appDeclarations: {
    fixtures: "actors",
    file: "app-declarations.spec.ts",
    title:
      "evaluated app declarations are reused only for identical inputs and never bypass access",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
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
      "local app declarations follow credentials and versions and refresh in the background while stale",
    targets: {
      local: scheduled,
      "self-host": na("Hosted declaration reuse is covered by appDeclarations."),
      cloud: na("Hosted declaration reuse is covered by appDeclarations."),
    },
  },
  workspaceSource: {
    fixtures: "actors",
    file: "workspace-source.spec.ts",
    title: "Workspace reads return confirmed source and preserve concurrent writes",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
      local: na("The shared source contract is exercised through hosted organization routes."),
    },
  },
  appPublicFiles: {
    fixtures: "actors",
    file: "app-public-files.spec.ts",
    title:
      "The apps CLI deploys a directory of binary ui/public files larger than the code budget; they are served byte for byte with their types, ranges and blob ETags, and clone, apps source and copies return them",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
      local: na("The shared source contract is exercised through hosted organization routes."),
    },
  },
  appPublicFilesRollback: {
    fixtures: "actors",
    file: "app-public-files.spec.ts",
    title:
      "Binary ui/public files saved through the API as base64 are served per version, an older version serves its own files, reads keep their blobs, and on Cloud a published commit installs with them",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
      local: na("The shared source contract is exercised through hosted organization routes."),
    },
  },
  workspaceSourceWrites: {
    fixtures: "actors",
    file: "workspace-source-writes.spec.ts",
    title: "Workspace reads return source saved by Git pushes and commits",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
      local: na("The shared source contract is exercised through hosted organization routes."),
    },
  },
  historicalSource: {
    fixtures: "actors",
    file: "historical-source.spec.ts",
    title: "Historical source deploys without downloading later revisions",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
      local: na("The shared source contract is exercised through hosted organization routes."),
    },
  },
  appCopies: {
    fixtures: "actors",
    file: "app-copies.spec.ts",
    title: "App copies use running source and remain independent through edits and navigation",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
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
  accountSecretFieldsExact: {
    fixtures: "actors",
    file: "account-secret-fields.spec.ts",
    title:
      "A multi-line secret with plus signs, percent escapes and non-ASCII text pasted into the credential form reaches the app's check exactly as pasted, before and after saving, and the accessibility tree holds none of it",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("The hosted and local dashboards share the credential form and check contract."),
    },
  },
  accountSecretFieldsSummary: {
    fixtures: "actors",
    file: "account-secret-fields.spec.ts",
    title:
      "A paste or drop that spans lines replaces a credential field's value exactly and shows a summary that undo, label clicks and dragging leave unchanged, and Clear returns to the password input",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "The summary is in the shared browser form; the exact-paste scenario covers Cloud's transport.",
      ),
      local: na("The hosted and local dashboards share the credential form and check contract."),
    },
  },
  webhookProviderSigningSecretExact: {
    fixtures: "actors",
    file: "account-secret-fields.spec.ts",
    title:
      "A provider signing secret that spans lines, pasted into a webhook's setup, reaches the webhook's handler exactly as pasted",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local's webhook setup uses the same shared setup form."),
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
  localAccountOwners: {
    file: "local-account-owners.spec.ts",
    title:
      "local saves apps and connected accounts under owners it assigns, lists one owner's accounts and providers, refuses a listing without an owner, and manages the account in the dashboard",
    targets: {
      local: scheduled,
      "self-host": na("Local assigns owners; hosted derives them from the organization."),
      cloud: na("Local assigns owners; hosted derives them from the organization."),
    },
  },
  localReservedOwners: {
    file: "local-account-owners.spec.ts",
    title:
      "local serves no owner removal, so neither its user's owner nor its Executor app's can be deleted",
    targets: {
      local: scheduled,
      "self-host": na(
        "Local's owners are fixed; hosted removes an organization's owner in process.",
      ),
      cloud: na("Local's owners are fixed; hosted removes an organization's owner in process."),
    },
  },
  localOwnerMigration: {
    legacyStorage: true,
    serverEnvironment: { EXECUTOR_DATA_STEPS: "report" },
    file: "local-owner-migration.spec.ts",
    title:
      "upgrading local moves apps, accounts and connections saved under other owners to local, where the dashboard lists them, their app opens and new connections stay local, and running the step again changes nothing",
    targets: {
      local: scheduled,
      "self-host": na("Only local assigned owners agents named; hosted owners are organizations."),
      cloud: na("Only local assigned owners agents named; hosted owners are organizations."),
    },
  },
  localOwnerMigrationCollision: {
    legacyStorage: true,
    serverEnvironment: { EXECUTOR_DATA_STEPS: "report" },
    file: "local-owner-migration.spec.ts",
    title:
      "upgrading local moves nothing while another owner's app shares a local app's name, names both in the log and on the dashboard, and moves everything once one is renamed",
    targets: {
      local: scheduled,
      "self-host": na("Only local assigned owners agents named; hosted owners are organizations."),
      cloud: na("Only local assigned owners agents named; hosted owners are organizations."),
    },
  },
  localOwnerMigrationOAuth: {
    legacyStorage: true,
    serverEnvironment: { EXECUTOR_DATA_STEPS: "report" },
    file: "local-owner-migration.spec.ts",
    title:
      "upgrading local moves an OAuth client, an account signed in with it, a pending sign-in and a pending approval saved under another owner, after which the sign-in completes, the approval runs, the account renews and local holds the client's credentials, and running the step again changes nothing",
    targets: {
      local: scheduled,
      "self-host": na("Only local assigned owners agents named; hosted owners are organizations."),
      cloud: na("Only local assigned owners agents named; hosted owners are organizations."),
    },
  },
  localOwnerMigrationBlocked: {
    legacyStorage: true,
    serverEnvironment: { EXECUTOR_DATA_STEPS: "report" },
    file: "local-owner-migration.spec.ts",
    title:
      "upgrading local moves nothing while a record it has to read does not decrypt, names it in the log and on the dashboard, never completes the step, and moves everything once the record is removed",
    targets: {
      local: scheduled,
      "self-host": na("Only local assigned owners agents named; hosted owners are organizations."),
      cloud: na("Only local assigned owners agents named; hosted owners are organizations."),
    },
  },
  localOwnerMigrationMalformed: {
    legacyStorage: true,
    serverEnvironment: { EXECUTOR_DATA_STEPS: "report" },
    file: "local-owner-migration.spec.ts",
    title:
      "upgrading local moves nothing while a registered client, a pending sign-in, a pending approval or a connection decrypts but would not be read back, names each with what to do in the log and on the dashboard, and changes no product row",
    targets: {
      local: scheduled,
      "self-host": na("Only local assigned owners agents named; hosted owners are organizations."),
      cloud: na("Only local assigned owners agents named; hosted owners are organizations."),
    },
  },
  localAccountDescriptions: {
    file: "local-account-descriptions.spec.ts",
    title:
      "An account description set through the account API is returned with the account, shown to agents once with the app's linked accounts, kept on rename and removed with null",
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
    title:
      "local app launch opens an authored app straight away with its linked account, explains blocked or missing accounts and opens no-provider apps directly",
    targets: {
      local: scheduled,
      "self-host": na("Hosted app launch is checked by its own scenarios."),
      cloud: na("Hosted app launch is checked by its own scenarios."),
    },
  },
  localResources: {
    file: "local-resources.spec.ts",
    title:
      "local tools and workflows use the linked account without a choice, runs keep the account a replaced link started them with, and no-provider apps need no account",
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
      "workflow starts follow the caller's linked account, which a new link replaces, while unlinked history stays",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local resource controls have a separate paired-browser scenario."),
    },
  },
  groupedWebhookSources: {
    fixtures: "actors",
    file: "grouped-resources.spec.ts",
    title:
      "webhook sources follow the caller's linked account, each configured on its own, which a new link replaces and unlinking stops",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local resource controls have a separate paired-browser scenario."),
    },
  },
  groupedAccounts: {
    fixtures: "actors",
    file: "grouped-accounts.spec.ts",
    title:
      "the linked account loads the full catalog and runs tool calls, and replacing it switches both",
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
      "App accounts open from old setup links, link, replace and unlink in place, keep failed changes and offer to delete unused accounts",
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
  localConnectionScopeChanged: {
    file: "connection-link-target-changed.spec.ts",
    title:
      "a local connection started for a user requirement that is redeployed as an app requirement is refused on submit and on OAuth return, saving no account and no link",
    targets: {
      local: scheduled,
      "self-host": na("Local connection links; hosted checks the scope in its own access rows."),
      cloud: na("Local connection links; hosted checks the scope in its own access rows."),
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
      "OAuth signs in to Microsoft Entra without a resource indicator or nonce and ignores each tenant's ID token issuer",
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
      "OAuth renews a Microsoft Entra multi-tenant grant even when a refreshed ID token names another tenant",
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
  oauthResourceRefused: {
    fixtures: "actors",
    file: "oauth-resource-indicator.spec.ts",
    title:
      "OAuth setup reports the resource indicator it will send, and a refused one fails sign-in naming that value and its source",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Exercises shared OAuth discovery and exchange through the hosted API."),
    },
  },
  oauthResourceAudience: {
    fixtures: "actors",
    file: "oauth-resource-indicator.spec.ts",
    title:
      "A token issued for the metadata's resource and refused by the API is renewed with the same resource, and a declared resource fixes it",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Exercises shared OAuth discovery, exchange and renewal through the hosted API."),
    },
  },
  oauthResourceOmitted: {
    fixtures: "actors",
    file: "oauth-resource-indicator.spec.ts",
    title:
      "OAuth setup and a refused sign-in say why no resource indicator was sent, and the app's settings can change it",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses scoped loopback OAuth issuers."),
      local: na("Exercises shared OAuth discovery and exchange through the hosted API."),
    },
  },
  oauthResourceOperator: {
    fixtures: "actors",
    file: "oauth-resource-indicator.spec.ts",
    title:
      "A refused resource indicator from the operator's OAuth client, or its absence, sends recovery to the instance administrator",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Restarts a runner-owned product with the operator's client; managed Cloud has no per-case operator settings.",
      ),
      local: na("Local products have no operator OAuth clients."),
    },
  },
  oauthResourceTransient: {
    fixtures: "actors",
    file: "oauth-resource-indicator.spec.ts",
    title:
      "A rate-limited or unavailable token endpoint that answers invalid_target keeps its own failure and Retry-After",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Exercises shared OAuth exchange through the hosted API."),
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
    title:
      "OAuth metadata overrides validate the issuer, ID tokens never block sign-in, and MCP challenges select scopes",
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
  localApprovalResumeKind: {
    file: "local-approval-resume-kind.spec.ts",
    title:
      "An approved call whose token the service refuses is renewed and repeated only when the caller named it a query, not when it named no kind",
    targets: {
      "self-host": na("Hosted products cannot resume an approval over REST."),
      cloud: na("Hosted products cannot resume an approval over REST."),
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
      "Declared OAuth endpoints accept the service's callback issuer, ignore ID tokens, refresh, and, like discovered servers open to public and secret clients, leave client authentication to the client",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Hosted account dialogs and saved-client management."),
    },
  },
  oauthUserAgent: {
    fixtures: "actors",
    file: "oauth-user-agent.spec.ts",
    title:
      "OAuth discovery names Executor and sign-in completes against an authorization server that refuses requests without a User-Agent",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Exercises shared OAuth through the hosted API."),
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
      EXECUTOR_OAUTH_CALLBACK_URL: oauthDocumentOriginCallback,
    },
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Managed Cloud runs on loopback without a public HTTPS origin; deployed stages serve the document.",
      ),
      local: na("Local's loopback callback has no public document; it registers dynamically."),
    },
  },
  oauthClientMetadataDocumentOrigin: {
    fixtures: "actors",
    file: "oauth-client-metadata.spec.ts",
    title:
      "a host whose callback is on another origin than its client metadata document signs in where the server accepts redirect URIs only on the document's origin",
    // Cloud's layout: the deployment serves the document while sign-ins return through the edge.
    serverEnvironment: {
      EXECUTOR_OAUTH_CLIENT_METADATA_URL: "https://executor.example/oauth/client-metadata.json",
      EXECUTOR_OAUTH_CALLBACK_URL: oauthRelayCallback,
    },
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Managed Cloud runs on loopback without a public HTTPS origin; the same setting derives a deployed stage's document.",
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
  oauthClientRegistration: {
    fixtures: "actors",
    file: "oauth-clients.spec.ts",
    title:
      "Administrators register unnamed OAuth clients, usable by everyone by default, that members connect personal accounts with, and removal keeps connected accounts but withdraws the client's details from reconnects",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Hosted organization roles and client audiences."),
    },
  },
  oauthClientMissing: {
    fixtures: "actors",
    file: "oauth-clients.spec.ts",
    title:
      "Without an OAuth client for a service, administrators enter one in the connect form, which registers it before sign-in, keeps it when sign-in fails and edits it for the retry, and members enter their own details for one account",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Hosted organization roles and client audiences."),
    },
  },
  oauthClientAudience: {
    fixtures: "actors",
    file: "oauth-clients.spec.ts",
    title:
      "Members are offered and may use only OAuth clients in the audience chosen at registration or later, and are never told a client is ready that they cannot use",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Hosted organization roles and client audiences."),
    },
  },
  oauthClientEdit: {
    fixtures: "actors",
    file: "oauth-clients.spec.ts",
    title:
      "Administrators edit a registered OAuth client's details and audience in one save, new connections use them, secrets are never returned, and automatic clients are not edited",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Hosted organization roles and client audiences."),
    },
  },
  oauthClientAudienceRecheck: {
    fixtures: "actors",
    file: "oauth-clients.spec.ts",
    title:
      "Narrowing an OAuth client's audience refuses a reconnect that would keep it and a sign-in pending with it, before any code is exchanged",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Hosted organization roles and client audiences."),
    },
  },
  oauthClientRemovedPending: {
    fixtures: "actors",
    file: "oauth-clients.spec.ts",
    title:
      "Removing an automatic OAuth client refuses a sign-in pending with it before any code is exchanged, and the next sign-in registers a new client",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Hosted organization roles and client removal."),
    },
  },
  oauthClientEditRevision: {
    fixtures: "actors",
    file: "oauth-clients.spec.ts",
    title:
      "An OAuth client edit made from a stale access revision is refused and changes nothing, in the API and the client manager, and every saved change advances the revision",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Hosted organization roles and client audiences."),
    },
  },
  oauthClientCredentialIdentity: {
    fixtures: "actors",
    file: "oauth-clients.spec.ts",
    title:
      "An OAuth client's details are that client after an edit, so a reconnect or entry with its old details stays under its audience, the same details are never registered twice, and clients sharing a client ID are told apart",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Hosted organization roles and client audiences."),
    },
  },
  oauthClientCredentialsIsolation: {
    fixtures: "actors",
    file: "oauth-clients.spec.ts",
    title:
      "A new client credentials connection asks for its own credentials and machine clients are never shared",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback token service."),
      local: na("Hosted organization connections."),
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
      cloud: sourceStorageCloud,
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
  appDetailLoading: {
    fixtures: "actors",
    file: "app-detail-loading.spec.ts",
    title: "Desktop app detail navigation preserves its frame while metadata and tools load",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
      local: na("This journey checks hosted app metadata requests."),
    },
  },
  appDetailLoadingMobile: {
    fixtures: "actors",
    file: "app-detail-loading.spec.ts",
    title: "Mobile app detail navigation preserves its frame while metadata and tools load",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
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
  selfHostSsoUnverifiedEmail: {
    file: "self-host-sso.spec.ts",
    title: "Self-host SSO refuses an email the provider does not verify and says why",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud customer SSO has its own OIDC scenario."),
      local: na("Local has no sign-in or SSO."),
    },
  },
  selfHostSsoExistingAccountOrDomain: {
    file: "self-host-sso.spec.ts",
    title: "Self-host SSO explains a password account it does not link and an unapproved domain",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud customer SSO has its own OIDC scenario."),
      local: na("Local has no sign-in or SSO."),
    },
  },
  selfHostSsoConnectPasswordAccount: {
    file: "self-host-sso.spec.ts",
    title: "Self-host SSO connects to a signed-in password account only for the same email",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud customer SSO has its own OIDC scenario."),
      local: na("Local has no sign-in or SSO."),
    },
  },
  selfHostSsoUserinfoClaims: {
    file: "self-host-sso.spec.ts",
    title:
      "Self-host SSO admits a member whose provider asserts email_verified only at UserInfo, and not when UserInfo names another subject",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud customer SSO uses its own provider registration."),
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
    managementApps: ["owner"],
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
    managementApps: ["owner"],
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
    managementApps: ["owner"],
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
  scheduleRunTelemetry: {
    fixtures: "actors",
    file: "schedule-run-telemetry.spec.ts",
    title:
      "scheduled runs record whether the app's code or Executor's runtime failed them, and Cloud's dispatch records the due schedules it found",
    targets: {
      cloud: managedCloud,
      "self-host": scheduled,
      local: na("Hosted app routes; local shares the scheduler and runtime paths."),
    },
  },
  hostApiRevision: {
    fixtures: "actors",
    file: "host-api-revision.spec.ts",
    title:
      "The Executor app keeps no tools from an API document of another revision, in its Worker or its database facet",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Only the self-host test entry point serves another API revision; a Cloud test stage deployed twice checks the rollout itself.",
      ),
      local: na("Local serves no host API to its apps."),
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
    managementApps: ["owner"],
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
    managementApps: ["owner"],
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
    managementApps: ["owner"],
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
    managementApps: ["owner"],
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
  versionApiCompatibility: {
    fixtures: "actors",
    file: "version-api-compatibility.spec.ts",
    title:
      "hosted API callers using the former deployment paths and field names keep listing, reading and activating versions",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
      local: na("Local's /v1 API is covered by localVersionApiCompatibility."),
    },
  },
  localVersionApiCompatibility: {
    file: "local-version-api-compatibility.spec.ts",
    title:
      "local API callers using the former deployment paths and field names keep listing, reading and activating versions",
    targets: {
      local: scheduled,
      "self-host": na("The hosted API is covered by versionApiCompatibility."),
      cloud: na("The hosted API is covered by versionApiCompatibility."),
    },
  },
  appReload: {
    fixtures: "actors",
    file: "app-reload.spec.ts",
    appOrigin: true,
    title: "hosted apps reload on a new version and recover missed version notifications",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
      local: na("Local already has a version watcher; this covers hosted app sessions."),
    },
  },
  appTailwind: {
    fixtures: "actors",
    file: "app-tailwind.spec.ts",
    appOrigin: true,
    title: "React app versions compile Tailwind utilities and preserve ordinary styles",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
      local: na(
        "This scenario uses hosted deploys and app authentication; local shares the workerd compiler.",
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
      local: na("This scenario uses hosted deploys and app authentication."),
    },
  },
  durableEvaluatedResults: {
    fixtures: "actors",
    file: "durable-evaluated-results.spec.ts",
    title:
      "Cloud serves a tool listing its isolate cannot keep from the app's supervisor until an app cache invalidation",
    targets: {
      cloud: managedCloud,
      "self-host": na(
        "Self-host's process store keeps a listing this large; the kept listings scenario reads its supervisor copy after a restart.",
      ),
      local: na(
        "Local's process store keeps a listing this large; the local kept listings scenario reads its supervisor copy after a restart.",
      ),
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
    managementApps: ["owner"],
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
      "self-host": na(
        "Self-host serves these reads from its process store, which keeps them whole.",
      ),
      local: na("Local serves these reads from its process store, which keeps them whole."),
    },
  },
  durableEvaluatedSharedDefinitions: {
    fixtures: "actors",
    file: "durable-evaluated-results.spec.ts",
    title:
      "Cloud keeps each JSON Schema definition a tool listing repeats once, in the isolate and in the app's supervisor",
    targets: {
      cloud: managedCloud,
      "self-host": na(
        "Self-host serves these reads from its process store, which keeps them whole.",
      ),
      local: na("Local serves these reads from its process store, which keeps them whole."),
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
  largeOpenapiApp: {
    fixtures: "actors",
    file: "large-openapi-app.spec.ts",
    title:
      "an OpenAPI app with an 11 MB document builds within the compiler's memory and calls its API",
    targets: {
      "self-host": scheduled,
      // Only a deployed compiler Worker has Cloudflare's memory limit.
      cloud: { status: "scheduled", runtime: "attached" },
      local: na("Local builds and runs apps through the same workerd compiler as self-host."),
    },
  },
  largeOpenapiAsciiApp: {
    fixtures: "actors",
    file: "large-openapi-app.spec.ts",
    title:
      "an OpenAPI app with a 13.6 MB document whose prose goes beyond Latin-1, written as ASCII JSON as imported apps write it, builds and calls its API",
    targets: {
      "self-host": scheduled,
      // Only deployed Workers have Cloudflare's memory limit.
      cloud: { status: "scheduled", runtime: "attached" },
      local: na("Local builds and runs apps through the same workerd compiler as self-host."),
    },
  },
  largeOpenapiWideSourceApp: {
    fixtures: "actors",
    file: "large-openapi-app.spec.ts",
    title:
      "an OpenAPI app with a 13.6 MB ASCII document beside source files whose text goes beyond Latin-1, such as a provider's display name, builds, reads back its files exactly and calls its API",
    targets: {
      "self-host": scheduled,
      // Only deployed Workers have Cloudflare's memory limit.
      cloud: { status: "scheduled", runtime: "attached" },
      local: na("Local builds and runs apps through the same workerd compiler as self-host."),
    },
  },
  largeOpenapiExpandableApp: {
    fixtures: "actors",
    file: "large-openapi-app.spec.ts",
    title:
      "an OpenAPI app whose resources expand into one another lists its tools in bounded pages, each tool's schema complete, and MCP search ranks them",
    targets: {
      "self-host": scheduled,
      // The attached run checks that a deployed Worker holds the catalog within Cloudflare's
      // memory limit, as it must Stripe's.
      cloud: { status: "scheduled", runtime: "attached" },
      local: na("Local builds and runs apps through the same workerd compiler as self-host."),
    },
  },
  localExpandableOpenapiTools: {
    file: "local-openapi-tools.spec.ts",
    title:
      "the local Tools tab lists an OpenAPI app whose resources expand into one another and shows a selected tool's schemas",
    targets: {
      local: scheduled,
      "self-host": na(
        "Hosted tools pages read the schema-free index; largeOpenapiExpandableApp lists it.",
      ),
      cloud: na(
        "Hosted tools pages read the schema-free index; largeOpenapiExpandableApp lists it.",
      ),
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
    title: "warm app queries export timing",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted deploys and app authentication."),
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
      local: na("This scenario uses hosted deploys and app authentication."),
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
      local: na("This scenario uses hosted deploys and app authentication."),
    },
  },
  appUiOlderRelease: {
    fixtures: "actors",
    file: "app-ui-older-release.spec.ts",
    appOrigin: true,
    title: "an app page built with an apps release from before versions were named loads its data",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted deploys and app authentication."),
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
      local: na("This scenario uses hosted deploys and app authentication."),
    },
  },
  oauthTokenTelemetry: {
    fixtures: "actors",
    file: "oauth-token-telemetry.spec.ts",
    title:
      "Cloud OAuth token requests record their grant type, OAuth error, refresh-family revocation and client family, and registrations their refusal rule, without reporting them",
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
    title: "Concurrent users read their own sessions",
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
      local: na(
        "This scenario uses hosted APIs; Local records rejections through the same telemetry code.",
      ),
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
  mcpOrganizationSpans: {
    fixtures: "actors",
    file: "mcp-organization-spans.spec.ts",
    title:
      "Hosted MCP operation and bearer-check spans name only the caller's own organization and the caller by opaque ID, refused and failed ones included",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("Local has no organizations, so its MCP spans name none."),
    },
  },
  organizationRequestSpans: {
    fixtures: "actors",
    file: "organization-request-spans.spec.ts",
    title:
      "Hosted management API request spans name only an organization the caller belongs to, and the caller, never one a refused request asks for",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("Local has no organizations, so its request spans name none."),
    },
  },
  cloudMcpForwardOrganization: {
    fixtures: "actors",
    file: "mcp-organization-spans.spec.ts",
    title:
      "Cloud's gateway names an authenticated MCP request's organization and user on its forward even when the session object never answers",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host serves MCP sessions in its server process, with no gateway hop."),
      local: na("Local serves MCP sessions in its server process, with no gateway hop."),
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
  toolCallOverheadOneCacheTrip: {
    fixtures: "actors",
    file: "tool-call-overhead.spec.ts",
    title: "A warm call of a cached MCP tool reads its catalog and the tool in one cache command",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("This scenario uses hosted MCP; the runtime and collector are shared with Local."),
    },
  },
  toolCallOverheadWakeStart: {
    fixtures: "actors",
    file: "tool-call-overhead.spec.ts",
    title: "A supervisor start made by a cold call's wake is reported by that call alone",
    targets: {
      "self-host": na(
        "Self-host's supervisors run in the runner's own process, so its runner sends no wake.",
      ),
      cloud: managedCloud,
      local: na(
        "Local's supervisors run in the runner's own process, so its runner sends no wake.",
      ),
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
  toolCallOverheadBackground: {
    fixtures: "actors",
    file: "tool-call-overhead.spec.ts",
    title: "Executor time excludes a stale cache entry's refresh running beside an upstream wait",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("This scenario uses hosted MCP; the runtime and collector are shared with Local."),
    },
  },
  toolCallOverheadLease: {
    fixtures: "actors",
    file: "tool-call-overhead.spec.ts",
    title: "Executor time excludes waiting on another call's load of the same cache entry",
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
  toolCallOverheadDatabaseFacets: {
    fixtures: "actors",
    file: "tool-call-overhead.spec.ts",
    title:
      "Executor time counts a fresh facet for each database call that finds it idle, and overlapping calls share one",
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
      local: na("This scenario uses hosted app deploys and browser authentication."),
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
      local: na("This scenario uses hosted app deploys and browser authentication."),
    },
  },
  executorKeyAccount: {
    fixtures: "actors",
    file: "executor-key-account.spec.ts",
    title:
      "Executor installs each user’s managed key and links it for that user, leaving the shared app as it is",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local uses its configured instance API key."),
    },
  },
  executorCustomization: {
    fixtures: "actors",
    managementApps: ["owner"],
    file: "executor-customization.spec.ts",
    title: "Executor customization preserves personal accounts through the browser and MCP",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
      local: na("Local uses its configured instance API key."),
    },
  },
  executorOrganizationDefault: {
    fixtures: "actors",
    managementApps: ["owner"],
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
    title: "A new Cloud team's Executor app is installed with nothing left pending",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host installs teams from its own provisioning worker."),
      local: na("Local uses its configured instance and has no teams."),
    },
  },
  teamInstallationConcurrent: {
    fixtures: "actors",
    file: "team-installation.spec.ts",
    title:
      "Request and workflow attempts at one team leave one Executor app and one linked key each",
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
    title: "Executor app card shows the current user's linked account",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local uses its configured instance API key."),
    },
  },
  executorKeyUnlinkSticks: {
    fixtures: "actors",
    file: "executor-key-account.spec.ts",
    managementApps: ["admin"],
    title: "A member's unlinked managed Executor key stays unlinked through reads and redeploys",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
      local: na("Local uses its configured instance API key."),
    },
  },
  executorAppSetupLeavesVersion: {
    fixtures: "actors",
    legacyStorage: true,
    file: "executor-key-account.spec.ts",
    managementApps: ["owner", "admin"],
    title:
      "A member joining links their Executor key without redeploying the organization's Executor app",
    targets: {
      "self-host": scheduled,
      cloud: na("Recording Executor's installed version writes the runner-owned product database."),
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
    title: "API grants retain exact selections through deploys, refresh and live narrowing",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted OAuth grant scenario"),
    },
  },
  liveGrantRestrictions: {
    fixtures: "actors",
    file: "mcp-grant-restrictions.spec.ts",
    title: "MCP grants retain exact selections through deploys and live narrowing",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
      local: na("This scenario checks hosted API and MCP parity."),
    },
  },
  grantEntryAccounts: {
    fixtures: "actors",
    file: "mcp-grant-restrictions.spec.ts",
    title: "MCP grants check each tool and its accounts against the same entry",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local grants come from scoped connections, which list each app once."),
    },
  },
  grantEntryManyAccounts: {
    fixtures: "actors",
    file: "mcp-grant-restrictions.spec.ts",
    title:
      "MCP discovery lists a grant entry's tools only while the entry permits every linked account a call uses",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local grants come from scoped connections, which list each app once."),
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
  scopedConnectionAccounts: {
    fixtures: "actors",
    file: "mcp-connections.spec.ts",
    title: "Scoped connections run apps only as the selected accounts and link bare accounts",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted app account links and account sharing."),
    },
  },
  scopedConnectionLinkSwappedMidExecution: {
    fixtures: "actors",
    file: "mcp-connections.spec.ts",
    title:
      "a scoped connection refuses a call that runs with an account linked in place of the granted one during an execution, as the grant not allowing that account",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local covers the same case with its own MCP connection routes."),
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
  localScopedSearch: {
    file: "local-mcp-connections.spec.ts",
    title:
      "Local scoped connections search only the tools they name, and pages count no hidden tool",
    targets: {
      local: scheduled,
      "self-host": na(
        "Hosted grants narrow search the same way; scopedConnectionAccess searches under a read-only rule.",
      ),
      cloud: na(
        "Hosted grants narrow search the same way; scopedConnectionAccess searches under a read-only rule.",
      ),
    },
  },
  localScopedLazyReach: {
    file: "local-mcp-connections.spec.ts",
    title:
      "Local scoped connections reach no hidden tool through CodeMode's search() or dynamic access to tools",
    targets: {
      local: scheduled,
      "self-host": na(
        "Hosted grants narrow listings and search the same way; the lazy paths are shared.",
      ),
      cloud: na(
        "Hosted grants narrow listings and search the same way; the lazy paths are shared.",
      ),
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
    title:
      "An MCP tool call checks its access and links in one statement and its caller in one more",
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
      "a tool call whose read-only check waits on the app runs the links and credentials saved meanwhile",
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
      "a tool call runs the links and the key or OAuth account saved while its access check waits",
    targets: {
      "self-host": scheduled,
      cloud: na("The statement hold is mounted by the self-host test entry point."),
      local: na("Local has no hosted organization policies."),
    },
  },
  toolCallHeldKindSwap: {
    fixtures: "actors",
    file: "tool-call-held-check.spec.ts",
    title:
      "a read-only grant refuses a call whose linked account is replaced, while its check waits, by one with which the tool is a mutation, and the mutation does not run",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Holds the app's listing on a loopback resource; Cloud app Workers fetch through one fixed service binding.",
      ),
      local: na("Local has no hosted organization policies."),
    },
  },
  protocol12UserAccounts: {
    fixtures: "actors",
    file: "app-accounts-upgrade.spec.ts",
    title:
      "a protocol-12 app's accounts are user requirements: each member's call runs with their linked account and a manager cannot link an account to it for everyone",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Hosts read protocol-12 requirements in the shared SDK; Cloud's older-protocol builds share the same adapters.",
      ),
      local: na("Hosted members and managers; Local has its own scenario."),
    },
  },
  localProtocol12UserAccounts: {
    file: "app-accounts-upgrade.spec.ts",
    title:
      "a local protocol-12 app's accounts are user requirements: the call runs with the linked account and linking it as an app link is refused",
    targets: {
      local: scheduled,
      "self-host": na("Hosted members and managers have their own scenario."),
      cloud: na("Hosted members and managers have their own scenario."),
    },
  },
  appAccountsStorageUpgrade: {
    fixtures: "actors",
    legacyStorage: true,
    file: "app-accounts-upgrade.spec.ts",
    title:
      "upgrading hosted storage from before app accounts keeps members' links, schedule copies and runs as they were, links nothing for the app, and links an app account afterwards",
    targets: {
      "self-host": scheduled,
      local: na("Local keeps links in its own table; it has its own scenario."),
      cloud: na(
        "Legacy rows need a runner-owned database; Cloud cases share one Worker and database.",
      ),
    },
  },
  localAppAccountsStorageUpgrade: {
    legacyStorage: true,
    file: "app-accounts-upgrade.spec.ts",
    title:
      "upgrading local storage from before app accounts keeps the app's links, schedule and runs as they were, links nothing for the app, and links an app account afterwards",
    targets: {
      local: scheduled,
      "self-host": na("Hosted keeps links in its own table; it has its own scenario."),
      cloud: na(
        "Legacy rows need a runner-owned database; Cloud cases share one Worker and database.",
      ),
    },
  },
  scopedConnectionAppAccount: {
    fixtures: "actors",
    file: "mcp-connections.spec.ts",
    title:
      "a scoped connection that runs an app without user accounts calls a tool with the account its managers linked for everyone, and neither connections nor grants list that account",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na(
        "Hosted app managers link app accounts through organization routes; local covers its own MCP app link scenario.",
      ),
    },
  },
  toolCallHeldEntrySwap: {
    fixtures: "actors",
    file: "tool-call-held-check.spec.ts",
    title:
      "a grant whose entries permit a tool with one account and another tool with a second refuses the call when the link is replaced by the second while its check waits",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Holds the app's listing on a loopback resource; Cloud app Workers fetch through one fixed service binding.",
      ),
      local: na("Local has no hosted organization policies."),
    },
  },
  cloudMcpObjectPool: {
    fixtures: "actors",
    file: "cloud-database-placement.spec.ts",
    title:
      "Cloud MCP session objects' database pool runs a callback once, holds one connection, and settles abandoned statements off the caller's path",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host uses PGlite, not this PostgreSQL pool."),
      local: na("Local uses PGlite, not this PostgreSQL pool."),
    },
  },
  toolCallBatch: {
    fixtures: "actors",
    file: "tool-call-batch.spec.ts",
    title:
      "an MCP tool call sends its checks and reads in one batch, reads changed links in one more, and waits for a grant renewed meanwhile",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Reads SQL spans from the self-host Motel collector; cloud-tool-call-batch.spec.ts covers Cloud's batch.",
      ),
      local: na("Local has no hosted organization policies."),
    },
  },
  cloudMcpCallBatch: {
    fixtures: "actors",
    file: "cloud-tool-call-batch.spec.ts",
    title:
      "Cloud MCP tool calls send their checks and reads in one socket write and one snapshot, alone and in parallel, and read again in order when a batch fails",
    targets: {
      cloud: managedCloud,
      "self-host": na(
        "Self-host runs a batch under PGlite's lock, which no table lock can stop partway; tool-call-batch.spec.ts covers its batches.",
      ),
      local: na("Local MCP sessions use the local database."),
    },
  },
  toolCallReadAhead: {
    fixtures: "actors",
    file: "tool-call-read-ahead.spec.ts",
    title:
      "an MCP tool call sends its independent reads together and uses none of them before its checks pass",
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
    managementApps: ["owner"],
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local issues signed bearer links, not hosted connections."),
    },
  },
  appManagementContractsHosted: {
    fixtures: "actors",
    file: "app-management-contracts.spec.ts",
    title:
      "hosted agents read the apps release, are refused create without files, deploy the documented two-file app, get commit and deploy results as objects, and learn the tool-only app has no UI",
    managementApps: ["owner"],
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
      local: na("Local runs the same agent programs in its own scenario."),
    },
  },
  appManagementSavesHosted: {
    fixtures: "actors",
    file: "app-management-contracts.spec.ts",
    title:
      "hosted agents see the files a save removed and restore them, are refused a file inside a file or a path that is not Unicode, and get bounded lists of many removed files",
    managementApps: ["owner"],
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
      local: na("Local runs the same agent programs in its own scenario."),
    },
  },
  appManagementContractsLocal: {
    file: "app-management-contracts.spec.ts",
    title:
      "local agents read the apps release, are refused create without files, deploy the documented two-file app, get commit and deploy results as objects, see the files a commit removed, and are refused a file inside a file",
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
      cloud: sourceStorageCloud,
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
  // The held call waits on a loopback gate. Deployed app Workers refuse loopback destinations, so
  // the call never reaches it there; the local Worker shares the runner's network.
  mcpResumeReasons: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title:
      "Hosted MCP resume reports an approved call's own failure and why a request cannot be answered",
    targets: {
      "self-host": scheduled,
      cloud: managedCloud,
      local: na("Hosted self-host covers the shared execution manager and SDK resume."),
    },
  },
  mcpResumeContextUnconfirmed: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title:
      "Hosted MCP resume reports a storage failure while checking an approved call's context as unconfirmed, not changed",
    targets: {
      "self-host": scheduled,
      cloud: na("The storage fault is mounted by the self-host test entry point."),
      local: na("Hosted self-host covers the shared SDK resume and execution manager."),
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
  mcpFailureReference: {
    fixtures: "actors",
    file: "mcp-failure-reference.spec.ts",
    title:
      "MCP failures name their cause, the phase they stopped and the request's trace on search, call and execute",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "The failing MCP server is a loopback listener; the shared MCP diagnostics are covered on self-host.",
      ),
      local: na("Hosted self-host covers the shared MCP diagnostics."),
    },
  },
  mcpFailureReferenceMatchedLimit: {
    fixtures: "actors",
    file: "mcp-failure-reference.spec.ts",
    title:
      "MCP failures call a runtime limit matched from an app Worker's own error a cause Executor has not confirmed",
    targets: {
      "self-host": na(
        "The scenario above asserts the same unconfirmed match for the forged rejection on self-host.",
      ),
      cloud: managedCloud,
      local: na("Hosted Cloud covers the shared runtime presentation."),
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
  mcpExecuteApprovalSize: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title:
      "MCP approvals show exact arguments wherever they fit, shorten the saved prompt, offer requests far over 100,000 bytes whole and run once approved",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted self-host covers the shared execution driver."),
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
  mcpAccountChoice: {
    fixtures: "actors",
    file: "mcp-account-choice.spec.ts",
    title:
      "MCP calls use the one linked account, which connecting another replaces, and refuse $accounts with AccountChoiceUnsupported before running",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local runs the same journey in its own scenario."),
    },
  },
  localMcpAccountChoice: {
    file: "mcp-account-choice.spec.ts",
    title:
      "Local MCP calls run with the account that replaced the earlier link and refuse $accounts with AccountChoiceUnsupported before running",
    targets: {
      local: scheduled,
      "self-host": na("Hosted links are covered by the hosted account choice scenario."),
      cloud: na("Hosted links are covered by the hosted account choice scenario."),
    },
  },
  mcpExecuteCallTimedOut: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title: "MCP tool calls their server never answers tell the agent not to repeat them",
    targets: {
      "self-host": scheduled,
      cloud: na("The silent MCP server is a loopback listener."),
      local: na("Hosted self-host covers the shared app runtime error mapping."),
    },
  },
  mcpExecuteCallDropped: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title:
      "MCP tool calls whose connection closes after the server ran them are not offered as retries",
    targets: {
      "self-host": scheduled,
      cloud: na("The dropping MCP server is a loopback listener."),
      local: na("Hosted self-host covers the shared app runtime error mapping."),
    },
  },
  mcpExecuteHintedReadTimedOut: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title:
      "MCP tools only their server labels read-only are not offered as retries after they time out",
    targets: {
      "self-host": scheduled,
      cloud: na("The silent MCP server is a loopback listener."),
      local: na("Hosted self-host covers the shared app runtime error mapping."),
    },
  },
  mcpExecuteToolReportedError: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title: "MCP tool results that say the tool failed are listed as failed calls",
    targets: {
      "self-host": scheduled,
      cloud: na("The reporting MCP server is a loopback listener."),
      local: na("Hosted self-host covers the shared execute path."),
    },
  },
  mcpExecutePendingWriteRefused: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title: "Writes refused while their change is still pending tell agents not to repeat them",
    targets: {
      "self-host": scheduled,
      cloud: na("The recording service is a loopback listener."),
      local: na("Hosted self-host covers the shared tool error path."),
    },
  },
  mcpExecuteNestedMcpAfterWrite: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title: "Writes whose MCP connection fails after they wrote tell agents not to repeat them",
    targets: {
      "self-host": scheduled,
      cloud: na("The recording service and closed MCP server are loopback listeners."),
      local: na("Hosted self-host covers the shared tool error path."),
    },
  },
  mcpExecuteResolveWrote: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title:
      "Writes whose app code wrote before reporting a configuration, cache or MCP argument failure are not offered as retries",
    targets: {
      "self-host": scheduled,
      cloud: na("The recording service is a loopback listener."),
      local: na("Hosted self-host covers the shared tool error path."),
    },
  },
  mcpExecuteWriteFailureSurfaces: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title:
      "Every error a write reports after its app code received the call leads with the write warning over REST, MCP, the dashboard and traces, in the Worker and the data facet",
    targets: {
      "self-host": scheduled,
      cloud: na("Self-host runs the same runner and data facet code in both modes."),
      local: na("Hosted self-host covers the shared tool error path and both runner modes."),
    },
  },
  mcpExecuteApprovalSaveFailed: {
    fixtures: "actors",
    legacyStorage: true,
    file: "mcp-execute-failures.spec.ts",
    title:
      "A write whose approval request Executor cannot save reports a storage failure that records the write and is not offered as a retry, over REST and MCP",
    targets: {
      "self-host": scheduled,
      cloud: na("Storage faults need a runner-owned database; Cloud cases share one."),
      local: na("Hosted self-host covers the shared tool call path."),
    },
  },
  mcpSearchRowsUnsaved: {
    fixtures: "actors",
    legacyStorage: true,
    file: "mcp-execute-failures.spec.ts",
    title:
      "A search whose app's search rows cannot be saved reports the app unavailable with why, instead of a page without its tools, even after the program called or described one of them, and its tools stay callable",
    targets: {
      "self-host": scheduled,
      cloud: na("Storage faults need a runner-owned database; Cloud cases share one."),
      local: na("Hosted self-host covers the shared search path."),
    },
  },
  mcpExecuteUnnamedKindWrote: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title:
      "A call that names no kind keeps the write warning after the catalog names its tool a query, when it fails or its approval policy asks for approval, and is not repeated",
    targets: {
      "self-host": scheduled,
      cloud: na("The recording service is a loopback listener."),
      local: na("Hosted self-host covers the shared tool call path."),
    },
  },
  mcpExecuteColdQueryNotReevaluated: {
    fixtures: "actors",
    file: "mcp-execute-failures.spec.ts",
    title:
      "A query that fails before its app's tools were listed is reported as possibly written without evaluating the app again",
    targets: {
      "self-host": scheduled,
      cloud: na("The recording service is a loopback listener."),
      local: na("Hosted self-host covers the shared tool call path."),
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
      local: na(
        "Local negotiates through the same MCP server code; its other MCP scenarios cover that code.",
      ),
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
  apiKeyConcurrentUse: {
    fixtures: "actors",
    file: "api-key-storage-outage.spec.ts",
    title: "Requests that use one API key together all succeed and record its use once",
    targets: {
      cloud: managedCloud,
      "self-host": {
        status: "not-run",
        reason:
          "Self-host runs one database connection, so its requests never contend for a key, and the runner cannot reach that database.",
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
  localAccountChoice: {
    file: "local-account-choice.spec.ts",
    title:
      "the local Accounts tab links, replaces and unlinks accounts: a plain requirement uses its one linked account, many() every linked one, and replaced accounts stay saved",
    targets: {
      local: scheduled,
      "self-host": na("Local pairing journey."),
      cloud: na("Local pairing journey."),
    },
  },
  localAccountChoiceUnsupported: {
    file: "local-account-choice.spec.ts",
    title:
      "local agents cannot choose accounts per call: SDK routes and code mode refuse them with AccountChoiceUnsupported, and an account saved elsewhere is used once linked",
    targets: {
      local: scheduled,
      "self-host": na("Local's raw SDK routes and administrative MCP key."),
      cloud: na("Local's raw SDK routes and administrative MCP key."),
    },
  },
  codeFormattingSource: {
    fixtures: "actors",
    file: "code-formatting.spec.ts",
    title: "code blocks format deployed source and copy without changing stored content",
    targets: {
      local: na("Shared source viewer covered through hosted."),
      "self-host": scheduled,
      cloud: sourceStorageCloud,
    },
  },
  codeFormattingWorkspace: {
    fixtures: "actors",
    file: "code-formatting.spec.ts",
    title: "code blocks format workspace source and copy without changing stored content",
    targets: {
      local: na("Shared source viewer covered through hosted."),
      "self-host": scheduled,
      cloud: sourceStorageCloud,
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
      cloud: sourceStorageCloud,
    },
  },
  sourceDisplayBudget: {
    fixtures: "actors",
    file: "source-display-budget.spec.ts",
    title: "source display budgets bound inline content and preserve complete stored files",
    targets: {
      local: na("Hosted source display budgets."),
      "self-host": scheduled,
      cloud: sourceStorageCloud,
    },
  },
  webhookSourceStatus: {
    fixtures: "actors",
    file: "webhook-source-status.spec.ts",
    title: "webhook source setup stays invisible until provider registration fails",
    targets: {
      local: na("Hosted shared-view journey."),
      "self-host": scheduled,
      cloud: na("Uses a loopback provider fixture."),
    },
  },
  webhookSourceRetryBackoff: {
    fixtures: "actors",
    legacyStorage: true,
    file: "webhook-source-retry-backoff.spec.ts",
    title:
      "a webhook source whose account's OAuth renewal the service keeps refusing waits twice as long after each failure in a row, and configuring it runs at once and starts the count again",
    targets: {
      local: na("Hosted link and webhook source routes."),
      "self-host": scheduled,
      cloud: na("Advances the wall clock and reads stored rows of a runner-owned product process."),
    },
  },
  webhookSourceReconnectWait: {
    fixtures: "actors",
    legacyStorage: true,
    file: "webhook-source-retry-backoff.spec.ts",
    title:
      "a webhook source whose account must reconnect checks it again after twice as long each time it still waits, and reconnecting the account resumes it at once",
    targets: {
      local: na("Hosted link and webhook source routes."),
      "self-host": scheduled,
      cloud: na("Advances the wall clock and reads stored rows of a runner-owned product process."),
    },
  },
  webhookSourceSetupWait: {
    fixtures: "actors",
    legacyStorage: true,
    file: "webhook-source-retry-backoff.spec.ts",
    title:
      "a webhook source waiting for its manual setup tries again after twice as long each time it still waits, and completing the setup runs it at once",
    targets: {
      local: na("Hosted link and webhook source routes."),
      "self-host": scheduled,
      cloud: na("Advances the wall clock and reads stored rows of a runner-owned product process."),
    },
  },
  webhookSourceEditors: {
    fixtures: "actors",
    file: "webhook-source-status.spec.ts",
    title: "only a webhook source's actor or an app manager sees and edits its configuration",
    targets: {
      local: na("Local has no organization members or app managers."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  webhookSourceUnlinkHandover: {
    fixtures: "actors",
    file: "webhook-source-handover.spec.ts",
    title: "a webhook source moves to another linking member when its actor unlinks",
    targets: {
      local: na("Local has no organization members or shared accounts."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  webhookSourceRelink: {
    fixtures: "actors",
    file: "webhook-source-handover.spec.ts",
    title:
      "a webhook source registers again after its account is relinked and returns to an earlier actor",
    targets: {
      local: na("Local has no organization members or shared accounts."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  webhookSourceGroupHandover: {
    fixtures: "actors",
    file: "webhook-source-handover.spec.ts",
    title: "a webhook source moves to another linking member when its actor loses group access",
    targets: {
      local: na("Local has no organization groups."),
      "self-host": scheduled,
      cloud: sourceStorageCloud,
    },
  },
  webhookSourceAccountChoice: {
    fixtures: "actors",
    file: "webhook-source-status.spec.ts",
    title:
      "a webhook source uses its own account and its actor's current link for the app's other requirement, with no saved choice",
    targets: {
      local: na("Hosted actor and manager journey."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  webhookSourceAppAccess: {
    fixtures: "actors",
    file: "webhook-source-handover.spec.ts",
    title: "a webhook callback is refused while its actor cannot use the app",
    targets: {
      local: na("Local has no app access audiences."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  webhookSourceConcurrentLinks: {
    fixtures: "actors",
    file: "webhook-source-handover.spec.ts",
    title: "a concurrent last unlink and link keep the account's webhook source",
    targets: {
      local: na("Local has one user, so no other member links the account."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  webhookSourceRemovalAccounts: {
    fixtures: "actors",
    file: "webhook-source-handover.spec.ts",
    title: "removing a webhook registration uses the accounts it registered with",
    targets: {
      local: na("Uses hosted webhook and link routes."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  localHistoricalSkillAccounts: {
    file: "linked-accounts.spec.ts",
    title:
      "an earlier version's skill reads with that version's requirements on Local, and a renamed requirement needs its own link",
    targets: {
      local: scheduled,
      "self-host": na("Hosted members link accounts and have their own scenario."),
      cloud: na("Hosted members link accounts and have their own scenario."),
    },
  },
  webhookSourceConfigureExpected: {
    file: "linked-accounts.spec.ts",
    title: "a webhook source changes only while it is still the source the caller read",
    targets: {
      local: scheduled,
      "self-host": na(
        "The SDK HTTP surface is served by Local; hosted routes call the same operation.",
      ),
      cloud: na("The SDK HTTP surface is served by Local; hosted routes call the same operation."),
    },
  },
  webhookRegistrationActor: {
    fixtures: "actors",
    file: "webhook-source-handover.spec.ts",
    title:
      "a handed-over webhook registration is removed as the member it registered as, or waits for confirmation",
    targets: {
      local: na("Local has no organization members to hand a registration to."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  accountLinking: {
    fixtures: "actors",
    file: "app-account-links.spec.ts",
    title:
      "connecting accounts from an app's Accounts tab links each only to the requirement it was connected for and discards cancelled drafts, so a plain requirement and a many() requirement sharing its provider run with their own links",
    targets: {
      local: na("Local has its own link scenarios; this is the hosted member journey."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedSkillAccountChoice: {
    fixtures: "actors",
    file: "hosted-app-accounts.spec.ts",
    title: "MCP skill reads use the linked accounts and refuse an accounts choice",
    targets: {
      local: na("Hosted members link accounts; local MCP skills have their own scenario."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedHistoricalSkillAccounts: {
    fixtures: "actors",
    file: "hosted-app-accounts.spec.ts",
    title:
      "an earlier version's skill reads with that version's account requirements, and a renamed requirement needs its own link",
    targets: {
      local: na("Hosted members link accounts; local has its own scenario."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  accountSetDeclarations: {
    fixtures: "actors",
    file: "app-account-links.spec.ts",
    title:
      "many() uses every linked account: connecting or linking another adds it and unlinking one narrows tool calls and skills",
    targets: {
      local: na("Hosted links change through the Accounts tab; local covers its own links."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  accountChoice: {
    fixtures: "actors",
    file: "app-account-links.spec.ts",
    title:
      "replacing a plain requirement's account in the Accounts tab, by linking a saved account or connecting a new one, keeps the old one saved, runs later calls as the new one and leaves other members' links alone",
    targets: {
      local: na("Hosted browser authority journey."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  accountAppTabs: {
    fixtures: "actors",
    file: "app-account-links.spec.ts",
    appOrigin: true,
    title:
      "authored app pages open bookmarks directly and run with the caller's linked accounts, whatever accounts the page names, until unlinking narrows them",
    targets: {
      local: na("Hosted browser authority journey."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  accountVersion: {
    fixtures: "actors",
    file: "app-account-links.spec.ts",
    title: "open tool tabs follow a version and keep running with the linked accounts",
    targets: {
      local: na("Hosted browser authority journey."),
      "self-host": scheduled,
      cloud: sourceStorageCloud,
    },
  },
  localAccountPickerDeepLink: {
    file: "local-app-account-picker.spec.ts",
    title:
      "a local app deep link opens straight in the app with its linked account, keeping path, query and fragment, and the host account picker is gone",
    targets: {
      local: scheduled,
      "self-host": na("Hosted uses its organization member scenario."),
      cloud: na("Hosted uses its organization member scenario."),
    },
  },
  hostedAppAccounts: {
    fixtures: "actors",
    file: "hosted-app-accounts.spec.ts",
    title:
      "hosted app account links belong to each member, and unlinking keeps the account for relinking",
    targets: {
      local: na("Hosted membership only."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedAppAccountRoutes: {
    fixtures: "actors",
    file: "hosted-app-accounts.spec.ts",
    title:
      "hosted app account link routes are idempotent, keep unlinked accounts, list a requirement's linkable accounts and reject unusable accounts, other providers and undeclared requirements",
    targets: {
      local: na("Hosted member link routes; Local link routes have their own scenarios."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedAppAccountsManagerBrowser: {
    fixtures: "actors",
    file: "app-accounts-tab.spec.ts",
    title:
      "someone who can edit the app picks its plain App account with a radio, clears and checks a many() account of their own, and unlinks from the menu, and the link API agrees after each",
    targets: {
      local: na("Hosted app editors; Local links in its own scenario."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedAppAccountsMemberBrowser: {
    fixtures: "actors",
    file: "app-accounts-tab.spec.ts",
    title:
      "a member sees the App accounts greyed out and read-only with the linked account's name, and the app link routes other than the list refuse them",
    targets: {
      local: na("Local has one subject."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedAppSchedulesBrowser: {
    fixtures: "actors",
    file: "app-accounts-tab.spec.ts",
    title:
      "the Schedules tab marks an app schedule as the app's with no approval choice, a member's controls are disabled and refused, and a manager enables and pauses it",
    targets: {
      local: na("Local has one subject; its app schedule controls have their own scenario."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedAppAccountReconnectBrowser: {
    fixtures: "actors",
    file: "app-accounts-tab.spec.ts",
    title:
      "a member's call needing an app account that must reconnect says someone who can edit the app must reconnect it and offers the member no reconnect, while the editor's App accounts section marks it Needs sign-in and offers Reconnect",
    targets: {
      local: na("Hosted members and managers only."),
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback issuer whose token endpoint ends the grant."),
    },
  },
  localAppAccountsBrowser: {
    file: "local-app-accounts-tab.spec.ts",
    title:
      "the local Accounts tab links a saved App account with a radio and unlinks it, keeping it saved, clears and checks a many() account, and the Schedules tab enables and pauses the app schedule with no approval choice",
    targets: {
      local: scheduled,
      "self-host": na("Hosted managers and members have their own scenarios."),
      cloud: na("Hosted managers and members have their own scenarios."),
    },
  },
  hostedManyAccounts: {
    fixtures: "actors",
    file: "hosted-app-accounts.spec.ts",
    title:
      "hosted many() calls use every linked account and the rest once one is unlinked, while a plain requirement sharing the provider uses only its own link",
    targets: {
      local: na("Hosted membership only."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedAppLinks: {
    fixtures: "actors",
    file: "app-account-app-links.spec.ts",
    title:
      "hosted app requirements use the accounts managers link for everyone; members list those app links without upstream identity but cannot read a requirement's choices, change or override them, and unlinking needs an app link again",
    targets: {
      local: na("Hosted managers and members; Local app links have their own scenario."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedAppLinkConnections: {
    fixtures: "actors",
    file: "app-account-app-links.spec.ts",
    title:
      "a hosted connection for an app requirement links for everyone only an account its manager can use, and completes only in the scope it started in",
    targets: {
      local: na(
        "Hosted managers and account audiences; Local connections have their own scenario.",
      ),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedAppLinkOAuthConnections: {
    fixtures: "actors",
    file: "app-account-app-links.spec.ts",
    title:
      "a hosted OAuth connection for an app requirement records a refused completion, reports one retargeted to another scope, and links after a new sign-in",
    targets: {
      local: na("Hosted managers and account audiences."),
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer to count token exchanges."),
    },
  },
  hostedAppLinkHeldAccess: {
    fixtures: "actors",
    file: "app-account-link-held-access.spec.ts",
    title:
      "an app link or unlink waiting for the app's lock is refused when the admin is demoted or the account stops being shared meanwhile, and goes through when nothing changed",
    targets: {
      "self-host": scheduled,
      cloud: na("The statement hold is mounted by the self-host test entry point."),
      local: na("Local has no organization roles or account audiences."),
    },
  },
  hostedDepartedMemberAppLink: {
    fixtures: "actors",
    file: "departed-member-app-links.spec.ts",
    title:
      "an app link to a member's personal account stops filling the app's requirement when the member leaves and stays listed for its managers, while a shared account linked beside it keeps serving",
    targets: {
      local: na("Hosted members leave organizations; Local has one owner."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedAppLinkRoleLock: {
    fixtures: "actors",
    file: "app-account-link-role-lock.spec.ts",
    title:
      "an app link that waits for the admin's membership while a demotion commits is refused with the committed role",
    targets: {
      cloud: managedCloud,
      "self-host": na(
        "Self-host's single PGlite connection runs one transaction at a time, so a demotion cannot commit while a link waits on the membership.",
      ),
      local: na("Local has no organization roles."),
    },
  },
  hostedMcpLinkHeldAccess: {
    fixtures: "actors",
    file: "app-account-link-held-access.spec.ts",
    title:
      "an MCP connection that links its account target while waiting for the app's lock is refused when the app or the account stops being shared meanwhile, and links when nothing changed",
    targets: {
      "self-host": scheduled,
      cloud: na("The statement hold is mounted by the self-host test entry point."),
      local: na("Local has no app or account audiences."),
    },
  },
  hostedAppAccountWebhooks: {
    fixtures: "actors",
    file: "app-account-webhooks.spec.ts",
    title:
      "an app-linked account is the app's webhook source without an actor, serving the webhooks of the requirements it is linked to, also while members link it, and hands the source to a linking member when its last app link goes",
    targets: {
      local: na("Hosted managers and members; Local app-account webhooks have their own scenario."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedUserWebhookRequirements: {
    fixtures: "actors",
    file: "app-account-webhooks.spec.ts",
    title:
      "a member's user-account webhook source serves only the requirements its account is linked to, among requirements of one provider, and registers and stops their webhooks as those links change",
    targets: {
      local: na("Hosted members; Local user-account webhooks have their own scenario."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedAppAccountWebhookRemoval: {
    fixtures: "actors",
    file: "app-account-webhooks.spec.ts",
    title:
      "unlinking an app link removes its app-account webhook with the account while the app could still use it, and leaves a departed member's for a manager to open and confirm its manual removal",
    targets: {
      local: na("Local has no organization members to depart."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedAppAccountWebhookManualSetup: {
    fixtures: "actors",
    file: "app-account-webhooks.spec.ts",
    title:
      "an app manager without use of an app-account webhook's account opens, completes, removes and confirms the removal of its manual setup, and a member's own webhook stays refused to them",
    targets: {
      local: na("Hosted managers and members; Local has no organization roles."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedAccountWebhookDependencies: {
    fixtures: "actors",
    file: "account-webhook-dependencies.spec.ts",
    title:
      "deleting an account a live webhook registration ran with is refused naming that subscription, over REST and through the Executor app, while a disabled registration holds only its source account",
    targets: {
      local: na("Local has no organization members to depart."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedAccountWebhookHiddenDependents: {
    fixtures: "actors",
    file: "account-webhook-dependencies.spec.ts",
    title:
      "a member deleting their account refused for webhook subscriptions they can't see is told how many, never which apps or subscriptions, and can delete it once those are removed",
    targets: {
      local: na("Local has one user, who sees every app and subscription."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedManualWebhookAcrossDeploys: {
    fixtures: "actors",
    file: "app-account-webhooks.spec.ts",
    title:
      "a manual app-account webhook keeps its subscription, callback URL and secret across deploys that keep its setup, a deploy that changes the setup replaces it, and a caller's create is refused as app-managed",
    targets: {
      local: na("Hosted managers and app links; Local has no organization roles."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedManualWebhookRollback: {
    fixtures: "actors",
    file: "app-account-webhooks.spec.ts",
    title:
      "activating an earlier version moves a carried manual webhook back to it, so its deliveries run the active code, and activating the later version moves it forward again",
    targets: {
      local: na("Hosted managers and app links; Local has no organization roles."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedManualWebhookStateSchema: {
    fixtures: "actors",
    file: "app-account-webhooks.spec.ts",
    title:
      "a manual webhook keeps its setup when a deploy reorders its state fields, and a deploy that changes what they accept replaces it in either direction",
    targets: {
      local: na("Hosted managers and app links; Local has no organization roles."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedManualWebhookStateReference: {
    fixtures: "actors",
    file: "app-account-webhooks.spec.ts",
    title:
      "a deploy that reorders the anyOf branches a manual webhook's state schema references by position replaces its setup",
    targets: {
      local: na("Hosted managers and app links; Local has no organization roles."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedManualWebhookNestedRequired: {
    fixtures: "actors",
    file: "app-account-webhooks.spec.ts",
    title:
      "a manual webhook keeps its setup when a deploy reorders a list of field names nested anywhere in its state schema, such as a Draft 7 dependency's required fields",
    targets: {
      local: na("Hosted managers and app links; Local has no organization roles."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedManualWebhookDeepStateSchema: {
    fixtures: "actors",
    file: "app-account-webhooks.spec.ts",
    title:
      "a manual webhook keeps its setup across a deploy when its state schema nests 64 levels deep, and a deploy of an unchanged schema 65 or more levels deep replaces it instead of leaving its source pending",
    targets: {
      local: na("Hosted managers and app links; Local has no organization roles."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedManualWebhookDeepConfiguration: {
    fixtures: "actors",
    file: "app-account-webhooks.spec.ts",
    title:
      "a manual webhook keeps its setup across a deploy when its configuration nests 64 levels deep, and a deploy of an unchanged configuration 65 or more levels deep replaces it instead of leaving its source pending",
    targets: {
      local: na("Hosted managers and app links; Local has no organization roles."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedManualWebhookWideSetup: {
    fixtures: "actors",
    file: "app-account-webhooks.spec.ts",
    title:
      "a manual webhook keeps its setup across a deploy when the setup it compares is as long as the comparison allows, and a deploy of an unchanged setup one character longer replaces it",
    targets: {
      local: na("Hosted managers and app links; Local has no organization roles."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedManualWebhookNestedWideSetup: {
    fixtures: "actors",
    file: "app-account-webhooks.spec.ts",
    title:
      "a deploy of an unchanged manual webhook setup whose configuration nests wide lists in each other, each fitting the comparison alone, replaces it",
    targets: {
      local: na("Hosted managers and app links; Local has no organization roles."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedManualWebhookConcurrentActivations: {
    fixtures: "actors",
    file: "app-account-webhooks.spec.ts",
    title:
      "a webhook source reconciling for an activation that another supersedes, also one back to the same version, is ready only once its manual and registered webhooks run the active version",
    targets: {
      local: na("Hosted managers and app links; Local has no organization roles."),
      "self-host": scheduled,
      // Deployed Cloud refuses the loopback provider fixture; the local Cloud Worker reaches it.
      cloud: managedCloud,
    },
  },
  hostedAppSchedules: {
    fixtures: "actors",
    file: "app-schedules.spec.ts",
    title:
      "a hosted app schedule replaces members' copies, only managers control it, and it runs without a caller with the account linked for everyone or waits for one",
    targets: {
      local: na("Hosted managers and members; Local app schedules have their own scenario."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedAppScopeWorkflows: {
    fixtures: "actors",
    file: "app-schedules.spec.ts",
    title:
      "a workflow an app schedule starts runs without a caller, and its history needs the captured app account still linked for everyone",
    targets: {
      local: na("Hosted app-scope workflow history checks."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedAppScopeWorkflowUnlinked: {
    fixtures: "actors",
    file: "app-schedules.spec.ts",
    title:
      "an app-scope workflow step whose captured app account was unlinked while the run slept fails as a revoked credential",
    targets: {
      local: na("Hosted app-scope workflow history checks."),
      "self-host": scheduled,
      cloud: na(
        "Cloud's remote app runner turns a step's credentials failure into a retryable engine failure, for user accounts too; pre-existing in main.",
      ),
    },
  },
  hostedRetainedWorkflowScopes: {
    fixtures: "actors",
    file: "app-account-workflow-history.spec.ts",
    title:
      "a retained workflow run is read by the scope each captured account had on its version: an app account by its app link, a user account by the caller's use",
    targets: {
      local: na("Hosted account audiences and app links."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedAppRequirementScopes: {
    fixtures: "actors",
    file: "app-account-app-links.spec.ts",
    title: "a hosted deploy naming one requirement in both the app and user scopes is refused",
    targets: {
      local: na("Local deploys have their own scope scenario."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  hostedAccountScheduling: {
    fixtures: "actors",
    file: "hosted-account-scheduling.spec.ts",
    title: "hosted schedules and workflows run as their actor with the actor's linked accounts",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted membership and account links only."),
    },
  },
  hostedStaticSchedules: {
    fixtures: "actors",
    file: "hosted-account-scheduling.spec.ts",
    title: "hosted schedule controls do not depend on dynamic tool discovery",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Exercises hosted schedule routes."),
    },
  },
  hostedScheduleConcurrentOwners: {
    fixtures: "actors",
    file: "hosted-account-scheduling.spec.ts",
    title:
      "two members configuring a schedule at once each get their own copy, and one member's concurrent requests one",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has one subject."),
    },
  },
  hostedScheduleMemberCopies: {
    fixtures: "actors",
    file: "hosted-account-scheduling.spec.ts",
    title:
      "each member has one copy of a hosted schedule that runs as them with their linked account, and pausing, running or removing one copy leaves the other's",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has one subject."),
    },
  },
  hostedScheduleFollowsLinks: {
    fixtures: "actors",
    file: "hosted-account-scheduling.spec.ts",
    title:
      "a hosted schedule copy runs with the account its member links now: a replacement changes the next run, and with none linked it reports and shows that an account is required",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted membership and account links only."),
    },
  },
  hostedScheduleAccountRequiredSkips: {
    fixtures: "actors",
    file: "hosted-account-scheduling.spec.ts",
    title:
      "a hosted schedule copy whose member has no linked account skips due occurrences without running and runs once one is linked",
    targets: {
      "self-host": scheduled,
      cloud: na("Advances the wall clock of a runner-owned product process."),
      local: na("Hosted membership and account links only."),
    },
  },
  hostedScheduleActorLosesApp: {
    fixtures: "actors",
    file: "hosted-account-scheduling.spec.ts",
    title: "the scheduler refuses a due occurrence whose actor can no longer use the app",
    targets: {
      "self-host": scheduled,
      cloud: na("Advances the wall clock of a runner-owned product process."),
      local: na("Hosted membership and app access only."),
    },
  },
  hostedScheduleReconcilePerActor: {
    fixtures: "actors",
    file: "hosted-account-scheduling.spec.ts",
    title:
      "a redeploy checks each member's schedule against the app evaluated with that member's own accounts",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted members as actors; local covers its linked account separately."),
    },
  },
  hostedAppAccountRevocation: {
    fixtures: "actors",
    file: "hosted-app-accounts.spec.ts",
    title: "hosted app account links recheck shared accounts after deletion and revocation",
    targets: {
      local: na("Hosted membership only."),
      "self-host": scheduled,
      cloud: scheduled,
    },
  },
  linkedAccounts: {
    file: "linked-accounts.spec.ts",
    title:
      "local calls use every linked many() account and the plain requirement's one link, linking another plain account replaces it, and SDK routes refuse an account choice",
    targets: {
      local: scheduled,
      "self-host": na("Hosted app account links have their own scenarios."),
      cloud: na("Hosted app account links have their own scenarios."),
    },
  },
  workflowActors: {
    fixtures: "actors",
    file: "workflow-actors.spec.ts",
    title: "approval-resumed workflow controls stay inside the caller's own runs",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted memberships, API keys and MCP."),
    },
  },
  workflowControls: {
    fixtures: "actors",
    file: "workflow-controls.spec.ts",
    title:
      "in-app workflow controls answer apps built before the version rename and refuse an over-long key before starting a run",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app management routes."),
    },
  },
  workflowStartReadBack: {
    fixtures: "actors",
    file: "workflow-controls.spec.ts",
    title:
      "an in-app workflow start whose saved run cannot be read back names the run, is not retryable, and starting again as advised makes no second run",
    targets: {
      "self-host": scheduled,
      cloud: na("The storage fault is mounted by the self-host test entry point."),
      local: na("This scenario uses hosted app management routes."),
    },
  },
  workflowStartCommit: {
    fixtures: "actors",
    file: "workflow-controls.spec.ts",
    title:
      "an in-app workflow start whose commit is refused, times out or loses its answer says the run may exist without offering a retry, and answers with the run once it reads it back",
    targets: {
      "self-host": scheduled,
      cloud: na("The storage fault is mounted by the self-host test entry point."),
      local: na("This scenario uses hosted app management routes."),
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
    title: "app workflows pin versions and accounts and retry steps",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
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
  mcpEventsAppRemoval: {
    fixtures: "actors",
    file: "mcp-events-app-removal.spec.ts",
    title:
      "removing an app ends its event subscriptions, and a subscription to a new app with the same name binds to the new app",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted personal access token and webhook routes."),
    },
  },
  mcpEventsAppHidden: {
    fixtures: "actors",
    file: "mcp-events-app-removal.spec.ts",
    title:
      "a refresh by a caller who can no longer see the event's app is refused as an unknown event",
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
      "an event reaches only subscribers who may use every account its invocation used, and a grant limited to some accounts only those that used them",
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
  appUiWithoutAppDomain: {
    file: "app-ui-without-app-domain.spec.ts",
    title: "a self-host with no app domain says an app UI has no address because of the domain",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud always has an app domain."),
      local: na(
        "Local serves app UIs from its own origin; only self-host starts a scenario-owned server.",
      ),
    },
  },
  remoteRegistryFailures: {
    file: "registry-failures.spec.ts",
    title:
      "Public app catalog refuses registry redirects, reports distinct registry failures and leaves out listings it cannot read",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud serves the registry from its own database instead of a remote origin."),
      local: na(
        "Local uses the same registry client; only self-host starts a scenario-owned server.",
      ),
    },
  },
  idlePollTraces: {
    file: "idle-poll-traces.spec.ts",
    title:
      "An idle server's checks for due runs, queued jobs and event deliveries export no traces",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud dispatches on alarms and requests, not by polling."),
      local: na(
        "Local runs the same scheduler and event loops; only self-host starts a scenario-owned server.",
      ),
    },
  },
  failedPollTraces: {
    legacyStorage: true,
    file: "idle-poll-traces.spec.ts",
    title:
      "A failing check for due runs, queued jobs or event deliveries exports which statement failed",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud dispatches on alarms and requests, not by polling."),
      local: na(
        "Local runs the same scheduler and event loops; only self-host starts a scenario-owned server.",
      ),
    },
  },
  remoteRegistryReleasedClients: {
    file: "registry-failures.spec.ts",
    title:
      "Clients released before publisher scopes find a remote registry's listings by the names they were shown, are refused a name two listings share, and copy only the commit they were shown",
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
  appTelemetryBurst: {
    file: "telemetry-backpressure.spec.ts",
    title: "A burst of app calls behind a shedding collector delivers every call's app telemetry",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Cloud's Worker reads its collector address at start; only self-host starts a scenario-owned server.",
      ),
      local: na("Local uses the same relay; only self-host starts a scenario-owned server."),
    },
  },
  addAppRegistry: {
    file: "add-app-registry.spec.ts",
    title: "Add app lists catalog apps and never reads the public registry",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud serves the registry from its own database instead of a remote origin."),
      local: na(
        "Local uses the same registry client; only self-host starts a scenario-owned server.",
      ),
    },
  },
  selfHostOnboarding: {
    file: "self-host-onboarding.spec.ts",
    title: "Self-host administrator setup connects accounts and an agent before Apps",
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
  onboardingAssistant: {
    file: "cloud-onboarding.spec.ts",
    title:
      "Cloud onboarding's assistant step notices any MCP client, and Claude's guide calls connected only an assistant that connects over MCP after it opens",
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
  // The flag stub and the collector that receives the exposure exist only in a managed local
  // Cloud; deployed stages evaluate the stage project's draft flag and serve the control.
  onboardingAssistantFirst: {
    file: "cloud-onboarding-experiment.spec.ts",
    title:
      "Cloud onboarding experiment assistant_first connects the assistant, then accounts, then sends the first prompt",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  onboardingAccountsFirst: {
    file: "cloud-onboarding-experiment.spec.ts",
    title:
      "Cloud onboarding experiment accounts_first connects accounts, then the assistant, then sends the first prompt",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  onboardingExperimentUnavailable: {
    file: "cloud-onboarding-experiment.spec.ts",
    title:
      "Cloud onboarding experiment serves accounts first without an exposure when its flag is unavailable",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  onboardingRequiredAccountsFirst: {
    file: "cloud-onboarding-skip-experiment.spec.ts",
    title:
      "Cloud onboarding skip experiment required keeps accounts_first setup until both steps are done",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  onboardingRequiredAssistantFirst: {
    file: "cloud-onboarding-skip-experiment.spec.ts",
    title:
      "Cloud onboarding skip experiment required keeps assistant_first setup until both steps are done",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  onboardingSkippable: {
    file: "cloud-onboarding-skip-experiment.spec.ts",
    title: "Cloud onboarding skip experiment skippable still skips both steps to the dashboard",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  // The v1 check reads the emulated v1 database only a managed local Cloud has, and its
  // scenarios write that database; deployed stages leave the check off.
  v1SignInStop: {
    file: "cloud-v1-sign-in.spec.ts",
    title:
      "Cloud sign-in keeps a new v1 organization member on v1 and fails closed while WorkOS is unavailable",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1SignInInvited: {
    file: "cloud-v1-sign-in.spec.ts",
    title:
      "Cloud sign-in keeps a new v1 organization member who joins an invited team from creating another, and fails closed while WorkOS is unavailable",
    targets: { ...cloudOnboarding, cloud: managedCloud },
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
  v1SignInEmpty: {
    file: "cloud-v1-sign-in.spec.ts",
    title:
      "Cloud sign-in admits members of only empty free v1 organizations, keeps members of paid or nonempty ones on v1, and fails closed while v1's database is unavailable",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  // The import reads the emulated v1 WorkOS, Vault and database only a managed local Cloud has.
  v1ImportRun: {
    file: "cloud-v1-import.spec.ts",
    title:
      "Cloud v1 import moves a single-member workspace on the server into a new organization with v1's tool names, the member's accounts linked for them and the workspace's linked for everyone, and approvals, reports what could not move, and writes nothing to v1",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportChecks: {
    file: "cloud-v1-import.spec.ts",
    title:
      "Cloud v1 import carries v1's account checks with their identity field, fails a check that redirects without sending its credentials on, keeps fixed credentials out of app source, skips policies v1 never applied, and names OpenAPI tools v1 stored no operations for as v1 compiled them",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportToolkits: {
    file: "cloud-v1-import.spec.ts",
    title:
      "Cloud v1 import turns toolkits into scoped MCP connections with v1's tools, linked accounts and approvals, and artifacts into undeployed apps that need repair",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportMcpForward: {
    file: "cloud-v1-import.spec.ts",
    title:
      "Cloud v1 import keeps a workspace that fails verification frozen in v1, and accepts MCP requests v1 forwards for an imported workspace, with a new signed bearer for each request of a session, scopes a toolkit's bearer to the caller's own copy, and refuses a wrong signature, an expired or too long-lived bearer, an account, organization or toolkit copy the import never mapped, and a toolkit claim without its connection",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportOptInToolkits: {
    file: "cloud-v1-import.spec.ts",
    title:
      "Cloud v1 import moves an organization into the toolkit copies the opt-in import keyed by the toolkit alone, updating the copy its member kept and keeping the one they changed in v2 without making either a second copy, and runs v1's forwarded toolkit requests under those copies",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1HandoffSignIn: {
    file: "cloud-v1-session-handoff.spec.ts",
    title:
      "Cloud v1 import hands a moved workspace's member from their v1 session to v2: the handoff starts a session for the user the import mapped and opens the organization with no referrer, a browser signed in as them is only redirected, one signed in as another member keeps its session, and a used token opens sign-in",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1HandoffRefusals: {
    file: "cloud-v1-session-handoff.spec.ts",
    title:
      "Cloud v1 import opens v2 sign-in without a session for a handoff with a wrong signature, an expired or too long-lived token, another audience or version, a WorkOS user the import never mapped, or a member who has left the organization",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportToolkitCalls: {
    file: "cloud-v1-import.spec.ts",
    title:
      "Cloud v1 import makes toolkits over the workspace's and a member's connections callable through their v1 URLs, running the org toolkit's copy as the app the workspace's account is linked to and the personal toolkit's as the member's account",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportSplitConnections: {
    file: "cloud-v1-import.spec.ts",
    title:
      "Cloud v1 import moves an integration whose connections have different v1 rules as an app per connection, each with only its connection's account, tools and rules and a member's private to them, keeps one app for an integration whose moving connections share their rules, selects both apps for a toolkit over both connections and forwards each v1 call to its connection's app, plans the same apps in its dry run, and reuses every app, account and toolkit copy when it runs again",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportStampedApprovals: {
    file: "cloud-v1-import.spec.ts",
    title:
      "Cloud v1 import keeps asking before an MCP tool v1 stamped as needing approval after its server drops the destructive hint, and leaves the tools v1 allowed without a rule of their own",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportUnlistedRules: {
    file: "cloud-v1-import.spec.ts",
    title:
      "Cloud v1 import decides the tools v1 never listed by v1's rules: an MCP tool a rule blocks by name is left out, one no rule names asks as v1's catch-all rule says, an OpenAPI operation v1 compiled asks as its rule says, and the repair finds the import's own apps unchanged",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportRepair: {
    file: "cloud-v1-import.spec.ts",
    title:
      "Cloud v1 import repairs an MCP app moved before v1's approval stamps became rules: it plans without writing, deploys the earlier importer's app with the stamp as its own rule, gives an app an earlier import deployed the importer's source now, leaves an app whose users turned its approvals off or dropped them in v2 as they chose, keeps the code of an app its users changed beside its approvals and adds v1's approvals beneath it, finds nothing left on a second run, and runs the version a repair replaced again only while the app still runs the repair's",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportRollback: {
    file: "cloud-v1-import-run.spec.ts",
    title:
      "Cloud v1 import marks a verified workspace moved in v1 and gives it back on rollback only once its v2 organization is deleted, clearing its import map but its users",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportPaidBilling: {
    file: "cloud-v1-import-run.spec.ts",
    title:
      "Cloud v1 import carries a paid v1 Team subscription over to v2's Team plan on the same Stripe subscription with its renewal: per member with its seats and a cancellation at the end of its period, a flat price kept with unlimited members, and a grandfathered Hobby organization moved to v2's Free plan with its v1 customer untouched",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportBillingReturn: {
    file: "cloud-v1-import-run.spec.ts",
    title:
      "Cloud v1 import keeps a paid workspace whose subscription did not carry over frozen with its billing held, offering no v2 billing or checkout, gives the subscription back to v1 on the same Stripe subscription with its seats, past a free customer v1 made meanwhile, and then deleting the v2 organization cancels nothing and the workspace rolls back",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportRequests: {
    file: "cloud-v1-import.spec.ts",
    title:
      "Cloud v1 import sends each OpenAPI request where v1 did, for YAML, public, unnamed-method, one service's multi-host and several services' APIs and an operation server that uses the first document server's variable without declaring it, refuses an API that would send an account's credentials to several hosts over plain HTTP, skips an API whose server variable no server declares or with no absolute server URL and no base URL without naming its specification's URL, drops an account check whose server variable turns it to plain HTTP, and converts only a workspace whose every item moved",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportOAuthRenewal: {
    file: "cloud-v1-import.spec.ts",
    title:
      "Cloud v1 import signs in and renews OAuth accounts with each connection's v1 client, granted scopes and resource, not the integration's method, refuses a token endpoint v1 no longer trusted, sends an OAuth integration's fixed credentials from a second account linked for everyone, and leaves out fixed headers that repeat the connection's own client ID and secret",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportCopiedMove: {
    file: "cloud-v1-import.spec.ts",
    title:
      "Cloud v1 import moves an organization already copied to v2 into that copy: its dry run reports the copy's slug, an account v1 renewed later takes v1's newer tokens while one v2 renewed keeps its own, both keep fitting their app after v1 renamed its integration, and an app its members deployed in v2 since keeps their version, while what they removed in v2 stays removed, also when v1 removed it too, and a teammate they added stays",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  // The operator clients it moves grants to are the ones every managed local Cloud starts with.
  v1ImportFirstParty: {
    file: "cloud-v1-import.spec.ts",
    title:
      "Cloud v1 import moves connections that signed in through Executor's own apps to v2's operator client of the same name, including a GitHub-shaped MCP server that names the scopeless client's endpoints, which renews them with the granted scopes, sends the token to each of a service's hosts the client reaches, and refuses an app v2 does not offer, a scope it does not allow, a host its tokens never reach, a server that does not sign in with it and one whose resource metadata names another resource, each of which its dry run refuses first for the same reason",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportBuilds: {
    file: "cloud-v1-import.spec.ts",
    title:
      "Cloud v1 import writes an OpenAPI document with characters beyond ASCII as ASCII JSON that reads as v1's, also for a large API whose name and base URL path go beyond Latin-1, which builds and calls with its v1 key, builds OpenAPI and GraphQL apps whose v1 OAuth clients set scopes in their authorization URLs, which reconnect sending v1's authorization and token requests, refusing a client whose request v2 cannot send as v1 did, and says why and where a stored specification cannot be read",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportMicrosoftGraph: {
    file: "cloud-v1-import.spec.ts",
    title:
      "Cloud v1 import reads the large Graph document v1's Microsoft presets share one entry at a time, as v1 read it, and moves each preset into an app with exactly its v1 operations under v1's names and only the components they reach, skips a preset whose document has an entry that cannot be parsed, naming its line, and refuses one whose document is not block YAML",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportPlanOutage: {
    file: "cloud-v1-import.spec.ts",
    title:
      "Cloud v1 import retries v1 plan reads that time out or fail and still reports the organization",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportSplitNames: {
    file: "cloud-v1-import-run.spec.ts",
    title:
      "Cloud v1 import numbers the apps of members' connections that share a name when their integration becomes an app per connection, each private to its member, beside the workspace connection's app for everyone",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportShared: {
    file: "cloud-v1-import-run.spec.ts",
    title:
      "Cloud v1 import moves a shared workspace on the server and cuts it over once it verifies: the oldest admin owns it, members keep their roles without a welcome email, org connections become shared accounts linked for everyone and members' their own, a member's approve rule is dropped while their block applies to everyone, every member gets their own copy of an org toolkit, and a former member's rows stay behind",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportSlugDisplacement: {
    file: "cloud-v1-import-run.spec.ts",
    title:
      "Cloud v1 import gives a v1 workspace the slug a v2 team holds only when the operator listed that team in its allow table row: the dry run plans the team's new slug and writes nothing, the import renames the team and creates the workspace at the slug in one transaction, the team's member keeps it and its apps at the new slug while the old slug names the workspace, a listed team that does not hold the slug is reported and left alone, and an unlisted holder keeps its slug while the workspace takes a suffix",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportInto: {
    file: "cloud-v1-import-run.spec.ts",
    title:
      "Cloud v1 import moves an empty v1 workspace into the v2 team its one member owns when the operator listed that team in its allow table row: the dry run plans it and writes nothing, the import records the workspace against the team and marks it moved at the team's slug without creating an organization, user, membership or billing hold or changing the team, v1's forwarded MCP requests run in the team, starting it again and a later dry run find the team through its map row, billing return is refused, and a rollback gives the workspace back to v1 without deleting the team",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportIntoLeave: {
    file: "cloud-v1-import-run.spec.ts",
    title:
      "Cloud v1 import moves a v1 workspace into its member's v2 team without its data when the operator lists it to leave v1's data behind: the dry run counts v1's items and plans none, the import marks it moved at the team's slug with nothing copied and v1's rows untouched, and a rollback gives it back without changing the team",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportIntoCopy: {
    file: "cloud-v1-import-run.spec.ts",
    title:
      "Cloud v1 import copies a paid, shared v1 workspace into the empty v2 team its owner owns when the operator lists it: the team keeps its name and slug, gains the workspace's app, accounts and toolkit copies, its teammate joins, its subscription carries over to the team, a second copy into the team is refused as it is no longer empty, and after its billing goes back a rollback removes only what the import added",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportIntoRefused: {
    file: "cloud-v1-import-run.spec.ts",
    title:
      "Cloud v1 import refuses to move a v1 workspace into a listed existing v2 organization when it has items to copy, a second active member, a pending invitation or a paid plan, also when it would leave its data behind, when its owner has no v2 account or does not own the organization, also to copy into it, when the organization does not exist, and when the listed mode is unknown: the dry run says why, and the import holds it back and gives it to v1 again without writing its import map or changing the organization",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportAllowed: {
    file: "cloud-v1-import-run.spec.ts",
    title:
      "Cloud v1 import writes only organizations with a row in its allow table, refuses one without a row, a start that adds one and a start that pages through v1, writing nothing to v1 or v2, and runs dry runs whatever the table holds",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportDryRun: {
    file: "cloud-v1-import-run.spec.ts",
    title:
      "Cloud v1 import dry runs report TRACE tools, connections that cannot move, missing secrets, first-party clients v2 lacks or holds under another client ID than v1's, rules that match no v2 tool, artifact roles that do not map, v1 rows the import cannot read and pending members, check a held-back Enterprise organization's items, write nothing to v1, v2 or the app build store, aggregate a run a page at a time, skip ids that are not v1 organization ids, and answer only the operator",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  v1ImportStale: {
    file: "cloud-v1-import-run.spec.ts",
    title:
      "Cloud v1 import dry runs skip and report what v1 cannot run either, without blocking the organization: a local MCP server, an API with no absolute base URL or a server variable no server declares, an unreadable specification, a GraphQL endpoint that is not http(s), their connections and rules, an operation on a WebSocket server, a tool the organization's revised specification dropped, connections whose OAuth client, credential or Vault secret is gone, and rules that match no tool; move an API on two services' hosts, an org connection whose secret a member saved, flagging members who saved different values, a token saved on an OAuth method without a client, and OAuth MCP servers with fixed headers, reporting those that repeat the server's own OAuth client",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  // The bound counts every run's organizations on a Cloud, so this runs on its own local Cloud.
  v1ImportBounded: {
    file: "cloud-v1-import-run.spec.ts",
    title:
      "Cloud v1 import keeps at most the bound of organizations running across every run, defers the rest until one finishes, does not start or count again an organization its run has running, and reports an organization whose assessment keeps failing, with the kind of failure, instead of leaving it pending",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  // Autumn faults match every caller of a route, so this runs on its own managed local Cloud.
  slowAutumnDeadlines: {
    file: "cloud-autumn-slow.spec.ts",
    title:
      "Cloud sign-in's v1 check and the billing overview each send one Autumn read while Autumn is slow, and say they are unavailable within their own deadlines",
    targets: { ...cloudOnboarding, cloud: managedCloud },
  },
  localSkills: {
    file: "local-skills.spec.ts",
    title: "local MCP skills follow configured copies and app versions",
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
  localSkillsInputSchema: {
    file: "local-skills.spec.ts",
    title:
      "MCP skills accept exactly the inputs their advertised schema accepts, and every skills call the tool descriptions and Executor skills show succeeds",
    targets: {
      local: scheduled,
      "self-host": na(
        "Every product serves the same skills tool, descriptions and Executor skills from packages/mcp and app-templates; local reaches all three modes with one bearer.",
      ),
      cloud: na(
        "Every product serves the same skills tool, descriptions and Executor skills from packages/mcp and app-templates; local reaches all three modes with one bearer.",
      ),
    },
  },
  skillReadTelemetry: {
    fixtures: "actors",
    managementApps: ["owner"],
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
    managementApps: ["owner"],
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
  localAppsCliFailures: {
    file: "local-apps-cli.spec.ts",
    title:
      "apps CLI reports the host's error code, status and fields as text and JSON, says when the CLI is out of date, refuses source over the limits or not UTF-8 before uploading, and reads EXECUTOR_HOST",
    targets: {
      local: scheduled,
      "self-host": na("The CLI's hosted path needs a browser OAuth login; local uses an API key."),
      cloud: na("The CLI's hosted path needs a browser OAuth login; local uses an API key."),
    },
  },
  localAppsCliPipedOutput: {
    file: "local-apps-cli.spec.ts",
    title:
      "apps CLI prints source larger than a pipe holds in full to a slow reader, and stops quietly for one that closes early",
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
    title: "bundled app skills remain authorized and pinned across versions",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario tests hosted membership; local skills are covered through MCP."),
    },
  },
  appSkillVersions: {
    fixtures: "actors",
    file: "app-skills.spec.ts",
    title: "app skill versions retain pinned history through updates and activation",
    targets: {
      "self-host": scheduled,
      cloud: sourceStorageCloud,
      local: na("This journey checks hosted skill authorization and versions."),
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
    title: "schedules removed from app source are deleted when a version activates",
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
  legacyTargetlessConnections: {
    legacyStorage: true,
    file: "legacy-targetless-connections.spec.ts",
    title:
      "upgrading deletes connections stored without an app target and their sign-ins, and keeps targeted ones, which complete as user links when stored before scopes",
    targets: {
      local: scheduled,
      "self-host": na(
        "Self-host runs the same SDK step, with its product's access rows, in the hosted scenario.",
      ),
      cloud: na(
        "Legacy rows need a runner-owned database; Cloud cases share one Worker and database.",
      ),
    },
  },
  savedOAuthClientsAmbiguous: {
    fixtures: "actors",
    legacyStorage: true,
    serverEnvironment: { EXECUTOR_DATA_STEPS: "report" },
    file: "saved-oauth-clients-ambiguous.spec.ts",
    title:
      "The saved OAuth client data step reports why a client several providers hold is ambiguous, and whether its key names one holder",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Legacy rows need a runner-owned database; Cloud cases share one Worker and database.",
      ),
      local: na("Local has one owner; the step's ambiguity reading is shared with self-host."),
    },
  },
  oauthClientSharedIssuer: {
    fixtures: "actors",
    file: "oauth-clients-by-issuer.spec.ts",
    title:
      "One OAuth client registered for an authorization server is offered to and signs in every app that signs in there, whatever its provider definition, and an app that signs in at another server is neither offered it nor can name it",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Hosted client registration; local shares the SDK's client lookup."),
    },
  },
  oauthClientIssuerMigration: {
    fixtures: "actors",
    legacyStorage: true,
    serverEnvironment: { EXECUTOR_DATA_STEPS: "report" },
    file: "oauth-client-issuer-migration.spec.ts",
    title:
      "Upgrading OAuth clients stored per provider records each one's authorization server, merges an organization's clients holding the same details for one server into one with the union of their audiences, and leaves a client whose server is unknown offered to no sign-in",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Legacy rows need a runner-owned database; Cloud cases share one Worker and database.",
      ),
      local: na("Hosted audiences; the SDK step is shared with self-host."),
    },
  },
  savedOAuthClientsByIssuer: {
    fixtures: "actors",
    legacyStorage: true,
    serverEnvironment: { EXECUTOR_DATA_STEPS: "report" },
    file: "saved-oauth-clients-by-issuer.spec.ts",
    title:
      "Saved OAuth clients move by owner and authorization server: one owner's records for several providers collapse into one client, a record several owners hold goes to the owner its key names, and a record no key names stays",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Legacy rows need a runner-owned database; Cloud cases share one Worker and database.",
      ),
      local: na("Local has one owner; the step's owner resolution is shared with self-host."),
    },
  },
  legacyProfileUndeployedCopy: {
    legacyStorage: true,
    file: "legacy-profile-undeployed-copy.spec.ts",
    title:
      "a local profile of an app that was never deployed becomes an undeployed copy that keeps its account linked and runs with it once deployed",
    targets: {
      local: scheduled,
      "self-host": na(
        "Hosted saves a copy's links without reading its requirements; the hosted copy scenarios cover them.",
      ),
      cloud: na(
        "Legacy rows need a runner-owned database; Cloud cases share one Worker and database.",
      ),
    },
  },
  legacyMcpProfileTargets: {
    legacyStorage: true,
    file: "legacy-mcp-profile-targets.spec.ts",
    title:
      "local MCP connections and grants that ran as a profile run as its accounts after upgrade",
    targets: {
      local: scheduled,
      "self-host": na(
        "Only Local keeps MCP connections in a separate MCP auth database with its own conversion.",
      ),
      cloud: na(
        "Legacy rows need a runner-owned database; Cloud cases share one Worker and database.",
      ),
    },
  },
  legacyTargetlessHostedConnections: {
    fixtures: "actors",
    legacyStorage: true,
    file: "legacy-targetless-connections.spec.ts",
    title:
      "upgrading a hosted database deletes targetless connections with their access rows and then requires a target",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Legacy rows need a runner-owned database; Cloud cases share one Worker and database.",
      ),
      local: na("Local has no organization access rows; the local scenario covers its storage."),
    },
  },
  legacyProfileSchedules: {
    fixtures: "actors",
    legacyStorage: true,
    file: "legacy-profile-schedules.spec.ts",
    title:
      "a hosted member's profiles with other accounts upgrade to copies of the app that keep their schedules, link those accounts for that member and start with empty data",
    targets: {
      "self-host": scheduled,
      local: na("Hosted members and their profiles; local has one subject."),
      cloud: na(
        "Legacy rows need a runner-owned database; Cloud cases share one Worker and database.",
      ),
    },
  },
  legacyProfileScheduleMerge: {
    fixtures: "actors",
    legacyStorage: true,
    file: "legacy-profile-schedules.spec.ts",
    title:
      "a hosted member's profile schedules with the same accounts merge with their history and run with each requirement's own accounts, and ones that would widen a many() requirement (whatever a disabled profile selected), lost their account or their member upgrade paused",
    targets: {
      "self-host": scheduled,
      local: na("Hosted members and their profiles; local has one subject."),
      cloud: na(
        "Legacy rows need a runner-owned database; Cloud cases share one Worker and database.",
      ),
    },
  },
  legacyProfileCopyResumeRetry: {
    fixtures: "actors",
    legacyStorage: true,
    file: "legacy-profile-schedules.spec.ts",
    title:
      "a profile copy's schedule whose resume fails for storage stays paused with its copy still planned, and the next start resumes it but not again the ones the failed pass resumed",
    targets: {
      "self-host": scheduled,
      local: na("Hosted members and their profiles; local has one subject."),
      cloud: na(
        "Legacy rows need a runner-owned database; Cloud cases share one Worker and database.",
      ),
    },
  },
  legacyProfileLinks: {
    fixtures: "actors",
    legacyStorage: true,
    managementApps: ["owner", "admin"],
    file: "legacy-profile-links.spec.ts",
    title:
      "hosted profiles upgrade to members' user links, each account linked to the requirement its profile selected it for",
    targets: {
      "self-host": scheduled,
      local: na(
        "Hosted members and their profiles; local has one subject, and its MCP profile targets scenario upgrades its profiles.",
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
  localScheduleReconcileChoices: {
    file: "local-schedule-accounts.spec.ts",
    title:
      "a local redeploy checks the local schedule against the app evaluated with the account linked to it, and keeps it while no account is linked",
    targets: {
      local: scheduled,
      "self-host": na("Local's single member; hosted members are covered separately."),
      cloud: na("Local's single member; hosted members are covered separately."),
    },
  },
  localScheduleTwoChoices: {
    file: "local-schedule-accounts.spec.ts",
    title:
      "the local Schedules tab enables, pauses, runs and removes the local copy, which runs with the linked account and needs one linked to run",
    targets: {
      local: scheduled,
      "self-host": na("Local dashboard pairing; hosted covers the shared view separately."),
      cloud: na("Local dashboard pairing; hosted covers the shared view separately."),
    },
  },
  localAppAccountAppLinks: {
    file: "local-app-account-app-links.spec.ts",
    title:
      "the local owner links, replaces and unlinks an app account that every call uses, a link outside its requirement's scope or provider is refused, and an app-linked account cannot be deleted",
    targets: {
      local: scheduled,
      "self-host": na("Local app link routes; hosted app links have their own scenarios."),
      cloud: na("Local app link routes; hosted app links have their own scenarios."),
    },
  },
  localAppAccountScopesUnique: {
    file: "local-app-account-app-links.spec.ts",
    title:
      "a local deploy declaring one requirement name as both an app and a user account is refused",
    targets: {
      local: scheduled,
      "self-host": na("Local app link routes; hosted app links have their own scenarios."),
      cloud: na("Local app link routes; hosted app links have their own scenarios."),
    },
  },
  localAppScheduleAppLinks: {
    file: "local-app-account-app-links.spec.ts",
    title:
      "a local app schedule runs with only the app's linked account and waits for one while none is linked",
    targets: {
      local: scheduled,
      "self-host": na("Local app link routes; hosted app links have their own scenarios."),
      cloud: na("Local app link routes; hosted app links have their own scenarios."),
    },
  },
  localAppAccountWebhook: {
    file: "local-app-account-app-links.spec.ts",
    title:
      "linking an account for everyone registers its local app-account webhook source without an actor, an account linked in both scopes stays that one source, and unlinking hands it back to the user, then removes it",
    targets: {
      local: scheduled,
      "self-host": na("Local app link routes; hosted app links have their own scenarios."),
      cloud: na("Local app link routes; hosted app links have their own scenarios."),
    },
  },
  localMcpAppAccountTools: {
    file: "local-app-account-app-links.spec.ts",
    title:
      "a local agent lists, reads, links, unlinks and connects app and user accounts with the Executor app's appAccounts tools, and a connection outside the requirement's scope is refused",
    targets: {
      local: scheduled,
      "self-host": na("Local Executor app tools; hosted has its own appAccounts tool scenarios."),
      cloud: na("Local Executor app tools; hosted has its own appAccounts tool scenarios."),
    },
  },
  localManagedAppLinksFixed: {
    file: "local-app-account-app-links.spec.ts",
    title:
      "the local server's own Executor app keeps its managed account linked: unlinking, replacing or connecting its account through the dashboard or its tools is refused",
    targets: {
      local: scheduled,
      "self-host": na("Only local manages its own Executor app and account."),
      cloud: na("Only local manages its own Executor app and account."),
    },
  },
  localUserWebhookRequirements: {
    file: "local-app-account-app-links.spec.ts",
    title:
      "a local user-account webhook source serves only the requirements its account is linked to, among requirements of one provider, and registers and stops their webhooks as those links change",
    targets: {
      local: scheduled,
      "self-host": na(
        "Local app link routes; hosted user-account webhooks have their own scenario.",
      ),
      cloud: na("Local app link routes; hosted user-account webhooks have their own scenario."),
    },
  },
  localMcpLinkSwappedMidExecution: {
    file: "local-app-account-app-links.spec.ts",
    title:
      "a local scoped connection refuses a call that runs with an account linked in place of the granted one during an execution",
    targets: {
      local: scheduled,
      "self-host": na("Local app link routes; hosted app links have their own scenarios."),
      cloud: na("Local app link routes; hosted app links have their own scenarios."),
    },
  },
  localMcpLinkedAppAccount: {
    file: "local-app-account-app-links.spec.ts",
    title:
      "a local scoped connection calls a tool that uses an app-linked account, and MCP describes only the user accounts",
    targets: {
      local: scheduled,
      "self-host": na("Local app link routes; hosted app links have their own scenarios."),
      cloud: na("Local app link routes; hosted app links have their own scenarios."),
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
    title:
      "A rotated MCP refresh token replayed after the access-token hour is refused alone, and more than a day after its rotation ends every copy",
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
    managementApps: ["owner"],
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
  organizationRemovalWorkflowRefusal: {
    fixtures: "actors",
    file: "organization-removal.spec.ts",
    title:
      "Cloud refuses to remove an organization while one of its app workflows runs, and removes it once the run is terminated",
    targets: {
      cloud: managedCloud,
      "self-host": na("Self-host has a single instance organization and no organization removal."),
      local: na("Local has no hosted organizations and serves no owner removal."),
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
  sharedAccountLinks: {
    fixtures: "actors",
    file: "hosted-shared.spec.ts",
    title: "a shared account linked by a member other than its creator runs that member's calls",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no organization members or shared accounts."),
    },
  },
  remoteMcp: {
    fixtures: "actors",
    file: "hosted-shared.spec.ts",
    title: "a public remote MCP server imports, discovers tools and calls one end to end",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "Cloud egress refuses loopback MCP hosts; remoteMcpCloudflare imports a real public server on Cloud.",
      ),
      local: na("This scenario tests the hosted custom-import endpoint and organization roles."),
    },
  },
  remoteMcpCloudflare: {
    fixtures: "actors",
    file: "hosted-shared.spec.ts",
    title: "Cloud imports Cloudflare's public docs MCP server, discovers tools and calls one",
    targets: {
      cloud: scheduled,
      "self-host": na(
        "remoteMcp covers the journey on self-host against a loopback server, so pull requests never depend on a third-party service.",
      ),
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
  localShutdown: {
    file: "local-shutdown.spec.ts",
    title:
      "local server stops promptly when its whole process group is signalled and keeps its last write",
    targets: {
      local: scheduled,
      "self-host": na(
        "The self-host image runs its collector as a workerd actor, not a child process.",
      ),
      cloud: na("Cloud runs no local server process."),
    },
  },
  localShutdownRemoteMetrics: {
    file: "local-shutdown.spec.ts",
    title: "local server waits for a slow remote metrics collector to acknowledge its final batch",
    targets: {
      local: scheduled,
      "self-host": na("Only the local server bounds its bundled collector's final flush."),
      cloud: na("Cloud runs no local server process."),
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
  cloudChangeEmail: {
    file: "cloud-change-email.spec.ts",
    title: "Cloud changes a user's email only after the current and new addresses return codes",
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

/** Every scenario's plan, typed as plans rather than as the union of each scenario's literal. */
const plans: ReadonlyArray<typeof TestPlan.Type> = Object.values(scenarios);

/** Hosted parity includes every scenario scheduled on both hosted products. */
export const scenariosForSuite = (
  suite: "all" | "hosted",
  cloudMode: CloudMode = "managed",
): ReadonlyArray<typeof TestPlan.Type> =>
  plans
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
