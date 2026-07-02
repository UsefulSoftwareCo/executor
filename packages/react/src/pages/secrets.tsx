import { Suspense } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type { ProviderKey } from "@executor-js/sdk/shared";
import { useSecretProviderPlugins } from "@executor-js/sdk/client";

import { providersAtom } from "../api/atoms";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryTitle,
  CardStackHeader,
} from "../components/card-stack";
import { Badge } from "../components/badge";
import { PageContainer, PageHeader } from "../components/page";

// ---------------------------------------------------------------------------
// Providers page (v2) — repurposed from the v1 Secrets page.
//
// v1 stored standalone secrets and bound them per-source. v2 makes a connection
// the credential, and a `CredentialProvider` is where its value lives (the
// default store for pasted values, or an external backend like 1Password /
// keychain). This page surfaces the registered providers plus any provider
// plugin's settings card. The route still exports `SecretsPage` so existing app
// wiring keeps resolving; new callers should treat it as the Providers view.
// ---------------------------------------------------------------------------

const PROVIDER_LABELS: Record<string, string> = {
  default: "Default store",
  keychain: "Keychain",
  file: "Local file",
  memory: "Memory",
  onepassword: "1Password",
  "workos-vault": "WorkOS Vault",
};

const providerLabel = (key: string): string => PROVIDER_LABELS[key] ?? key;

export function SecretsPage(props: { showProviderInfo?: boolean }) {
  const showProviderInfo = props.showProviderInfo ?? true;
  const secretProviderPlugins = useSecretProviderPlugins();
  const providers = useAtomValue(providersAtom);

  return (
    <PageContainer>
      <PageHeader
        title="Providers"
        description="Where your connections' credential values live: the default store for pasted values, or an external backend like 1Password or your system keychain."
      />

      {/* Provider plugins (settings cards) */}
      {showProviderInfo && secretProviderPlugins.length > 0 && (
        <div className="mb-10">
          <CardStack>
            <CardStackHeader>Configure providers</CardStackHeader>
            <CardStackContent>
              {secretProviderPlugins.map((plugin) => (
                <Suspense
                  key={plugin.key}
                  fallback={
                    <div className="px-4 py-3 animate-pulse">
                      <div className="h-4 w-24 rounded bg-muted" />
                    </div>
                  }
                >
                  <plugin.settings />
                </Suspense>
              ))}
            </CardStackContent>
          </CardStack>
        </div>
      )}

      {/* Registered providers */}
      {AsyncResult.match(providers, {
        onInitial: () => (
          <div className="flex items-center gap-2 py-8">
            <div className="size-1.5 rounded-full bg-muted-foreground/30 animate-pulse" />
            <p className="text-sm text-muted-foreground">Loading providers…</p>
          </div>
        ),
        onFailure: () => (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
            <p className="text-sm text-destructive">Failed to load providers</p>
          </div>
        ),
        onSuccess: ({ value }) => (
          <CardStack>
            <CardStackHeader>Available providers</CardStackHeader>
            <CardStackContent>
              {value.length === 0 ? (
                <CardStackEntry>
                  <CardStackEntryContent>
                    <CardStackEntryDescription>
                      No credential providers are registered.
                    </CardStackEntryDescription>
                  </CardStackEntryContent>
                </CardStackEntry>
              ) : (
                value.map((key: ProviderKey) => (
                  <CardStackEntry key={String(key)}>
                    <CardStackEntryContent>
                      <CardStackEntryTitle className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 shrink truncate">
                          {providerLabel(String(key))}
                        </span>
                        <span className="max-w-40 shrink truncate font-mono text-xs text-muted-foreground">
                          {String(key)}
                        </span>
                      </CardStackEntryTitle>
                    </CardStackEntryContent>
                    <CardStackEntryActions>
                      <Badge variant="secondary">provider</Badge>
                    </CardStackEntryActions>
                  </CardStackEntry>
                ))
              )}
            </CardStackContent>
          </CardStack>
        ),
      })}
    </PageContainer>
  );
}
