// ---------------------------------------------------------------------------
// Shared scoped-executor factory + the host seams it reads from.
//
// Cloud and self-host historically hand-rolled an identical `createScopedExecutor`:
// read the DB handle from a host service, build fresh per-request plugins, build a
// hosted HTTP client, build the `[userOrgScope, orgScope]` scope stack (P1), and
// call `createExecutor({...})` with a byte-identical option shape. The ONLY real
// differences were the DB source/lifetime, the plugin instances, and two host
// config scalars (`allowLocalNetwork`, `webBaseUrl`).
//
// `makeScopedExecutor` owns that common body. The per-host knobs are injected
// through three Effect seams:
//   - `DbProvider` (P2a, executor-fuma-db.ts) — the `{ db }` handle. Cloud's
//     Layer rebuilds the postgres-js fuma client per request off the
//     request-scoped `DbService`; self-host's Layer projects its long-lived
//     handle. `makeScopedExecutor` just reads `db` — it never caches a handle,
//     so both lifetimes are preserved by the Layer the host supplies.
//   - `PluginsProvider` — the plugin array. Cloud injects per-request WorkOS
//     credentials; self-host returns the plain plugin list.
//   - `HostConfig` — `allowLocalNetwork` (drives the hosted HTTP client guard)
//     and `webBaseUrl` (the core-tools elicitation base URL).
//
// This is host-composition machinery: it lives in `@executor-js/api/server`
// (the host surface), not in `@executor-js/sdk` (the plugin-author contract).
// `createExecutor`/`Executor` and the branded `Tenant`/`Subject` ids stay in the
// SDK and are imported from there.
//
// v2: the executor binds to `{ tenant, subject }` instead of a scope stack. The
// org id is the tenant (the isolation partition that owns the catalog); the
// account id is the acting subject (drives `owner: "user"` rows). The old
// `makeUserOrgScopeStack([userOrgScope, orgScope])` is gone.
// ---------------------------------------------------------------------------

import { Context, Effect, Option } from "effect";

import type { McpResource } from "@executor-js/host-mcp";
import {
  createExecutor,
  Subject,
  Tenant,
  type AnyPlugin,
  type Executor,
  type StorageFailure,
} from "@executor-js/sdk";
import { makeHostedFetch, makeHostedHttpClientLayer } from "@executor-js/sdk/host-internal";

import { DbProvider } from "./executor-fuma-db";

// ---------------------------------------------------------------------------
// HostConfig seam — the two host scalars that vary the `createExecutor` options.
// ---------------------------------------------------------------------------

export interface HostConfigShape {
  /**
   * Whether the hosted HTTP client may dial private/loopback addresses. Each
   * host reads it from config (`EXECUTOR_ALLOW_LOCAL_NETWORK` / `ALLOW_LOCAL_NETWORK`);
   * production hosts leave it off. Drives `makeHostedHttpClientLayer`.
   */
  readonly allowLocalNetwork: boolean;
  /**
   * Base URL of the executor's web UI. Threaded into `coreTools.webBaseUrl` so
   * `connections.createHandoff` can point the user at
   * `${webBaseUrl}/integrations/{slug}?addAccount=1`.
   *
   * Optional: when a host can't know its public URL at boot (a Worker has no
   * static URL var), leave it unset and `makeScopedExecutor` falls back to the
   * current request's origin (`RequestWebOrigin`). An explicit value always wins.
   */
  readonly webBaseUrl?: string;
  /**
   * Public path of THIS host's OAuth callback route — the host's API
   * `mountPrefix` joined with the global `/oauth/callback` route
   * (packages/core/api/src/oauth/api.ts). The redirect URI sent to providers is
   * `${webBaseUrl}${oauthCallbackPath}`.
   *
   * Every host must set this explicitly. `ExecutorApp.make` derives it from the
   * same `config.mountPrefix` that prefixes the API router and injects it here
   * for protected HTTP requests. Direct MCP session stacks also read HostConfig,
   * so the host-provided value is the only valid source of truth.
   */
  readonly oauthCallbackPath: string;
  /**
   * Whether Executor's built-in agent tools should expose credential provider
   * discovery. Local/self-host can use this for 1Password/keychain style
   * provider browsing; cloud hides it because WorkOS Vault is an implementation
   * detail of credential storage.
   */
  readonly exposeCredentialProviders?: boolean;
}

