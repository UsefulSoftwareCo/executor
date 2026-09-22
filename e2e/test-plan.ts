/** A target's applicability is explicit. Missing evidence never implies N/A. */
import { Schema } from "effect";
import type { Target } from "./report-model.ts";

/** Scheduled tests need a real result; other dispositions explain why none is expected. */
export const TargetPlan = Schema.Union([
  Schema.Struct({ status: Schema.Literal("scheduled") }),
  Schema.Struct({ status: Schema.Literal("not-applicable"), reason: Schema.NonEmptyString }),
  Schema.Struct({ status: Schema.Literal("not-run"), reason: Schema.NonEmptyString }),
]);
/** Snapshot this plan in a report so later configuration changes cannot rewrite its meaning. */
export const TestPlan = Schema.Struct({
  file: Schema.String,
  title: Schema.String,
  targets: Schema.Struct({ "self-host": TargetPlan, local: TargetPlan, cloud: TargetPlan }),
});
const scheduled = { status: "scheduled" } as const;
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
  emptyStateRecovery: {
    file: "empty-state-recovery.spec.ts",
    title: "Empty states preserve drafts and respect app permissions",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted authoring and membership scenario."),
    },
  },
  emptyAccountSearch: {
    file: "empty-state-recovery.spec.ts",
    title: "Empty account searches can be cleared without losing selections",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Shared picker exercised through hosted connections."),
    },
  },
  emptyStateMcp: {
    file: "empty-state-mcp.spec.ts",
    title: "Empty organization consent offers a valid self-host recovery",
    targets: {
      "self-host": scheduled,
      cloud: na("Cloud routes new users through team setup."),
      local: na("Local uses pairing."),
    },
  },
  emptyStateBilling: {
    file: "empty-state-billing.spec.ts",
    title: "Empty billing catalog can be refreshed",
    targets: {
      "self-host": na("Billing is cloud only."),
      cloud: scheduled,
      local: na("Billing is cloud only."),
    },
  },
  emptyStates: {
    file: "empty-states.spec.ts",
    title: "Empty states guide first use and recover from filters",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted role and group flows; shared presentation is covered on self-host."),
    },
  },
  sourceHighlighting: {
    file: "source-highlighting.spec.ts",
    title: "Source browser highlights CSS, Markdown, JSON, and HTML files",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("The shared source browser is exercised through hosted organization routes."),
    },
  },
  appFilters: {
    file: "app-filters.spec.ts",
    title: "App filters retain cards through loading, failure and retry",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no group or access filters."),
    },
  },
  sdkQueryBudgets: {
    file: "sdk-query-budgets.spec.ts",
    title: "SDK batches invocation accounts and finished workflow history",
    targets: {
      "self-host": scheduled,
      cloud: na("This query budget reads the self-host Motel collector."),
      local: na("This scenario uses hosted organization routes."),
    },
  },
  toolAccountContext: {
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
    title: "Dev tools list and switch to actual organization members",
    targets: {
      "self-host": scheduled,
      cloud: na(
        "The shared picker is exercised through the full self-host development entry point.",
      ),
      local: na("Local has pairing instead of organization members."),
    },
  },
  groupAuthoring: {
    file: "resource-access.spec.ts",
    title: "Groups protect app drafts and independent copies",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no organization group policy."),
    },
  },
  resourceIsolation: {
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
    file: "resource-sharing.spec.ts",
    title: "Group sharing forms retain drafts and recover stale edits on desktop and mobile",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no organization sharing policy."),
    },
  },
  resourceAccess: {
    file: "resource-access.spec.ts",
    title: "Groups enforce private apps and complete array credential access",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no organization sharing policy."),
    },
  },
  publishingDialog: {
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
  feedback: {
    file: "feedback.spec.ts",
    title: "Cloud feedback enforces its API contract and reports disabled ingestion",
    targets: {
      cloud: scheduled,
      "self-host": na("PostHog feedback belongs to Cloud."),
      local: na("PostHog feedback belongs to Cloud."),
    },
  },
  groupFormErrors: {
    file: "groups.spec.ts",
    title: "Group forms show field errors and retain drafts through failed saves",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no organization groups."),
    },
  },
  passwordRefresh: {
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
    file: "groups.spec.ts",
    title: "Groups persist atomic membership edits and enforce current admin permissions",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no organizations or groups."),
    },
  },
  groupsIsolation: {
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
  cloudCatalogInstall: {
    file: "cloud-compiler.spec.ts",
    title: "Cloud catalog installs Axiom through the browser and reaches account setup",
    targets: {
      cloud: scheduled,
      "self-host": na("This scenario measures the Cloud catalog installation path."),
      local: na("This scenario measures the Cloud catalog installation path."),
    },
  },
  cloudCompilerDependencies: {
    file: "cloud-compiler.spec.ts",
    title: "Cloud compiler installs imported packages and preserves source manifests",
    targets: {
      cloud: scheduled,
      "self-host": na("This scenario exercises the Cloud compiler dependency resolver."),
      local: na("This scenario exercises the Cloud compiler dependency resolver."),
    },
  },
  requestTiming: {
    file: "request-timing.spec.ts",
    title: "Cloud request timings correlate browser resources with the server trace",
    targets: {
      cloud: scheduled,
      "self-host": na("Cloudflare lifecycle spans belong to the cloud host."),
      local: na("Cloudflare lifecycle spans belong to the cloud host."),
    },
  },
  oauthUrlPolicy: {
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
  appCopies: {
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
  deploymentLinks: {
    file: "deployment-links.spec.ts",
    title: "Cloud product links follow the deployment origin",
    targets: {
      cloud: scheduled,
      "self-host": na("Self-host uses public docs and does not serve the marketing site."),
      local: na("Local uses public docs and does not serve the marketing site."),
    },
  },
  teamCreateRoute: {
    file: "team-create-route.spec.ts",
    title: "Team setup routing waits for membership and redirects existing members",
    targets: cloudOnboarding,
  },
  signInEntry: {
    file: "sign-in-entry.spec.ts",
    title: "Sign-in completion selects destinations before loading a page",
    targets: cloudOnboarding,
  },
  rootEntryLoading: {
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
    file: "account-connection-query.spec.ts",
    title: "Account connection stays in the app and loads its tools without a page refresh",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This journey checks hosted account connection and app query invalidation."),
    },
  },
  appAccountPicker: {
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
    file: "oauth-client-recovery.spec.ts",
    title:
      "Rejected OAuth clients remain editable and replacements commit only after successful sign-in",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Hosted callback routing and saved-client management."),
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
  oauthClientForm: {
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
    file: "oauth-client-credentials.spec.ts",
    title: "Client credentials connects without redirects and renews tokens with provider settings",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback token service."),
      local: na("Exercises shared OAuth through the hosted API."),
    },
  },
  oauthProviderConfig: {
    file: "oauth-provider-config.spec.ts",
    title: "OAuth provider code controls scopes, resources, and client authentication",
    targets: {
      "self-host": scheduled,
      cloud: na("Uses a scoped loopback OAuth issuer."),
      local: na("Exercises shared OAuth through the hosted API."),
    },
  },
  oauthClientSetup: {
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
    file: "query-refresh.spec.ts",
    title: "Dashboard refresh preserves drafts through failed reads and recovery",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This journey checks hosted query refresh after organization identity resolution."),
    },
  },
  membersRefresh: {
    file: "query-refresh.spec.ts",
    title: "Dashboard members retain their rows and invitation draft through refresh errors",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no hosted organization membership."),
    },
  },
  sessionHint: {
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
    title: "Local app navigation keeps a stable loading panel through live reads",
    targets: {
      local: scheduled,
      "self-host": na("This journey checks local pairing and live app reads."),
      cloud: na("This journey checks local pairing and live app reads."),
    },
  },
  appDetailLoading: {
    file: "app-detail-loading.spec.ts",
    title: "App detail navigation preserves its frame while metadata and tools load",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This journey checks hosted app metadata requests."),
    },
  },
  dashboardLoading: {
    file: "dashboard-loading.spec.ts",
    title: "Dashboard loading shows content skeletons without auth or organization gates",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This journey checks hosted session entry and organization references."),
    },
  },
  frameworkAuthoring: {
    file: "framework-authoring.spec.ts",
    title: "framework discovery deploys its checked example with optimistic updates and rollback",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Hosted discovery-to-browser journey; local skills have separate MCP coverage."),
    },
  },
  appPendingWrites: {
    file: "app-pending-writes.spec.ts",
    title: "closing an app warns about queued optimistic deletes until writes settle",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("The shared browser client is exercised through hosted app authentication."),
    },
  },
  appUi: {
    file: "app-ui.spec.ts",
    title: "private app bookmarks authenticate and execute through the hosted runtime",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted Better Auth and organization routes."),
    },
  },
  appReload: {
    file: "app-reload.spec.ts",
    title: "hosted apps reload on deployment and recover missed version notifications",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local already has a deployment watcher; this covers hosted app sessions."),
    },
  },
  appTailwind: {
    file: "app-tailwind.spec.ts",
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
    file: "app-observability.spec.ts",
    title: "app query traces connect browser, streamed host work, runtime and React commits",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted deployment and app authentication."),
    },
  },
  appDomainStatus: {
    file: "app-domain-status.spec.ts",
    title: "app domains show pending setup, retry failures and expose only ready links",
    targets: {
      cloud: scheduled,
      "self-host": na("Cloud provisions team certificates; self-host operators manage TLS."),
      local: na("Local app origins do not provision cloud certificates."),
    },
  },
  appUiFailures: {
    file: "app-ui-failures.spec.ts",
    title: "private app failures stay visible and recover without losing drafts",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app deployment and browser authentication."),
    },
  },
  appUiFailureTelemetry: {
    file: "app-ui-failures.spec.ts",
    title: "private app crash reports reach the host collector before authored telemetry starts",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app deployment and browser authentication."),
    },
  },
  executorKeyAccount: {
    file: "executor-key-account.spec.ts",
    title: "Executor upserts and selects the managed user API key account",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local uses its configured instance API key."),
    },
  },
  sharedAuthorization: {
    file: "shared-authorization.spec.ts",
    title: "MCP and API authorization share exact tool selection and live grant restrictions",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario checks hosted API and MCP parity."),
    },
  },
  patMcp: {
    file: "pat-mcp.spec.ts",
    title: "PATs authenticate MCP with current access, approvals and live revocation",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local uses its instance credential."),
    },
  },
  namedApiKeys: {
    file: "named-api-keys.spec.ts",
    title: "Personal access tokens inherit user permissions and support expiry and revocation",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local uses its instance key."),
    },
  },
  userApiKey: {
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
  localWorkflows: {
    file: "local-workflows.spec.ts",
    title: "local app workflows execute through the authenticated SDK HTTP surface",
    targets: {
      local: scheduled,
      "self-host": na("Hosted workflow coverage uses organization routes."),
      cloud: na("Hosted workflow coverage uses organization routes."),
    },
  },
  workflows: {
    file: "workflows.spec.ts",
    title: "app workflows pin deployments and accounts, retry steps, and enforce permissions",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app and account management routes."),
    },
  },
  workflowTimeout: {
    file: "workflow-durability.spec.ts",
    title: "workflow timeouts roll back confirmed writes without late commits",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app management routes."),
    },
  },
  workflowSleep: {
    file: "workflow-durability.spec.ts",
    title: "workflow sleep preserves completed mutations and resumes execution",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted app management routes."),
    },
  },
  appContext: {
    file: "app-context.spec.ts",
    title: "standalone app handlers receive fresh accounts and scoped storage",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario uses hosted account and webhook management routes."),
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
  appSkills: {
    file: "app-skills.spec.ts",
    title: "app skills remain static, authorized and pinned across deployments",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario tests hosted membership; local skills are covered through MCP."),
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
    file: "hosted-schedule-browser.spec.ts",
    title: "hosted schedule controls enable, run, approve and pause through the browser",
    targets: {
      cloud: scheduled,
      "self-host": scheduled,
      local: na("Local pairing drives the same shared controls in its own scenario."),
    },
  },
  scheduleDiscoveryStates: {
    file: "hosted-schedule-browser.spec.ts",
    title: "schedule discovery distinguishes loading, failure and confirmed empty results",
    targets: {
      cloud: scheduled,
      "self-host": scheduled,
      local: na("The shared schedule view is exercised through the hosted API."),
    },
  },

  scheduleLoading: {
    file: "hosted-schedule-browser.spec.ts",
    title: "schedule tab keeps its layout through metadata, settings and discovery loading",
    targets: {
      cloud: scheduled,
      "self-host": scheduled,
      local: na("The shared schedule view is exercised through the hosted API."),
    },
  },
  scheduleAccountSetup: {
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
    file: "claude-mcp.spec.ts",
    title: "Claude Code connects through /mcp, browser authentication and a real tool call",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario tests hosted organization consent, which Local does not have."),
    },
  },
  mcpProtocol: {
    file: "mcp-server.spec.ts",
    title: "MCP OAuth grants support discovery, execution, refresh and revocation",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario tests hosted organization consent, which Local does not have."),
    },
  },
  organizationRemoval: {
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
    file: "hosted-shared.spec.ts",
    title: "hosted roles, account connection, discovery and invocation agree",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("Local has no hosted organizations or membership roles."),
    },
  },
  remoteMcp: {
    file: "hosted-shared.spec.ts",
    title: "a public remote MCP server imports, discovers tools and calls one end to end",
    targets: {
      "self-host": scheduled,
      cloud: scheduled,
      local: na("This scenario tests the hosted custom-import endpoint and organization roles."),
    },
  },
  password: {
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
export const scenariosForSuite = (suite: "all" | "hosted") =>
  Object.values(scenarios).filter(
    (scenario) =>
      suite === "all" ||
      (scenario.targets["self-host"].status === "scheduled" &&
        scenario.targets.cloud.status === "scheduled"),
  );

/** Select only explicitly scheduled files for a target; cloud scale stays disabled. */
export const filesForTarget = (target: typeof Target.Type, suite: "all" | "hosted") => [
  ...new Set(
    scenariosForSuite(suite)
      .filter((scenario) => scenario.targets[target].status === "scheduled")
      .map((scenario) => `e2e/tests/${scenario.file}`),
  ),
];

/** Keep scenario-level target declarations when several targets share one test file. */
export const patternForTarget = (
  target: typeof Target.Type,
  suite: "all" | "hosted",
  filter: string,
): string => {
  const titles = scenariosForSuite(suite)
    .filter((scenario) => scenario.targets[target].status === "scheduled")
    .map((scenario) => scenario.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (titles.length === 0) return "(?!)";
  return `^(?=[\\s\\S]*(?:${filter || ".*"}))[\\s\\S]*(?:${titles.join("|")})$`;
};
