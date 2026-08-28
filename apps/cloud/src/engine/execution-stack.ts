// ---------------------------------------------------------------------------
// Cloud execution-stack seams.
//
// The shared `makeExecutionStack` (@executor-js/api/server) owns the body:
//   makeScopedExecutor -> createExecutionEngine -> EngineDecorator.decorate.
// Used by the protected HTTP API (per-request) and the MCP session DO
// (per-session) so changes to the stack flow to both. Cloud supplies the five
// seam Layers it reads from; the only cloud-specific differences are the
// Cloudflare dynamic-worker code substrate and the usage-metering decorator.
//
//   - DbProvider          -> cloudDbProviderLayer: rebuilds the postgres-js fuma
//                            client per request off the request-scoped
//                            `DbService.db` (Hyperdrive forbids sharing an I/O
//                            handle across requests). The shared factory reads
//                            `db` without caching, preserving per-request rebuild.
//   - PluginsProvider      -> fresh per-request plugins with the Worker env's
//                            WorkOS credentials.
//   - HostConfig           -> `allowLocalNetwork` is config-driven (the
//                            `ALLOW_LOCAL_NETWORK` var; production leaves it unset
//                            -> `false`, the test workers set it `"true"`). It is
//                            an SSRF/private-network guard, so it MUST NOT key off
//                            a test flag. `webBaseUrl` is `VITE_PUBLIC_SITE_URL ??
//                            executor.sh`.
//   - CodeExecutorProvider -> `makeDynamicWorkerExecutor({ loader: env.LOADER })`.
//   - EngineDecorator      -> the billing decorator that meters each execution
//                            to Autumn. BOTH cloud execution planes (the HTTP
//                            `/api/*` executor plane AND the MCP session DO) use
//                            the metered stack (`CloudMeteredExecutionStackLayer`,
//                            ../engine/execution-stack-metered.ts), since the MCP
//                            server is the primary execution surface. Billing
//                            still lives in the cloud app, not this neutral
//                            seams module; the decorator is composed on top.
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { Layer } from "effect";

import {
  CodeExecutorProvider,
  DbProvider,
  HostConfig,
  PluginsProvider,
  collectTables,
} from "@executor-js/api/server";
import { googleCatalogOAuthScopesForPreset } from "@executor-js/plugin-openapi/providers/google";
import { slackMcpUserScopes } from "@executor-js/react/lib/slack-mcp-oauth";
import { makeDynamicWorkerExecutor } from "@executor-js/runtime-dynamic-worker";
import {
  IntegrationSlug,
  type AnyPlugin,
  type FirstPartyOAuthClientConfig,
} from "@executor-js/sdk";

import executorConfig from "../../executor.config";
import { cloudEnterpriseManagedRollout } from "../analytics/ema-rollout";
import { DbService } from "../db/db";
import { cloudDbProviderLayer } from "../db/fuma";

export { makeExecutionStack } from "@executor-js/api/server";

// The executor table set is fixed (plugin-independent), so the per-request
// DbProvider rebuilds the fuma client over the same schema.
export const CloudDbProvider = cloudDbProviderLayer(collectTables());

const cloudPluginFactory = executorConfig.plugins as (deps: {
  readonly workosCredentials: {
    readonly apiKey: string;
    readonly clientId: string;
    readonly apiUrl?: string;
  };
  readonly activeToolkitSlug?: string;
}) => readonly AnyPlugin[];

// Fresh plugin instances per request, carrying the Worker env's WorkOS Vault
// credentials. Matches the old `createScopedExecutor`'s `orgPlugins()`.
export const CloudPluginsProvider: Layer.Layer<PluginsProvider> = Layer.succeed(PluginsProvider)({
  plugins: (context) =>
    cloudPluginFactory({
      workosCredentials: {
        apiKey: env.WORKOS_API_KEY,
        clientId: env.WORKOS_CLIENT_ID,
        apiUrl: env.WORKOS_API_URL,
      },
      activeToolkitSlug:
        context?.mcpResource?.kind === "toolkit" ? context.mcpResource.slug : undefined,
    }),
});

/**
 * The path prefix the cloud mounts its typed API under. SINGLE SOURCE OF TRUTH:
 * `app.ts` passes this as `ExecutorApp.make({ config: { mountPrefix } })`, and
 * `make` derives the OAuth callback (`${webBaseUrl}${CLOUD_MOUNT_PREFIX}/oauth/callback`)
 * from that same `mountPrefix`, so the redirect URI the host sends to providers
 * always matches the route that actually serves the callback — no second knob.
 */
export const CLOUD_MOUNT_PREFIX = "/api" as const;

// Consumer Google launch boundary. Keep this list aligned with the scopes
// submitted for the Executor-owned production app: ordinary Workspace services
// plus Photos, Meet, and Search Console. Admin, Classroom, YouTube, Apps Script,
// BigQuery, and Cloud Resource Manager have materially different audiences or
// provider requirements and remain BYO OAuth. The same scope source builds each
// catalog auth template, preventing picker/start drift.
const GOOGLE_FIRST_PARTY_PRESET_IDS = [
  "google-calendar",
  "google-meet",
  "google-gmail",
  "google-sheets",
  "google-drive",
  "google-docs",
  "google-slides",
  "google-forms",
  "google-tasks",
  "google-people",
  "google-photos-library",
  "google-photos-picker",
  "google-search-console",
] as const;