export class HostConfig extends Context.Service<HostConfig, HostConfigShape>()(
  "@executor-js/sdk/HostConfig",
) {}

// ---------------------------------------------------------------------------
// RequestWebOrigin seam — the public origin of the in-flight request
// (`https://host[:port]`), used to derive `webBaseUrl` when no explicit one is
// configured. Provided per request by the host's request pipeline (the shared
// `makeExecutionStackMiddleware` for the HTTP API; the session DO for MCP).
// Read OPTIONALLY via `Effect.serviceOption`, so it never enters
// `makeScopedExecutor`'s `R` channel — non-request callers (CLI, tests) simply
// fall through to the configured value.
// ---------------------------------------------------------------------------

export interface RequestWebOriginShape {
  readonly origin: string;
}

export class RequestWebOrigin extends Context.Service<RequestWebOrigin, RequestWebOriginShape>()(
  "@executor-js/api/RequestWebOrigin",
) {}

// ---------------------------------------------------------------------------
// RequestOrgSlug seam — the URL slug of the org the executor is bound to for
// this request. Threaded into `coreTools.orgSlug` so browser-handoff URLs open
// the right org's console (`${webBaseUrl}/<slug>/integrations/...`) instead of
// a bare path the browser would canonicalize to its last-active org. Like
// `RequestWebOrigin` it is provided per request by the host's pipeline (the
// HTTP middleware from the resolved principal; the MCP session DO from the
// stored session meta) and read OPTIONALLY, so non-request callers (CLI, tests,
// local) simply emit a slug-less URL.
// ---------------------------------------------------------------------------

export interface RequestOrgSlugShape {
  readonly slug: string;
}

export class RequestOrgSlug extends Context.Service<RequestOrgSlug, RequestOrgSlugShape>()(
  "@executor-js/api/RequestOrgSlug",
) {}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const isLoopbackOrigin = (origin: string): boolean => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: new URL() throws on malformed origin; no Effect equivalent for this sync parse
  try {
    const parsed = new URL(origin);
    return LOOPBACK_HOSTNAMES.has(parsed.hostname);
  } catch {
    return false;
  }
};

export const resolveScopedWebBaseUrl = (input: {
  readonly configuredWebBaseUrl?: string;
  readonly requestOrigin?: string;
}): string | undefined => {
  if (input.requestOrigin && isLoopbackOrigin(input.requestOrigin)) return input.requestOrigin;
  return input.configuredWebBaseUrl ?? input.requestOrigin;
};

export const buildOAuthRedirectUri = (input: {
  readonly webBaseUrl: string | undefined;
  readonly oauthCallbackPath: string;
}): string | undefined => {
  if (!input.webBaseUrl) return undefined;
  return new URL(input.oauthCallbackPath, input.webBaseUrl).toString();
};

// ---------------------------------------------------------------------------
// PluginsProvider seam — the per-host (and possibly per-request) plugin array.
//
// Returns an Effect so a host that needs request-scoped credentials (cloud reads
// WorkOS creds from the Worker env) can build fresh plugin instances each call,
// while a host with static plugins (self-host) just returns a constant array.
// ---------------------------------------------------------------------------

export interface PluginsProviderContext {
  readonly mcpResource?: McpResource;
}

export interface PluginsProviderShape {
  readonly plugins: (context?: PluginsProviderContext) => readonly AnyPlugin[];
}

export class PluginsProvider extends Context.Service<PluginsProvider, PluginsProviderShape>()(
  "@executor-js/sdk/PluginsProvider",
) {}

// ---------------------------------------------------------------------------
// makeScopedExecutor — the shared per-(user, org) executor body.
//
// v2 binds the executor to `{ tenant, subject }`: the org id is the tenant (the
// isolation partition owning the catalog), the account id is the acting subject
// (drives `owner: "user"` rows). The old `[userOrgScope, orgScope]` scope stack
// is gone — org-wide credentials are `owner: "org"`, a member's own are
// `owner: "user"`, both filed under the one tenant.
//
// The `createExecutor` option shape below mirrors the bodies it replaces, with
// `scopes` swapped for `tenant` + `subject`: `{ tenant, subject, db, plugins,
// httpClientLayer, onElicitation: "accept-all", coreTools: { webBaseUrl } }`.
//
// `TPlugins` is a caller-supplied phantom: the `PluginsProvider` seam returns an
// erased `AnyPlugin[]` (a Context value can't carry the tuple type), so the host
// names its plugin tuple (`makeScopedExecutor<SelfHostPlugins>(...)`) to recover
// the `Executor<TPlugins>` shape with the plugin extension namespaces
// (`.openapi`, `.graphql`, …) that `providePluginExtensions` and callers read.
// The default keeps the un-narrowed `Executor` for hosts that don't care.
// ---------------------------------------------------------------------------

