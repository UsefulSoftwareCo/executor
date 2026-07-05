import { Effect } from "effect";

import {
  makeSelfHostApps,
  BindingError,
  connectionNameForScope,
  type ClientResolver,
  type SelfHostApps,
} from "@executor-js/plugin-apps/api";

import { resolveDataDir } from "./config";
import { makeCtxResolver } from "./apps-resolver";

// ---------------------------------------------------------------------------
// Self-host wiring for the apps subsystem.
//
// The apps subsystem (packages/plugins/apps) owns custom tools, durable
// workflows, ui views and skills behind five substrate-neutral seams. This
// module builds it ONCE (a boot-time singleton) so the SAME runtime is shared
// by (a) the source plugin added to the executor plugin list in
// executor.config.ts, so published tools are real catalog citizens, (b) the
// MCP registration on the real MCP server, and (c) the HTTP surface. `plugins()`
// runs per request and re-instantiates the plugin, but every instance closes
// over this one runtime, so there is one published-descriptor store, one
// journal, one scheduler across the process.
//
// The `ClientResolver` is the one seam that reaches real integrations (the
// platform invoke path: credentials, policy, audit). Threading it through the
// executor catalog requires per-request executor context that the boot-time
// singleton does not hold; the running server ships a resolver that fails with
// a typed NotImplemented for external calls, while the scope-database path
// (`db.sql`) is fully live. See the note in DESIGN / the remaining-gap section.
// The full real external-call path is exercised end-to-end in the package e2e
// and the booted-host wire e2e against the emulate GitHub.
// ---------------------------------------------------------------------------

/** The single scope this self-host instance serves (single-tenant). */
export const SELF_HOST_SCOPE = "default";

/** The apps connection name for the self-host scope (formalized mapping). */
export const SELF_HOST_APPS_CONNECTION = connectionNameForScope(SELF_HOST_SCOPE);

const notImplementedResolver: ClientResolver = {
  call: ({ integration }) =>
    Effect.fail(
      new BindingError({
        message:
          `external integration "${integration}" routing is not wired into the running self-host ` +
          `server yet (the ClientResolver -> catalog bridge needs per-request executor context). ` +
          `Scope-database tools work; see the apps package e2e for the full external-call path.`,
        role: integration,
        surface: integration,
      }),
    ),
};

/** Options for the apps subsystem singleton. `authenticate` gates the HTTP
 *  surface; supplied by `app.ts` from the resolved Better Auth instance.
 *  `webBaseUrl` is the public origin used to build the `apps_open_ui` HTTP
 *  fallback URL. */
export interface SelfHostAppsSubsystemOptions {
  readonly authenticate?: (request: Request) => Promise<boolean>;
  readonly webBaseUrl?: string;
}

// The boot-time singleton. Built lazily on first access so importing this module
// (which executor.config.ts does) does not do filesystem work at import time.
let subsystem: SelfHostApps | undefined;

// The live authenticate + fallback-URL refs. The subsystem is a singleton and is
// FIRST built by executor.config.ts (which has no auth), then app.ts calls again
// WITH auth. So we can't bake auth into the http handler at build time — instead
// the handler reads these mutable refs per request, and app.ts sets them once the
// Better Auth instance is resolved. Until set, the surface DENIES all requests
// (fail-closed), so a misconfigured boot never exposes the surface unauthed.
let authenticateRef: ((request: Request) => Promise<boolean>) | undefined;
let webBaseUrlRef: string | undefined;

export const getSelfHostAppsSubsystem = (
  options: SelfHostAppsSubsystemOptions = {},
): SelfHostApps => {
  // Apply any newly-supplied config to the live refs (app.ts's call carries the
  // real auth even though config.ts built the singleton first).
  if (options.authenticate) authenticateRef = options.authenticate;
  if (options.webBaseUrl) webBaseUrlRef = options.webBaseUrl;

  if (!subsystem) {
    subsystem = makeSelfHostApps({
      dataDir: resolveDataDir(),
      // Boot-time fallback for calls made outside a request (e.g. the scheduler
      // firing a workflow with no request ctx). The per-request `makeResolver`
      // below is the real path for catalog-invoked tools.
      resolver: notImplementedResolver,
      scope: SELF_HOST_SCOPE,
      // The REAL per-request resolver: built from the invoking executor context
      // so external integration calls resolve the user's connection + credential
      // at the boundary and dispatch over the request's HttpClient.
      makeResolver: ({ ctx }) => makeCtxResolver(ctx),
      // Read the live auth ref per request. Fail-closed: if app.ts hasn't wired
      // the Better Auth check yet, deny (never expose the surface unauthed).
      authenticate: (request) =>
        authenticateRef ? authenticateRef(request) : Promise.resolve(false),
      // Read the live web base URL ref (used for the apps_open_ui fallback URL).
      webBaseUrl: undefined,
      webBaseUrlFn: () => webBaseUrlRef,
    });
  }
  return subsystem;
};

/** Reset the singleton (tests build fresh instances per data dir). */
export const resetSelfHostAppsSubsystem = (): void => {
  subsystem = undefined;
  authenticateRef = undefined;
  webBaseUrlRef = undefined;
};

/** @deprecated use getSelfHostAppsSubsystem(); kept for existing call sites. */
export const makeSelfHostAppsSubsystem = getSelfHostAppsSubsystem;