const GOOGLE_FIRST_PARTY_ALLOWED_SCOPES: readonly string[] = [
  ...new Set([
    ...GOOGLE_FIRST_PARTY_PRESET_IDS.flatMap(googleCatalogOAuthScopesForPreset),
    // Connections created before the full-Gmail review retain this declared
    // scope on reconnect. New Gmail presets request `mail.google.com`.
    "https://www.googleapis.com/auth/gmail.modify",
  ]),
];

// Executor-owned provider apps, enabled per provider by setting BOTH env vars
// (id + secret). Each provider-side registration must list
// `${VITE_PUBLIC_SITE_URL}/api/oauth/callback` as its callback; the org slug
// travels inside OAuth `state`, so the single static callback serves every org.
//
// The endpoint URLs default to the real provider; the `_AUTHORIZE_URL` /
// `_TOKEN_URL` overrides exist so tests and dev instances can point the app at
// an emulated provider (`@executor-js/emulate`) and run the complete flow.
// Production leaves them unset.
export const cloudFirstPartyOAuthClients = (): readonly FirstPartyOAuthClientConfig[] => [
  ...(env.FIRST_PARTY_GITHUB_CLIENT_ID && env.FIRST_PARTY_GITHUB_CLIENT_SECRET
    ? [
        {
          name: "github",
          authorizationUrl:
            env.FIRST_PARTY_GITHUB_AUTHORIZE_URL ?? "https://github.com/login/oauth/authorize",
          tokenUrl:
            env.FIRST_PARTY_GITHUB_TOKEN_URL ?? "https://github.com/login/oauth/access_token",
          clientId: env.FIRST_PARTY_GITHUB_CLIENT_ID,
          clientSecret: env.FIRST_PARTY_GITHUB_CLIENT_SECRET,
          integrations: [IntegrationSlug.make("github_rest")],
          // GitHub App user access tokens do not use classic OAuth scopes;
          // their capabilities come from the app's registered permissions.
          authorizationScopes: [],
        },
      ]
    : []),
  ...(env.FIRST_PARTY_GOOGLE_CLIENT_ID && env.FIRST_PARTY_GOOGLE_CLIENT_SECRET
    ? [
        {
          name: "google",
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          clientId: env.FIRST_PARTY_GOOGLE_CLIENT_ID,
          clientSecret: env.FIRST_PARTY_GOOGLE_CLIENT_SECRET,
          allowedScopes: GOOGLE_FIRST_PARTY_ALLOWED_SCOPES,
          // Withdrawn from the connect picker: no new connection is offered the
          // Executor-owned Google app. The entry stays declared on purpose —
          // every connection already minted against it keeps refreshing and
          // reconnecting through it. Deleting this block, or unsetting the env
          // vars, would strand those connections instead.
          unlisted: true,
        },
      ]
    : []),
  ...(env.FIRST_PARTY_SLACK_CLIENT_ID && env.FIRST_PARTY_SLACK_CLIENT_SECRET
    ? [
        {
          name: "slack",
          authorizationUrl: "https://slack.com/oauth/v2_user/authorize",
          tokenUrl: "https://slack.com/api/oauth.v2.user.access",
          resource: "https://mcp.slack.com",
          clientId: env.FIRST_PARTY_SLACK_CLIENT_ID,
          clientSecret: env.FIRST_PARTY_SLACK_CLIENT_SECRET,
          integrations: [IntegrationSlug.make("slack")],
          allowedScopes: slackMcpUserScopes,
        },
      ]
    : []),
];

export const CloudHostConfig: Layer.Layer<HostConfig> = Layer.sync(HostConfig, () => ({
  // SSRF / private-network egress guard. Config-driven, NOT a test flag:
  // production leaves `ALLOW_LOCAL_NETWORK` unset so the guard stays ON (`false`);
  // the e2e dev-server env opts in with `"true"` so in-scenario fixture
  // servers on localhost are reachable. See `hosted-http-client.ts`.
  allowLocalNetwork: env.ALLOW_LOCAL_NETWORK === "true",
  webBaseUrl: env.VITE_PUBLIC_SITE_URL ?? "https://executor.sh",
  oauthCallbackPath: `${CLOUD_MOUNT_PREFIX}/oauth/callback`,
  // WorkOS Vault is cloud's credential storage implementation detail, not a
  // user-selectable provider surface.
  exposeCredentialProviders: false,
  firstPartyOAuthClients: cloudFirstPartyOAuthClients(),
  // Enterprise-managed authorization ships behind a PostHog flag. Cloud is the
  // one host with a flag service, so cloud is the one host that installs a
  // gate; everywhere else the seam stays empty and the profile is attempted as
  // before. Gating happens at connect only — see the SDK contract.
  enterpriseManagedRollout: cloudEnterpriseManagedRollout(),
}));

export const CloudCodeExecutorProvider: Layer.Layer<CodeExecutorProvider> = Layer.sync(
  CodeExecutorProvider,
  () => makeDynamicWorkerExecutor({ loader: env.LOADER }),
);

/**
 * The four billing-free execution-stack seams (db / plugins / host-config /
 * code-executor): everything `makeExecutionStack` reads EXCEPT the
 * `EngineDecorator`. Both cloud planes compose this with the billing decorator
 * via `CloudMeteredExecutionStackLayer` (../engine/execution-stack-metered.ts);
 * exported so that overlay builds over the SAME four seams. There is no neutral
 * no-op-decorator variant anymore: every cloud execution meters.
 */
export const CloudExecutionSeamsLayer: Layer.Layer<
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider,
  never,
  DbService
> = Layer.mergeAll(
  CloudDbProvider,
  CloudPluginsProvider,
  CloudHostConfig,
  CloudCodeExecutorProvider,
);
