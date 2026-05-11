import { useCallback, useState } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { useScope } from "@executor-js/react/api/scope-context";
import { sourceWriteKeys } from "@executor-js/react/api/reactivity-keys";
import {
  HttpCredentialsEditor,
  httpCredentialsValid,
  serializeScopedHttpCredentials,
  serializeHttpCredentials,
  type HttpCredentialsState,
} from "@executor-js/react/plugins/http-credentials";
import {
  sourceDisplayNameFromUrl,
  slugifyNamespace,
  useSourceIdentity,
} from "@executor-js/react/plugins/source-identity";
import {
  oauthCallbackUrl,
  oauthConnectionId,
  useOAuthPopupFlow,
  type OAuthCompletionPayload,
} from "@executor-js/react/plugins/oauth-sign-in";
import {
  CredentialControlField,
  CredentialUsageRow,
  useCredentialTargetScope,
} from "@executor-js/react/plugins/credential-target-scope";
import { useSecretPickerSecrets } from "@executor-js/react/plugins/use-secret-picker-secrets";
import { Button } from "@executor-js/react/components/button";
import { FilterTabs } from "@executor-js/react/components/filter-tabs";
import { FloatActions } from "@executor-js/react/components/float-actions";
import { Spinner } from "@executor-js/react/components/spinner";
import { addGraphqlSourceOptimistic } from "./atoms";
import { initialGraphqlCredentials } from "./defaults";
import { GraphqlSourceFields } from "./GraphqlSourceFields";
import type { GraphqlCredentialInput } from "../sdk/types";

const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeErrorMessage = Schema.decodeUnknownOption(ErrorMessage);

const errorMessageFromExit = (exit: Exit.Exit<unknown, unknown>, fallback: string): string =>
  Option.match(Option.flatMap(Exit.findErrorOption(exit), decodeErrorMessage), {
    onNone: () => fallback,
    onSome: ({ message }) => message,
  });

type AuthMode = "none" | "oauth2";

