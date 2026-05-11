import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { sourceWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { useScope, useUserScope } from "@executor-js/react/api/scope-context";
import type { SecretPickerSecret } from "@executor-js/react/plugins/secret-picker";
import { CreatableSecretPicker } from "@executor-js/react/plugins/secret-header-auth";
import { useSecretPickerSecrets } from "@executor-js/react/plugins/use-secret-picker-secrets";
import type { ScopeId } from "@executor-js/sdk";
import { Badge } from "@executor-js/react/components/badge";
import { Button } from "@executor-js/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor-js/react/components/card-stack";
import {
  SourceIdentityFields,
  slugifyNamespace,
  useSourceIdentity,
} from "@executor-js/react/plugins/source-identity";
import {
  oauthCallbackUrl,
  oauthConnectionId,
  useOAuthPopupFlow,
} from "@executor-js/react/plugins/oauth-sign-in";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@executor-js/react/components/collapsible";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@executor-js/react/components/field";
import { FilterTabs } from "@executor-js/react/components/filter-tabs";
import { FloatActions } from "@executor-js/react/components/float-actions";
import { Input } from "@executor-js/react/components/input";
import { RadioGroup, RadioGroupItem } from "@executor-js/react/components/radio-group";
import { IOSSpinner, Spinner } from "@executor-js/react/components/spinner";
import { addGoogleDiscoverySourceOptimistic, probeGoogleDiscovery } from "./atoms";
import { GOOGLE_DISCOVERY_OAUTH_POPUP_NAME, googleDiscoveryOAuthStrategy } from "./oauth";
import { googleDiscoveryPresets, type GoogleDiscoveryPreset } from "../sdk/presets";

const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeErrorMessage = Schema.decodeUnknownOption(ErrorMessage);

const errorMessageFromExit = (exit: Exit.Exit<unknown, unknown>, fallback: string): string =>
  Option.match(Option.flatMap(Exit.findErrorOption(exit), decodeErrorMessage), {
    onNone: () => fallback,
    onSome: ({ message }) => message,
  });

type GoogleAuthKind = "none" | "oauth2";

// ---------------------------------------------------------------------------
// Client secret field with inline creation
// ---------------------------------------------------------------------------

function SecretBackedField(props: {
  label: string;
  suggestedSecretId: string;
  secretId: string | null;
  onSelect: (secretId: string | null) => void;
  secretList: readonly SecretPickerSecret[];
  placeholder: string;
  targetScope: ScopeId;
  clearable?: boolean;
}) {
  const { label, secretId, onSelect, secretList, placeholder, clearable = true } = props;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <CreatableSecretPicker
            value={secretId}
            onSelect={(id) => onSelect(id)}
            secrets={secretList}
            placeholder={placeholder}
            suggestedId={props.suggestedSecretId}
            secretLabel={label}
            targetScope={props.targetScope}
          />
        </div>
        {clearable && secretId && (
          <Button variant="outline" onClick={() => onSelect(null)}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

type GoogleDiscoveryTemplate = GoogleDiscoveryPreset & {
  readonly discoveryUrl: string;
  readonly service: string;
  readonly version: string;
};

const GOOGLE_G_ICON = "https://fonts.gstatic.com/s/i/productlogos/googleg/v6/192px.svg";

function parseGoogleDiscoveryPreset(preset: GoogleDiscoveryPreset): GoogleDiscoveryTemplate {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL constructor normalizes user-provided preset URLs
  try {
    const url = new URL(preset.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const apisIndex = parts.indexOf("apis");
    const service = apisIndex >= 0 ? parts[apisIndex + 1] : undefined;
    const version =
      apisIndex >= 0 ? parts[apisIndex + 2] : (url.searchParams.get("version") ?? undefined);
    return {
      ...preset,
      discoveryUrl: preset.url,
      service: service ?? url.hostname.replace(/\.googleapis\.com$/, ""),
      version: version ?? "",
    };
  } catch {
    return { ...preset, discoveryUrl: preset.url, service: preset.id, version: "" };
  }
}

const GOOGLE_DISCOVERY_TEMPLATES = googleDiscoveryPresets.map(parseGoogleDiscoveryPreset);

const iconForService = (service: string): string | undefined =>
  GOOGLE_DISCOVERY_TEMPLATES.find((template) => template.service === service)?.icon;

function GoogleServiceIcon(props: {
  readonly icon?: string;
  readonly service?: string;
  readonly className?: string;
}) {
  const { icon, service, className = "size-11" } = props;
  const src = icon ?? (service ? iconForService(service) : undefined) ?? GOOGLE_G_ICON;

  return (
    <img
      alt=""
      aria-hidden="true"
      className={`${className} shrink-0 object-contain`}
      decoding="async"
      draggable={false}
      loading="lazy"
      src={src}
    />
  );
}

type ProbeOperation = {
  toolPath: string;
  method: string;
  pathTemplate: string;
  description: string | null;
};

type ProbeResult = {
  name: string;
  title: string | null;
  service: string;
  version: string;
  toolCount: number;
  scopes: readonly string[];
  operations: readonly ProbeOperation[];
};

type OAuthAuth = {
  kind: "oauth2";
  connectionId: string;
  clientIdSecretId: string;
  clientSecretSecretId: string | null;
  scopes: string[];
};

export default function AddGoogleDiscoverySource(props: {
  readonly onComplete: () => void;
  readonly onCancel: () => void;
  readonly initialUrl?: string;
  readonly initialPreset?: string;
}) {
  const defaultTemplate =
    GOOGLE_DISCOVERY_TEMPLATES.find((template) => template.id === props.initialPreset) ??
    GOOGLE_DISCOVERY_TEMPLATES.find((template) => template.id === "google-sheets") ??
    GOOGLE_DISCOVERY_TEMPLATES[0]!;
  const [discoveryUrl, setDiscoveryUrl] = useState(
    props.initialUrl ?? defaultTemplate.discoveryUrl,
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    props.initialUrl ? "" : defaultTemplate.id,
  );
  const selectedTemplate =
    GOOGLE_DISCOVERY_TEMPLATES.find((template) => template.id === selectedTemplateId) ?? null;
  const [authKind, setAuthKind] = useState<GoogleAuthKind>("oauth2");
  const [clientIdSecretId, setClientIdSecretId] = useState<string | null>(null);
  const [clientSecretSecretId, setClientSecretSecretId] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const identity = useSourceIdentity({
    fallbackName: probe?.name ?? selectedTemplate?.name ?? "",
  });
  const [oauthAuth, setOauthAuth] = useState<OAuthAuth | null>(null);
  const [loadingProbe, setLoadingProbe] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showScopes, setShowScopes] = useState(false);
  const resolvedNamespace =
    slugifyNamespace(identity.namespace) ||
    slugifyNamespace(probe?.name ?? selectedTemplate?.name ?? "") ||
    "google";

  const scopeId = useScope();
  const userScopeId = useUserScope();
  const doProbe = useAtomSet(probeGoogleDiscovery, { mode: "promiseExit" });
  const doAdd = useAtomSet(addGoogleDiscoverySourceOptimistic(scopeId), {
    mode: "promiseExit",
  });
  const secretList = useSecretPickerSecrets();
  const oauth = useOAuthPopupFlow({
    popupName: GOOGLE_DISCOVERY_OAUTH_POPUP_NAME,
    popupBlockedMessage: "OAuth popup was blocked",
    popupClosedMessage: "OAuth cancelled: popup was closed before completing the flow.",
    startErrorMessage: "Failed to start OAuth",
  });

  const canUseOAuth = useMemo(() => (probe?.scopes.length ?? 0) > 0, [probe]);

  const applyTemplate = useCallback(
    (template: GoogleDiscoveryTemplate) => {
      setSelectedTemplateId(template.id);
      setDiscoveryUrl(template.discoveryUrl);
      identity.reset();
      setClientSecretSecretId(null);
      setProbe(null);
      setOauthAuth(null);
      setError(null);
      setShowScopes(false);
      setAuthKind("oauth2");
    },
    [identity],
  );

  const handleProbe = useCallback(async () => {
    setLoadingProbe(true);
    setError(null);
    setOauthAuth(null);
    setShowScopes(false);
    const exit = await doProbe({
      params: { scopeId },
      payload: { discoveryUrl: discoveryUrl.trim() },
    });
    if (Exit.isFailure(exit)) {
      setProbe(null);
      setLoadingProbe(false);
      setError(errorMessageFromExit(exit, "Failed to inspect discovery document"));
      return;
    }
    const result = exit.value;
    setProbe({
      ...result,
      scopes: [...result.scopes],
      operations: [...result.operations],
    });
    if (result.scopes.length === 0) {
      setAuthKind("none");
    }
    setLoadingProbe(false);
  }, [discoveryUrl, doProbe, scopeId]);

  // Keep the latest handleProbe in a ref so the debounced effect can call it
  // without depending on its identity (which changes every render).
  const handleProbeRef = useRef(handleProbe);
  handleProbeRef.current = handleProbe;

  // Auto-probe whenever the discovery URL changes (debounced). Clearing the
  // previous probe in the onChange handler resets the preview so a new run
  // will be triggered.
  useEffect(() => {
    const trimmed = discoveryUrl.trim();
    if (!trimmed) return;
    if (probe) return;
    const handle = setTimeout(() => {
      handleProbeRef.current();
    }, 400);
    return () => clearTimeout(handle);
  }, [discoveryUrl, probe]);

  const handleStartOAuth = useCallback(async () => {
    if (!probe || !clientIdSecretId) return;
    setError(null);
    const scopes = [...probe.scopes];
    await oauth.start({
      payload: {
        endpoint: discoveryUrl.trim(),
        redirectUrl: oauthCallbackUrl(),
        connectionId: oauthConnectionId({
          pluginId: "google-discovery",
          namespace: resolvedNamespace,
        }),
        tokenScope: userScopeId,
        identityLabel: `${identity.name.trim() || probe.title || probe.name} OAuth`,
        strategy: googleDiscoveryOAuthStrategy({
          clientIdSecretId,
          clientSecretSecretId,
          scopes,
        }),
        pluginId: "google-discovery",
      },
      onSuccess: (result) => {
        setOauthAuth({
          kind: "oauth2",
          connectionId: result.connectionId,
          clientIdSecretId,
          clientSecretSecretId,
          scopes,
        });
        setError(null);
      },
      onError: setError,
    });
  }, [
    probe,
    discoveryUrl,
    identity.name,
    clientIdSecretId,
    clientSecretSecretId,
    resolvedNamespace,
    oauth,
    userScopeId,
  ]);

  const handleCancelOAuth = useCallback(() => {
    oauth.cancel();
  }, [oauth]);

  const handleAdd = useCallback(async () => {
    if (!probe) return;
    setAdding(true);
    setError(null);
    const displayName = identity.name.trim() || probe.name;
    const namespace = resolvedNamespace;
    const exit = await doAdd({
      params: { scopeId },
      payload: {
        name: displayName,
        discoveryUrl: discoveryUrl.trim(),
        namespace,
        auth:
          authKind === "oauth2" && oauthAuth
            ? {
                kind: "oauth2" as const,
                connectionId: oauthAuth.connectionId,
                clientIdSecretId: oauthAuth.clientIdSecretId,
                clientSecretSecretId: oauthAuth.clientSecretSecretId,
                scopes: oauthAuth.scopes,
              }
            : { kind: "none" as const },
      },
      reactivityKeys: [...sourceWriteKeys],
    });
    if (Exit.isFailure(exit)) {
      setError(errorMessageFromExit(exit, "Failed to add source"));
      setAdding(false);
      return;
    }
    props.onComplete();
  }, [
    probe,
    doAdd,
    identity,
    discoveryUrl,
    authKind,
    oauthAuth,
    props,
    scopeId,
    resolvedNamespace,
  ]);

  const addDisabled =
    !probe || adding || (authKind === "oauth2" && (!canUseOAuth || oauthAuth === null));

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Add Google Discovery Source</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Connect a Google API from its Discovery document and register its methods as tools.
        </p>
      </div>

      <FieldGroup>
        <FieldSet>
          <FieldLegend variant="label">Presets</FieldLegend>
          <FieldDescription>Select a Google API to prefill the source.</FieldDescription>
          <RadioGroup
            value={selectedTemplateId}
            onValueChange={(value) => {
              const template = GOOGLE_DISCOVERY_TEMPLATES.find((t) => t.id === value);
              if (template) applyTemplate(template);
            }}
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
          >
            {GOOGLE_DISCOVERY_TEMPLATES.map((template) => {
              const inputId = `google-discovery-preset-${template.id}`;
              return (
                <FieldLabel key={template.id} htmlFor={inputId}>
                  <Field orientation="horizontal">
                    <GoogleServiceIcon
                      icon={template.icon}
                      service={template.service}
                      className="size-8"
                    />
                    <FieldContent>
                      <FieldTitle>{template.name}</FieldTitle>
                      <FieldDescription className="line-clamp-2">
                        {template.summary}
                      </FieldDescription>
                    </FieldContent>
                    <RadioGroupItem id={inputId} value={template.id} />
                  </Field>
                </FieldLabel>
              );
            })}
          </RadioGroup>
        </FieldSet>
      </FieldGroup>

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField label="Discovery URL">
            <div className="relative">
              <Input
                value={discoveryUrl}
                onChange={(e) => {
                  setSelectedTemplateId("");
                  setDiscoveryUrl((e.target as HTMLInputElement).value);
                  setProbe(null);
                  setOauthAuth(null);
                  setError(null);
                }}
                placeholder="https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest"
                className="w-full pr-9 font-mono text-sm"
              />
              {loadingProbe && (
                <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                  <IOSSpinner className="size-4" />
                </div>
              )}
            </div>
          </CardStackEntryField>
        </CardStackContent>
      </CardStack>

      <SourceIdentityFields
        identity={identity}
        namePlaceholder="Google Sheets"
        namespacePlaceholder="google_sheets"
      />

      {probe && (
        <section className="space-y-3 rounded-xl border border-border bg-card px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background/80 shadow-xs">
                <GoogleServiceIcon
                  icon={selectedTemplate?.icon}
                  service={selectedTemplate?.service ?? probe.service}
                  className="size-5"
                />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">{probe.title ?? probe.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {probe.service} · {probe.version}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Badge variant="secondary">{probe.toolCount} tools</Badge>
              <Badge variant="outline">{probe.scopes.length} scopes</Badge>
            </div>
          </div>
        </section>
      )}

      <section className="space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Authentication</FieldLabel>
          <FilterTabs<GoogleAuthKind>
            tabs={[
              { value: "none", label: "None" },
              { value: "oauth2", label: "OAuth" },
            ]}
            value={authKind}
            onChange={setAuthKind}
          />
        </div>

        {authKind === "oauth2" && (
          <div className="space-y-3 rounded-xl border border-border bg-card px-4 py-4">
            <SecretBackedField
              label="OAuth Client ID"
              suggestedSecretId="google-oauth-client-id"
              secretId={clientIdSecretId}
              onSelect={setClientIdSecretId}
              secretList={secretList}
              placeholder="Pick or create a secret"
              targetScope={userScopeId}
              clearable={false}
            />
            <SecretBackedField
              label="OAuth Client Secret"
              suggestedSecretId="google-oauth-client-secret"
              secretId={clientSecretSecretId}
              onSelect={setClientSecretSecretId}
              secretList={secretList}
              placeholder="Optional for confidential clients"
              targetScope={userScopeId}
            />
            <Collapsible open={showScopes} onOpenChange={setShowScopes} className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="text-xs text-muted-foreground">
                    {canUseOAuth
                      ? `${probe?.scopes.length ?? 0} scopes will be requested from Google.`
                      : "This API does not advertise OAuth scopes."}
                  </p>
                  {canUseOAuth && (probe?.scopes.length ?? 0) > 0 && (
                    <CollapsibleTrigger asChild>
                      <Button
                        variant="link"
                        type="button"
                        className="h-auto p-0 text-xs font-medium text-primary hover:underline"
                      >
                        {showScopes ? "Hide scopes" : "View scopes"}
                      </Button>
                    </CollapsibleTrigger>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    onClick={handleStartOAuth}
                    disabled={!probe || !clientIdSecretId || !canUseOAuth || oauth.busy}
                  >
                    {oauth.busy ? (
                      <>
                        <Spinner className="size-3.5" /> Waiting…
                      </>
                    ) : oauthAuth ? (
                      "Re-authenticate"
                    ) : (
                      "Connect Google"
                    )}
                  </Button>
                  {oauth.busy && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleCancelOAuth}
                      className="h-8 px-2 text-xs"
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </div>
              <CollapsibleContent>
                <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
                  <ul className="space-y-1">
                    {(probe?.scopes ?? []).map((scope) => (
                      <li
                        key={scope}
                        className="break-all font-mono text-[11px] text-muted-foreground"
                      >
                        {scope}
                      </li>
                    ))}
                  </ul>
                </div>
              </CollapsibleContent>
            </Collapsible>
            {oauthAuth && (
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                Connected. Manage this connection from the Connections page.
              </div>
            )}
          </div>
        )}
      </section>

      {error && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <FloatActions>
        <Button variant="ghost" onClick={props.onCancel} disabled={adding}>
          Cancel
        </Button>
        <Button onClick={handleAdd} disabled={addDisabled}>
          {adding && <Spinner className="size-3.5" />}
          {adding ? "Adding…" : "Add Source"}
        </Button>
      </FloatActions>
    </div>
  );
}
