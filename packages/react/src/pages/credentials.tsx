import { Suspense } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type { Connection, ProviderKey } from "@executor-js/sdk/shared";
import { useSecretProviderPlugins } from "@executor-js/sdk/client";

import { connectionsAllAtom, providersAtom } from "../api/atoms";
import { ownerLabel } from "../api/owner-display";
import { Badge } from "../components/badge";
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
import { PageContainer, PageHeader } from "../components/page";

const PROVIDER_LABELS: Record<string, string> = {
  default: "Default store",
  keychain: "Keychain",
  file: "Local file",
  memory: "Memory",
  onepassword: "1Password",
  "workos-vault": "WorkOS Vault",
};

const providerLabel = (key: string): string => PROVIDER_LABELS[key] ?? key;

const displayConnectionName = (connection: Connection): string =>
  connection.identityLabel && connection.identityLabel.length > 0
    ? connection.identityLabel
    : String(connection.name);

const connectionSearchText = (connection: Connection): string =>
  [
    displayConnectionName(connection),
    connection.description ?? "",
    connection.owner,
    connection.integration,
    connection.template,
    connection.provider,
    connection.name,
  ]
    .map(String)
    .join(" ");

function LoadingRow(props: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-8">
      <div className="size-1.5 rounded-full bg-muted-foreground/30 animate-pulse" />
      <p className="text-sm text-muted-foreground">{props.label}</p>
    </div>
  );
}

function FailureRow(props: { label: string }) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
      <p className="text-sm text-destructive">{props.label}</p>
    </div>
  );
}

function ConnectionRow(props: { connection: Connection }) {
  const { connection } = props;
  const title = displayConnectionName(connection);
  const name = String(connection.name);
  const details = `${String(connection.integration)} - ${String(connection.template)}`;

  return (
    <CardStackEntry className="flex-wrap items-start" searchText={connectionSearchText(connection)}>
      <CardStackEntryContent>
        <CardStackEntryTitle className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate">{title}</span>
          {name !== title ? (
            <span className="max-w-40 shrink truncate font-mono text-xs text-muted-foreground">
              {name}
            </span>
          ) : null}
        </CardStackEntryTitle>
        <CardStackEntryDescription className="mt-1">{details}</CardStackEntryDescription>
        {connection.description && connection.description.length > 0 ? (
          <CardStackEntryDescription className="mt-1">
            {connection.description}
          </CardStackEntryDescription>
        ) : null}
      </CardStackEntryContent>
      <CardStackEntryActions className="self-start pt-0.5">
        <Badge variant="outline">{ownerLabel(connection.owner)}</Badge>
        <Badge variant="secondary">{providerLabel(String(connection.provider))}</Badge>
      </CardStackEntryActions>
    </CardStackEntry>
  );
}

function ConnectionsSection() {
  const connections = useAtomValue(connectionsAllAtom);

  return AsyncResult.match(connections, {
    onInitial: () => <LoadingRow label="Loading credentials..." />,
    onFailure: () => <FailureRow label="Failed to load credentials" />,
    onSuccess: ({ value }) => (
      <CardStack searchable>
        <CardStackHeader
          rightSlot={
            value.length > 0 ? (
              <Badge variant="secondary">
                {value.length} {value.length === 1 ? "credential" : "credentials"}
              </Badge>
            ) : null
          }
        >
          Connections
        </CardStackHeader>
        <CardStackContent>
          {value.length === 0 ? (
            <CardStackEntry>
              <CardStackEntryContent>
                <CardStackEntryDescription>No credentials are connected.</CardStackEntryDescription>
              </CardStackEntryContent>
            </CardStackEntry>
          ) : (
            value.map((connection: Connection) => (
              <ConnectionRow
                key={`${connection.owner}:${String(connection.integration)}:${String(
                  connection.name,
                )}`}
                connection={connection}
              />
            ))
          )}
        </CardStackContent>
      </CardStack>
    ),
  });
}

function ProviderPluginsSection() {
  const providerPlugins = useSecretProviderPlugins();

  if (providerPlugins.length === 0) return null;

  return (
    <div className="mb-10">
      <CardStack>
        <CardStackHeader>Configure providers</CardStackHeader>
        <CardStackContent>
          {providerPlugins.map((plugin) => (
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
  );
}

function ProvidersSection() {
  const providers = useAtomValue(providersAtom);

  return AsyncResult.match(providers, {
    onInitial: () => <LoadingRow label="Loading providers..." />,
    onFailure: () => <FailureRow label="Failed to load providers" />,
    onSuccess: ({ value }) => (
      <CardStack>
        <CardStackHeader
          rightSlot={
            value.length > 0 ? (
              <Badge variant="secondary">
                {value.length} {value.length === 1 ? "provider" : "providers"}
              </Badge>
            ) : null
          }
        >
          Credential providers
        </CardStackHeader>
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
                    <span className="min-w-0 shrink truncate">{providerLabel(String(key))}</span>
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
  });
}

export function CredentialsPage(props: { showProviderInfo?: boolean }) {
  const showProviderInfo = props.showProviderInfo ?? true;

  return (
    <PageContainer>
      <PageHeader
        title="Credentials"
        description="Connections are the credentials used by tools; providers are the stores that hold credential values."
      />
      {showProviderInfo ? <ProviderPluginsSection /> : null}
      <div className="space-y-10">
        <ConnectionsSection />
        <ProvidersSection />
      </div>
    </PageContainer>
  );
}