export const makeScopedExecutor = <
  const TPlugins extends readonly AnyPlugin[] = readonly AnyPlugin[],
>(
  accountId: string,
  organizationId: string,
  // Kept in the signature for parity with `makeExecutionStack` /
  // `EngineStackIdentity` (the engine decorator still wants it); not part of the
  // v2 executor binding, which is `{ tenant, subject }` only.
  _organizationName: string,
  options?: { readonly plugins?: PluginsProviderContext },
): Effect.Effect<Executor<TPlugins>, StorageFailure, DbProvider | PluginsProvider | HostConfig> =>
  Effect.gen(function* () {
    const { db, blobs } = yield* DbProvider;
    const { plugins: pluginsFactory } = yield* PluginsProvider;
    const config = yield* HostConfig;
    // Explicit config wins; otherwise fall back to the request origin if a host
    // provided one (HTTP middleware / MCP session DO). Stays `undefined` for
    // non-request callers — `coreTools.webBaseUrl` is optional and only the
    // browser-handoff tools require it (they fail clearly if it's truly absent).
    const requestOrigin = yield* Effect.serviceOption(RequestWebOrigin);
    const webBaseUrl = resolveScopedWebBaseUrl({
      configuredWebBaseUrl: config.webBaseUrl,
      requestOrigin: Option.match(requestOrigin, {
        onNone: () => undefined,
        onSome: (o) => o.origin,
      }),
    });
    // The bound org's URL slug, when the host's request pipeline provided one.
    // Stays `undefined` for non-request callers — `coreTools` then emits bare
    // (org-less) handoff URLs, which org-scoped hosts canonicalize client-side.
    const orgSlug = Option.match(yield* Effect.serviceOption(RequestOrgSlug), {
      onNone: () => undefined,
      onSome: (o) => o.slug,
    });

    // EXPLICIT OAuth wiring: the redirect callback the host serves and sends to
    // providers is `${webBaseUrl}${oauthCallbackPath}` — the host's API mount
    // prefix joined with the global `/oauth/callback` route
    // (packages/core/api/src/oauth/api.ts). The base is derived from the SAME
    // source as `webBaseUrl` (an explicit `HostConfig.webBaseUrl`, else the
    // in-flight request origin). The PATH is required in HostConfig so direct MCP
    // session stacks cannot silently fall back to an unmounted callback. When no
    // base is known (a non-HTTP caller), `redirectUri` stays `undefined` and the
    // OAuth service fails loudly on redirect flows rather than silently using
    // localhost.
    const redirectUri = buildOAuthRedirectUri({
      webBaseUrl,
      oauthCallbackPath: config.oauthCallbackPath,
    });

    const plugins = pluginsFactory(options?.plugins);
    const hostedHttpOptions = {
      allowLocalNetwork: config.allowLocalNetwork,
    };
    const httpClientLayer = makeHostedHttpClientLayer(hostedHttpOptions);
    const hostedFetch = makeHostedFetch(hostedHttpOptions);

    // The org id is the tenant (catalog partition); the account id is the acting
    // subject (drives `owner: "user"` rows). `organizationName` is no longer part
    // of the executor binding — it stays on `AuthContext` for display.
    const executor = yield* createExecutor({
      tenant: Tenant.make(organizationId),
      subject: Subject.make(accountId),
      db,
      blobs,
      plugins,
      httpClientLayer,
      fetch: hostedFetch,
      onElicitation: "accept-all",
      redirectUri,
      oauthCallbackStateOrgSlug: orgSlug,
      coreTools: {
        webBaseUrl,
        orgSlug,
        includeProviders: config.exposeCredentialProviders ?? true,
      },
    });
    // The seam erases the plugin tuple type; the caller re-narrows via the
    // `TPlugins` phantom. Runtime shape is identical to a typed
    // `createExecutor({ plugins })` call.
    return executor as Executor<TPlugins>;
  });