export default function AddGraphqlSource(props: {
  onComplete: () => void;
  onCancel: () => void;
  initialUrl?: string;
}) {
  const [endpoint, setEndpoint] = useState(props.initialUrl ?? "");
  const identity = useSourceIdentity({
    fallbackName: sourceDisplayNameFromUrl(endpoint, "GraphQL") ?? "",
  });
  const [credentials, setCredentials] = useState<HttpCredentialsState>(initialGraphqlCredentials);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("none");
  const [tokens, setTokens] = useState<OAuthCompletionPayload | null>(null);

  const scopeId = useScope();
  const { credentialTargetScope: requestCredentialTargetScope } = useCredentialTargetScope();
  const {
    credentialTargetScope: oauthCredentialTargetScope,
    setCredentialTargetScope: setOAuthCredentialTargetScope,
    credentialScopeOptions,
  } = useCredentialTargetScope();
  const doAdd = useAtomSet(addGraphqlSourceOptimistic(scopeId), {
    mode: "promiseExit",
  });
  const secretList = useSecretPickerSecrets();
  const oauth = useOAuthPopupFlow({
    popupName: "graphql-oauth",
    startErrorMessage: "Failed to start OAuth",
  });

  const canAdd =
    endpoint.trim().length > 0 &&
    httpCredentialsValid(credentials) &&
    (authMode === "none" || tokens !== null) &&
    !oauth.busy;

  const sourceIdentity = useCallback(() => {
    const trimmedEndpoint = endpoint.trim();
    const namespace =
      slugifyNamespace(identity.namespace) ||
      slugifyNamespace(sourceDisplayNameFromUrl(trimmedEndpoint, "GraphQL") ?? "") ||
      "graphql";
    const displayName =
      identity.name.trim() || sourceDisplayNameFromUrl(trimmedEndpoint, "GraphQL") || namespace;
    return { trimmedEndpoint, namespace, displayName };
  }, [endpoint, identity.name, identity.namespace]);

  const handleOAuth = useCallback(async () => {
    if (!endpoint.trim() || !httpCredentialsValid(credentials)) return;
    setAddError(null);
    const { trimmedEndpoint, namespace, displayName } = sourceIdentity();
    const { headers, queryParams } = serializeHttpCredentials(credentials);
    await oauth.start({
      payload: {
        endpoint: trimmedEndpoint,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
        redirectUrl: oauthCallbackUrl(),
        connectionId: oauthConnectionId({ pluginId: "graphql", namespace }),
        tokenScope: oauthCredentialTargetScope,
        strategy: { kind: "dynamic-dcr" },
        pluginId: "graphql",
        identityLabel: `${displayName} OAuth`,
      },
      onSuccess: (result) => {
        setTokens({
          connectionId: result.connectionId,
          expiresAt: result.expiresAt,
          scope: result.scope,
        });
      },
      onError: setAddError,
    });
  }, [endpoint, credentials, oauth, sourceIdentity, oauthCredentialTargetScope]);

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);
    const { headers: headerMap, queryParams } = serializeScopedHttpCredentials(
      credentials,
      requestCredentialTargetScope,
    );

    const { trimmedEndpoint, namespace, displayName } = sourceIdentity();
    const exit = await doAdd({
      params: { scopeId },
      payload: {
        targetScope: scopeId,
        endpoint: trimmedEndpoint,
        name: displayName,
        namespace,
        ...(Object.keys(headerMap).length > 0 ? { headers: headerMap } : {}),
        ...(Object.keys(queryParams).length > 0
          ? {
              queryParams: queryParams as Record<string, GraphqlCredentialInput>,
            }
          : {}),
        credentialTargetScope:
          authMode === "oauth2" && tokens
            ? oauthCredentialTargetScope
            : requestCredentialTargetScope,
        ...(authMode === "oauth2" && tokens
          ? {
              auth: {
                kind: "oauth2" as const,
                connectionId: tokens.connectionId,
              },
            }
          : {}),
      },
      reactivityKeys: sourceWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setAddError(errorMessageFromExit(exit, "Failed to add source"));
      setAdding(false);
      return;
    }
    props.onComplete();
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <h1 className="text-xl font-semibold text-foreground">Add GraphQL Source</h1>

      <GraphqlSourceFields endpoint={endpoint} onEndpointChange={setEndpoint} identity={identity} />

      <HttpCredentialsEditor
        credentials={credentials}
        onChange={setCredentials}
        existingSecrets={secretList}
        sourceName={identity.name}
        targetScope={requestCredentialTargetScope}
        credentialScopeOptions={credentialScopeOptions}
        bindingScopeOptions={credentialScopeOptions}
      />

      {/* Temporarily hidden while we revisit GraphQL OAuth discovery and UX. */}
      <section className="hidden space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-foreground">Authentication</span>
          <FilterTabs<AuthMode>
            tabs={[
              { value: "none", label: "None" },
              { value: "oauth2", label: "OAuth" },
            ]}
            value={authMode}
            onChange={(value) => {
              setAuthMode(value);
              setTokens(null);
            }}
          />
        </div>

        {authMode === "oauth2" && (
          <CredentialUsageRow
            value={oauthCredentialTargetScope}
            options={credentialScopeOptions}
            onChange={(targetScope) => {
              setOAuthCredentialTargetScope(targetScope);
              setTokens(null);
            }}
            label="Connection saved to"
            help="Choose who can use the OAuth connection."
          >
            <CredentialControlField label="Connect via OAuth" help="Start the provider OAuth flow.">
              <div className="flex min-h-9 items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                {tokens ? (
                  <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    Authenticated
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">Not connected</span>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ml-auto h-7 px-2 text-xs"
                  onClick={() => void handleOAuth()}
                  disabled={!endpoint.trim() || !httpCredentialsValid(credentials) || oauth.busy}
                >
                  {oauth.busy ? "Signing in..." : tokens ? "Reconnect" : "Sign in"}
                </Button>
              </div>
            </CredentialControlField>
          </CredentialUsageRow>
        )}
      </section>

      {/* Error */}
      {addError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-[12px] text-destructive">{addError}</p>
        </div>
      )}

      <FloatActions>
        <Button
          variant="ghost"
          onClick={() => {
            oauth.cancel();
            props.onCancel();
          }}
          disabled={adding}
        >
          Cancel
        </Button>
        <Button onClick={handleAdd} disabled={!canAdd || adding}>
          {adding && <Spinner className="size-3.5" />}
          {adding ? "Adding..." : "Add source"}
        </Button>
      </FloatActions>
    </div>
  );
}
