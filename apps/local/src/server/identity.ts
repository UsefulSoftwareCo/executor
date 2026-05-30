import { Effect, Layer } from "effect";

import { IdentityProvider, type Principal } from "@executor-js/api/server";

// ---------------------------------------------------------------------------
// The local identity seam — the production implementation of the shared
// `IdentityProvider` from `@executor-js/api/server` for the single-user local
// daemon.
//
// Local is single-user: there is no account/org directory, and the executor it
// serves is a single boot-built instance scoped to the working directory (see
// `FixedExecutionProvider` in `app.ts`). So this provider ALWAYS resolves the
// one local Principal — there is no credential lookup to perform here. (The
// optional process-level Basic/Bearer gate that protects a network bind lives in
// the Bun serve shell, `serve.ts`; it is a coarse network gate, not request
// identity, and stays separate.)
//
// This is a genuine implementation, not a placeholder: `authenticate` returns a
// concrete, stable `Principal` whose `AuthContext` the executor API handlers
// read. The fixed executor ignores the `accountId`/`organizationId` (it does NOT
// rebuild a per-(user, org) scope the way cloud/self-host do), so these values
// only populate `AuthContext` for handlers/telemetry that surface "who am I".
// ---------------------------------------------------------------------------

/**
 * The single local Principal every request resolves to. Stable across the
 * process; the `local` ids identify the single-user daemon in `AuthContext` and
 * any "me"-style surfaces. The fixed executor's scope is cwd-derived (in
 * `app.ts`), independent of these ids.
 */
export const LOCAL_PRINCIPAL: Principal = {
  accountId: "local",
  organizationId: "local",
  organizationName: "Local",
  email: "",
  name: null,
  avatarUrl: null,
  roles: [],
};

/**
 * The local `IdentityProvider`: always resolves `LOCAL_PRINCIPAL`. A complete
 * `Layer<IdentityProvider>` with no residual requirement (`RIdentity = never`),
 * so the facade captures it once at boot like self-host's.
 */
export const localIdentityLayer: Layer.Layer<IdentityProvider> = Layer.succeed(IdentityProvider)(
  IdentityProvider.of({
    authenticate: () => Effect.succeed(LOCAL_PRINCIPAL),
  }),
);
