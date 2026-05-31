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
// `createExecutor`/`Executor` and the `makeUserOrgScopeStack` scope-id contract
// stay in the SDK and are imported from there.
// ---------------------------------------------------------------------------

import { Context, Effect, Option } from "effect";

import {
  createExecutor,
  makeUserOrgScopeStack,
  type AnyPlugin,
  type Executor,
  type StorageFailure,
} from "@executor-js/sdk";
import { makeHostedHttpClientLayer } from "@executor-js/sdk/host-internal";

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
   * `secrets.create` can point the user at `${webBaseUrl}/secrets?...`.
   *
   * Optional: when a host can't know its public URL at boot (a Worker has no
   * static URL var), leave it unset and `makeScopedExecutor` falls back to the
   * current request's origin (`RequestWebOrigin`). An explicit value always wins.
   */
  readonly webBaseUrl?: string;
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
// PluginsProvider seam — the per-host (and possibly per-request) plugin array.
//
// Returns an Effect so a host that needs request-scoped credentials (cloud reads
// WorkOS creds from the Worker env) can build fresh plugin instances each call,
// while a host with static plugins (self-host) just returns a constant array.
// ---------------------------------------------------------------------------

export interface PluginsProviderShape {
  readonly plugins: () => readonly AnyPlugin[];
}

export class PluginsProvider extends Context.Service<PluginsProvider, PluginsProviderShape>()(
  "@executor-js/sdk/PluginsProvider",
) {}

// ---------------------------------------------------------------------------
// makeScopedExecutor — the shared per-(user, org) executor body.
//
// Scope stack is `[userOrgScope, orgScope]` (innermost first) from
// `makeUserOrgScopeStack` (P1): the user-within-org scope id bakes in the org id
// so the same user in a different org gets a distinct scope row; OAuth token
// writes target the inner scope, org-wide credentials the outer.
//
// The `createExecutor` option shape below is byte-identical to the bodies it
// replaces: `{ scopes, db, plugins, httpClientLayer, onElicitation: "accept-all",
// coreTools: { webBaseUrl } }`.
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
  organizationName: string,
): Effect.Effect<Executor<TPlugins>, StorageFailure, DbProvider | PluginsProvider | HostConfig> =>
  Effect.gen(function* () {
    const { db } = yield* DbProvider;
    const { plugins: pluginsFactory } = yield* PluginsProvider;
    const config = yield* HostConfig;
    // Explicit config wins; otherwise fall back to the request origin if a host
    // provided one (HTTP middleware / MCP session DO). Stays `undefined` for
    // non-request callers — `coreTools.webBaseUrl` is optional and only the
    // browser-handoff tools require it (they fail clearly if it's truly absent).
    const requestOrigin = yield* Effect.serviceOption(RequestWebOrigin);
    const webBaseUrl =
      config.webBaseUrl ??
      Option.match(requestOrigin, { onNone: () => undefined, onSome: (o) => o.origin });

    const plugins = pluginsFactory();
    const httpClientLayer = makeHostedHttpClientLayer({
      allowLocalNetwork: config.allowLocalNetwork,
    });

    // The account id is the first segment of the persisted `user-org:` scope key
    // (its namespace name is the contract; `makeUserOrgScopeStack` keeps it).
    const scopes = makeUserOrgScopeStack(accountId, organizationId, organizationName);

    const executor = yield* createExecutor({
      scopes,
      db,
      plugins,
      httpClientLayer,
      onElicitation: "accept-all",
      coreTools: {
        webBaseUrl,
      },
    });
    // The seam erases the plugin tuple type; the caller re-narrows via the
    // `TPlugins` phantom. Runtime shape is identical to a typed
    // `createExecutor({ plugins })` call.
    return executor as Executor<TPlugins>;
  });
