import { Effect } from "effect";

import { definePlugin, type CredentialProvider, type PluginCtx } from "@executor-js/sdk/core";

import {
  makeConfiguredWorkOSVaultClient,
  type WorkOSVaultClient,
  WorkOSVaultClientInstantiationError,
  type WorkOSVaultCredentials,
} from "./client";
import {
  WORKOS_VAULT_PROVIDER_KEY,
  makeWorkOSVaultCredentialProvider,
  makeWorkosVaultStore,
  type WorkosVaultStore,
} from "./secret-store";

// ---------------------------------------------------------------------------
// Plugin options — either pass a pre-built client (for tests / injection)
// or the WorkOS credentials to build one at startup. An `objectPrefix`
// override is available for multi-tenant installations.
// ---------------------------------------------------------------------------

export interface WorkOSVaultPluginOptions {
  readonly client?: WorkOSVaultClient;
  readonly credentials?: WorkOSVaultCredentials;
  readonly objectPrefix?: string;
}

const makeWorkOSVaultExtension = () =>
  ({
    providerKey: WORKOS_VAULT_PROVIDER_KEY,
  }) as const;

export type WorkOSVaultExtension = ReturnType<typeof makeWorkOSVaultExtension>;

// The plugin's typed store is just its metadata-store wrapper. The
// credential provider closes over this store plus the resolved WorkOS
// client. v2 has no scope partitioning — the connection row owns the
// (tenant, owner, subject) partition; the provider only ever sees an opaque
// `ProviderItemId`.
type WorkosVaultPluginStore = WorkosVaultStore;

const buildClient = (
  options: WorkOSVaultPluginOptions | undefined,
): Effect.Effect<WorkOSVaultClient, WorkOSVaultClientInstantiationError, never> => {
  if (options?.client) return Effect.succeed(options.client);
  if (options?.credentials) {
    return makeConfiguredWorkOSVaultClient(options.credentials);
  }
  return Effect.fail(
    new WorkOSVaultClientInstantiationError({
      cause: "workosVaultPlugin requires either `client` or `credentials` to be provided",
    }),
  );
};

export const workosVaultPlugin = definePlugin((options?: WorkOSVaultPluginOptions) => ({
  id: "workosVault" as const,
  packageName: "@executor-js/plugin-workos-vault",
  storage: (deps): WorkosVaultPluginStore => makeWorkosVaultStore(deps),

  extension: makeWorkOSVaultExtension,

  credentialProviders: (ctx: PluginCtx<WorkosVaultPluginStore>): readonly CredentialProvider[] => {
    // Build (or accept) the WorkOS client once at startup. If credentials are
    // bad this throws synchronously via Effect.runSync, which is what we
    // want — the executor fails to start rather than surfacing bad
    // credentials on first credential access.
    const client = Effect.runSync(buildClient(options));
    return [
      makeWorkOSVaultCredentialProvider({
        client,
        store: ctx.storage,
        owner: ctx.owner,
        objectPrefix: options?.objectPrefix,
      }),
    ];
  },
}));
