import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChevronDownIcon } from "lucide-react";

import {
  ConnectionId,
  ScopeId,
  SecretId,
  SetSourceCredentialBindingInput,
} from "@executor-js/sdk/shared";
import {
  connectionIdentityAtom,
  connectionsAtom,
  setSourceCredentialBinding,
  startOAuth,
} from "@executor-js/react/api/atoms";
import { useScope, useScopeStack } from "@executor-js/react/api/scope-context";
import { connectionWriteKeys, sourceWriteKeys } from "@executor-js/react/api/reactivity-keys";

// `addSpec` with an oauth2 payload persists a source row AND (for
// clientCredentials) a freshly-minted Connection + owned secrets,
// because the inline token exchange happens during `startOAuth`.
// Invalidate both so the source-detail page opens into its connected
// state without a refresh.
const addSpecWriteKeys = [...sourceWriteKeys, ...connectionWriteKeys] as const;
const bindingWriteKeys = [...sourceWriteKeys, ...connectionWriteKeys] as const;
import { HeadersList } from "@executor-js/react/plugins/headers-list";
import {
  HttpCredentialsEditor,
  emptyHttpCredentials,
  serializeHttpCredentials,
  type HttpCredentialsState,
} from "@executor-js/react/plugins/http-credentials";
import {
  oauthCallbackUrl,
  useOAuthPopupFlow,
  type OAuthCompletionPayload,
} from "@executor-js/react/plugins/oauth-sign-in";
import {
  CreatableSecretPicker,
  matchPresetKey,
  type HeaderState,
} from "@executor-js/react/plugins/secret-header-auth";
import { CredentialScopeDropdown } from "@executor-js/react/plugins/credential-target-scope";
import { slugifyNamespace, useSourceIdentity } from "@executor-js/react/plugins/source-identity";
import { useSecretPickerSecrets } from "@executor-js/react/plugins/use-secret-picker-secrets";
import { Button } from "@executor-js/react/components/button";
import { CopyButton } from "@executor-js/react/components/copy-button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@executor-js/react/components/collapsible";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor-js/react/components/card-stack";
import { FieldLabel } from "@executor-js/react/components/field";
import { FloatActions } from "@executor-js/react/components/float-actions";
import { HelpTooltip } from "@executor-js/react/components/help-tooltip";
import { Label } from "@executor-js/react/components/label";
import { Textarea } from "@executor-js/react/components/textarea";
import { Checkbox } from "@executor-js/react/components/checkbox";
import { RadioGroup, RadioGroupItem } from "@executor-js/react/components/radio-group";
import { IOSSpinner, Spinner } from "@executor-js/react/components/spinner";
import { addOpenApiSpecOptimistic, previewOpenApiSpec } from "./atoms";
import { OpenApiSourceDetailsFields } from "./OpenApiSourceDetailsFields";
import { openApiPresets } from "../sdk/presets";
import type { SpecPreview, HeaderPreset, OAuth2Preset } from "../sdk/preview";
import {
  headerBindingSlot,
  oauth2ClientIdSlot,
  oauth2ClientSecretSlot,
  oauth2ConnectionSlot,
  queryParamBindingSlot,
  specFetchHeaderBindingSlot,
  specFetchQueryParamBindingSlot,
} from "../sdk/source-contracts";
import { OAuth2SourceConfig, type ServerInfo } from "../sdk/types";
import { expandServerUrlOptions } from "../sdk/openapi-utils";

export const OPENAPI_OAUTH_POPUP_NAME = "openapi-oauth";
export const OPENAPI_OAUTH_CALLBACK_PATH = "/api/oauth/callback";

const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeErrorMessage = Schema.decodeUnknownOption(ErrorMessage);

const errorMessageFromExit = (exit: Exit.Exit<unknown, unknown>, fallback: string): string =>
  Option.match(Option.flatMap(Exit.findErrorOption(exit), decodeErrorMessage), {
    onNone: () => fallback,
    onSome: ({ message }) => message,
  });

export const openApiOAuthConnectionId = (
  namespaceSlug: string,
  flow: OAuth2Preset["flow"],
): string =>
  flow === "clientCredentials"
    ? `openapi-oauth2-app-${namespaceSlug || "default"}`
    : `openapi-oauth2-user-${namespaceSlug || "default"}`;

/**
 * OpenAPI 3.x requires OAuth2 tokenUrl/authorizationUrl to be absolute,
 * but some specs ship relative paths like `/api/rest/v1/oauth/token`.
 * Resolve them against the source's chosen baseUrl so the backend can
 * fetch them directly and the absolute URL is what gets persisted on
 * OAuth2SourceConfig.
 */
export function resolveOAuthUrl(url: string, baseUrl: string): string {
  if (!url) return url;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL constructor normalizes provider metadata URLs
  try {
    new URL(url);
    return url;
  } catch {
    if (!baseUrl) return url;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL constructor resolves relative provider metadata URLs
    try {
      return new URL(url, baseUrl).toString();
    } catch {
      return url;
    }
  }
}

export function inferOAuthIssuerUrl(authorizationUrl: string): string | null {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL constructor normalizes provider metadata URLs
  try {
    return new URL(authorizationUrl).origin;
  } catch {
    return null;
  }
}

const standardOidcIdentityScopes = ["openid", "email", "profile"] as const;

const identityScopesForPreset = (
  identityScopes: OAuth2Preset["identityScopes"],
): readonly string[] => {
  if (identityScopes === false) return [];
  return identityScopes === "auto" ? standardOidcIdentityScopes : identityScopes;
};

const resolvedOAuthScopes = (
  apiScopes: Iterable<string>,
  identityScopes: OAuth2Preset["identityScopes"],
): string[] => {
  const merged = new Set(apiScopes);
  for (const scope of identityScopesForPreset(identityScopes)) merged.add(scope);
  return [...merged];
};

const splitOAuthScopes = (value: string | null): Set<string> =>
  new Set(value?.split(/\s+/).filter(Boolean) ?? []);

const mergeOAuthScopes = (...values: readonly Iterable<string>[]): string[] => {
  const merged = new Set<string>();
  for (const scopes of values) {
    for (const scope of scopes) {
      if (scope.trim()) merged.add(scope);
    }
  }
  return [...merged];
};

const missingOAuthScopes = (
  connection: { readonly oauthScope: string | null },
  requiredApiScopes: Iterable<string>,
): readonly string[] => {
  const granted = splitOAuthScopes(connection.oauthScope);
  return [...requiredApiScopes].filter((scope) => !granted.has(scope));
};

const isGoogleOAuthScope = (scope: string): boolean =>
  scope === "https://mail.google.com/" ||
  scope.startsWith("https://www.googleapis.com/auth/") ||
  scope.startsWith("https://www.google.com/m8/feeds/");

const hasGoogleOAuthScope = (connection: { readonly oauthScope: string | null }): boolean =>
  [...splitOAuthScopes(connection.oauthScope)].some(isGoogleOAuthScope);

const isGoogleOAuthUrl = (url: string): boolean => {
  if (!URL.canParse(url)) return false;
  const host = new URL(url).hostname.toLowerCase();
  return host === "accounts.google.com" || host === "oauth2.googleapis.com";
};

const isGoogleOAuthTarget = (preset: OAuth2Preset, baseUrl: string, specUrl: string): boolean => {
  if (isGoogleDiscoveryUrl(specUrl)) return true;
  if (Object.keys(preset.scopes).some(isGoogleOAuthScope)) return true;
  if (isGoogleOAuthUrl(resolveOAuthUrl(preset.tokenUrl, baseUrl))) return true;
  const authorizationUrl = Option.getOrElse(preset.authorizationUrl, () => "");
  return authorizationUrl ? isGoogleOAuthUrl(resolveOAuthUrl(authorizationUrl, baseUrl)) : false;
};

const googleAuthorizationParams = (enabled: boolean): Record<string, string> | undefined =>
  enabled
    ? {
        access_type: "offline",
      }
    : undefined;

const googleBroadScopeGroups: readonly {
  readonly broad: string;
  readonly prefixes: readonly string[];
}[] = [
  {
    broad: "https://mail.google.com/",
    prefixes: ["https://www.googleapis.com/auth/gmail."],
  },
  {
    broad: "https://www.googleapis.com/auth/calendar",
    prefixes: ["https://www.googleapis.com/auth/calendar."],
  },
  {
    broad: "https://www.googleapis.com/auth/drive",
    prefixes: ["https://www.googleapis.com/auth/drive."],
  },
];

const compactGoogleOAuthScopes = (scopes: Iterable<string>): string[] => {
  const ordered = mergeOAuthScopes(
    [...scopes].map((scope) =>
      scope === "https://www.googleapis.com/auth/userinfo.email"
        ? "email"
        : scope === "https://www.googleapis.com/auth/userinfo.profile"
          ? "profile"
          : scope,
    ),
  );
  const present = new Set(ordered);
  return ordered.filter(
    (scope) =>
      !googleBroadScopeGroups.some(
        (group) =>
          scope !== group.broad &&
          present.has(group.broad) &&
          group.prefixes.some((prefix) => scope.startsWith(prefix)),
      ),
  );
};

type OAuthConnectionChoice = {
  readonly id: ConnectionId;
  readonly scopeId: ScopeId;
  readonly provider: string;
  readonly identityLabel: string | null;
  readonly oauthScope: string | null;
  readonly missingApiScopes: readonly string[];
};

const specInputForAdd = (input: string) => {
  const value = input.trim();
  const parsed = Effect.runSyncExit(
    Effect.try({
      try: () => new URL(value),
      catch: () => null,
    }),
  );
  return Exit.isSuccess(parsed)
    ? isGoogleDiscoveryUrl(value)
      ? { kind: "googleDiscovery" as const, url: value }
      : { kind: "url" as const, url: value }
    : { kind: "blob" as const, value };
};

const isGoogleDiscoveryUrl = (url: string): boolean => {
  const trimmed = url.trim();
  if (!URL.canParse(trimmed)) return false;
  const parsed = new URL(trimmed);
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith("googleapis.com")) return false;
  return parsed.pathname.includes("/discovery/") || parsed.pathname.includes("$discovery");
};

const normalizePresetUrl = (url: string): string => {
  const trimmed = url.trim();
  if (!URL.canParse(trimmed)) return trimmed.replace(/\/$/, "");
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.searchParams.sort();
  return parsed.toString().replace(/\/$/, "");
};

type StrategySelection =
  | { readonly kind: "none" }
  | { readonly kind: "custom" }
  | { readonly kind: "header"; readonly presetIndex: number }
  | { readonly kind: "oauth2"; readonly presetIndex: number };

const serializeStrategy = (s: StrategySelection): string =>
  Match.value(s).pipe(
    Match.when({ kind: "none" }, () => "none"),
    Match.when({ kind: "custom" }, () => "custom"),
    Match.when({ kind: "header" }, (sel) => `header:${sel.presetIndex}`),
    Match.when({ kind: "oauth2" }, (sel) => `oauth2:${sel.presetIndex}`),
    Match.exhaustive,
  );

const parseStrategy = (value: string): StrategySelection => {
  if (value === "none") return { kind: "none" };
  if (value === "custom") return { kind: "custom" };
  if (value.startsWith("header:")) {
    return {
      kind: "header",
      presetIndex: Number(value.slice("header:".length)),
    };
  }
  if (value.startsWith("oauth2:")) {
    return {
      kind: "oauth2",
      presetIndex: Number(value.slice("oauth2:".length)),
    };
  }
  return { kind: "none" };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prefixForHeader(preset: HeaderPreset, headerName: string): string | undefined {
  const label = preset.label.toLowerCase();
  if (headerName.toLowerCase() === "authorization") {
    if (label.includes("bearer")) return "Bearer ";
    if (label.includes("basic")) return "Basic ";
  }
  return undefined;
}

function entriesFromSpecPreset(preset: HeaderPreset): HeaderState[] {
  return preset.secretHeaders.map((headerName) => {
    const prefix = prefixForHeader(preset, headerName);
    return {
      name: headerName,
      secretId: null,
      prefix,
      presetKey: matchPresetKey(headerName, prefix),
      fromPreset: true,
    };
  });
}

function OAuthConnectedAccount(props: {
  readonly scopeId: ScopeId;
  readonly connectionId: string;
  readonly scopeSummary: string;
  readonly sourceName: string;
  readonly onSetSourceName: (name: string) => void;
}) {
  const identityResult = useAtomValue(
    connectionIdentityAtom(props.scopeId, ConnectionId.make(props.connectionId)),
  );
  const identityResponse = AsyncResult.isSuccess(identityResult) ? identityResult.value : null;
  const identity = identityResponse?.status === "available" ? identityResponse : null;
  const accountLabel = identity?.email ?? identity?.name ?? identity?.username ?? null;
  const sourceNameWithAccount =
    accountLabel && !props.sourceName.includes(accountLabel)
      ? `${props.sourceName} - ${accountLabel}`
      : props.sourceName;
  const accountIsInSourceName = accountLabel !== null && props.sourceName === sourceNameWithAccount;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {identity?.picture ? (
            <img
              src={identity.picture}
              alt=""
              referrerPolicy="no-referrer"
              className="size-5 shrink-0 rounded-full"
            />
          ) : null}
          <span className="min-w-0 truncate text-foreground">
            {accountLabel ? `Connected as ${accountLabel}` : "Connected"}
            <span className="text-muted-foreground"> · {props.scopeSummary}</span>
          </span>
        </div>
        {accountLabel ? (
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            Source name: {sourceNameWithAccount}
          </div>
        ) : null}
      </div>
      {accountLabel ? (
        <Button
          variant="secondary"
          size="sm"
          className="h-6 shrink-0 px-2 text-[11px]"
          disabled={accountIsInSourceName}
          onClick={() => props.onSetSourceName(sourceNameWithAccount)}
        >
          {accountIsInSourceName ? "Name includes account" : "Add account name to source name"}
        </Button>
      ) : null}
    </div>
  );
}

function ExistingOAuthConnectionOption(props: {
  readonly connection: OAuthConnectionChoice;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly providerLabel: string;
}) {
  const identityResult = useAtomValue(
    connectionIdentityAtom(props.connection.scopeId, props.connection.id),
  );
  const identity =
    AsyncResult.isSuccess(identityResult) && identityResult.value.status === "available"
      ? identityResult.value
      : null;
  const label =
    identity?.email ?? identity?.name ?? props.connection.identityLabel ?? props.connection.id;
  const picture = identity?.picture;
  const needsPermission = props.connection.missingApiScopes.length > 0;
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={props.onSelect}
      className={`h-auto w-full justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
        props.selected
          ? "border-primary/40 bg-primary/10"
          : "border-border/60 bg-background hover:border-border hover:bg-muted/30"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        {picture ? (
          <img
            src={picture}
            alt=""
            referrerPolicy="no-referrer"
            className="size-5 shrink-0 rounded-full"
          />
        ) : (
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[10px] text-muted-foreground">
            {label.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="min-w-0">
          <span className="block truncate text-[12px] text-foreground">{label}</span>
          <span className="block truncate text-[10px] text-muted-foreground">
            {needsPermission
              ? `Needs ${props.providerLabel} permission`
              : (props.connection.identityLabel ?? "Already connected")}
          </span>
        </span>
      </span>
      <span className="shrink-0 text-[11px] font-medium text-foreground">
        {props.selected ? "Selected" : needsPermission ? "Continue" : "Use account"}
      </span>
    </Button>
  );
}

const secretStorageDescription = (label: string): string =>
  label === "Personal"
    ? "Only you can use this secret."
    : "Everyone in the organization can use this secret.";

// ---------------------------------------------------------------------------
// Main component — single progressive form
// ---------------------------------------------------------------------------

export default function AddOpenApiSource(props: {
  onComplete: () => void;
  onCancel: () => void;
  initialUrl?: string;
  initialNamespace?: string;
}) {
  // Spec input
  const [specUrl, setSpecUrl] = useState(props.initialUrl ?? "");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  // After analysis
  const [preview, setPreview] = useState<SpecPreview | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const identity = useSourceIdentity({
    fallbackName: preview ? Option.getOrElse(preview.title, () => "") : "",
    fallbackNamespace: props.initialNamespace,
  });

  // Auth
  const [strategy, setStrategy] = useState<StrategySelection>({ kind: "none" });
  const [customHeaders, setCustomHeaders] = useState<HeaderState[]>([]);
  const [specFetchCredentials, setSpecFetchCredentials] = useState<HttpCredentialsState>(() =>
    emptyHttpCredentials(),
  );
  const [specFetchCredentialsOpen, setSpecFetchCredentialsOpen] = useState(false);
  const [runtimeCredentials, setRuntimeCredentials] = useState<HttpCredentialsState>(() =>
    emptyHttpCredentials(),
  );

  // OAuth2 state (only populated while an oauth2 preset is selected)
  const [oauth2ClientIdSecretId, setOauth2ClientIdSecretId] = useState<string | null>(null);
  const [oauth2ClientSecretSecretId, setOauth2ClientSecretSecretId] = useState<string | null>(null);
  const [oauth2ClientIdScope, setOauth2ClientIdScope] = useState<ScopeId | null>(null);
  const [oauth2ClientSecretScope, setOauth2ClientSecretScope] = useState<ScopeId | null>(null);
  const [oauth2SelectedScopes, setOauth2SelectedScopes] = useState<Set<string>>(new Set());
  const [includeOAuth2IdentityScopes, setIncludeOAuth2IdentityScopes] = useState(true);
  const [oauth2ScopesOpen, setOauth2ScopesOpen] = useState(false);
  const [oauth2AuthState, setOauth2AuthState] = useState<{
    readonly fingerprint: string;
    readonly auth: { readonly connectionId: string };
  } | null>(null);
  const [startingOAuth, setStartingOAuth] = useState(false);
  const [oauth2Error, setOauth2Error] = useState<string | null>(null);

  // Submit
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const scopeId = useScope();
  const scopeStack = useScopeStack();
  const credentialScopeOptions = useMemo(
    () =>
      scopeStack.map((entry, index) => ({
        scopeId: entry.id,
        label: index === 0 ? "Personal" : entry.name || "Organization",
        description: secretStorageDescription(
          index === 0 ? "Personal" : entry.name || "Organization",
        ),
      })),
    [scopeStack],
  );
  const defaultOAuthTokenTargetScope = credentialScopeOptions[0]?.scopeId ?? scopeId;
  const [oauthTokenTargetScope, setOAuthTokenTargetScope] = useState<ScopeId>(
    defaultOAuthTokenTargetScope,
  );
  useEffect(() => {
    if (!credentialScopeOptions.some((option) => option.scopeId === oauthTokenTargetScope)) {
      setOAuthTokenTargetScope(defaultOAuthTokenTargetScope);
    }
  }, [credentialScopeOptions, defaultOAuthTokenTargetScope, oauthTokenTargetScope]);
  useEffect(() => {
    if (
      oauth2ClientIdScope &&
      !credentialScopeOptions.some((option) => option.scopeId === oauth2ClientIdScope)
    ) {
      setOauth2ClientIdScope(null);
      setOauth2ClientIdSecretId(null);
      setOauth2AuthState(null);
    }
    if (
      oauth2ClientSecretScope &&
      !credentialScopeOptions.some((option) => option.scopeId === oauth2ClientSecretScope)
    ) {
      setOauth2ClientSecretScope(null);
      setOauth2ClientSecretSecretId(null);
      setOauth2AuthState(null);
    }
  }, [credentialScopeOptions, oauth2ClientIdScope, oauth2ClientSecretScope]);
  const doPreview = useAtomSet(previewOpenApiSpec, { mode: "promiseExit" });
  const doAdd = useAtomSet(addOpenApiSpecOptimistic(scopeId), {
    mode: "promiseExit",
  });
  const doStartOAuth = useAtomSet(startOAuth, { mode: "promiseExit" });
  const doSetBinding = useAtomSet(setSourceCredentialBinding, {
    mode: "promiseExit",
  });
  const connectionsResult = useAtomValue(connectionsAtom(scopeId));
  const secretList = useSecretPickerSecrets();
  const oauth = useOAuthPopupFlow<OAuthCompletionPayload>({
    popupName: OPENAPI_OAUTH_POPUP_NAME,
    popupBlockedMessage: "OAuth popup was blocked by the browser",
    popupClosedMessage: "OAuth cancelled - popup was closed before completing the flow.",
    startErrorMessage: "Failed to start OAuth",
  });

  // Keep the latest handleAnalyze in a ref so the debounced effect doesn't
  // need it as a dependency (it closes over fresh state).
  const handleAnalyzeRef = useRef<() => void>(() => {});

  // Auto-analyze whenever the spec input changes, with a short debounce so
  // typing/pasting doesn't fire a request on every keystroke.
  useEffect(() => {
    const trimmed = specUrl.trim();
    if (!trimmed) return;
    if (preview) return;
    const handle = setTimeout(() => {
      handleAnalyzeRef.current();
    }, 400);
    return () => clearTimeout(handle);
  }, [specUrl, preview]);

  // ---- Derived state ----

  const expandServerOptions = (server: ServerInfo) => {
    return expandServerUrlOptions(server).map((value) => ({
      value,
      label: value,
    }));
  };

  const servers: readonly ServerInfo[] = preview?.servers ?? [];
  const baseUrlOptions = Array.from(
    new Map(servers.flatMap(expandServerOptions).map((option) => [option.value, option])).values(),
  );
  const previewPresetIcon =
    openApiPresets.find((preset) => normalizePresetUrl(preset.url) === normalizePresetUrl(specUrl))
      ?.icon ?? null;

  const resolvedBaseUrl = baseUrl.trim();
  const sourceScope = ScopeId.make(scopeId);

  type PendingSecretBinding = {
    readonly slot: string;
    readonly secretId: string;
    readonly scope: ScopeId;
    readonly secretScope: ScopeId;
  };

  const configuredHeaders: Record<string, { kind: "secret"; prefix?: string }> = {};
  const headerBindings: PendingSecretBinding[] = [];
  const configuredQueryParams: Record<string, string | { kind: "secret"; prefix?: string }> = {};
  const queryParamBindings: PendingSecretBinding[] = [];
  for (const ch of customHeaders) {
    if (!ch.name.trim()) continue;
    const slot = headerBindingSlot(ch.name.trim());
    configuredHeaders[ch.name.trim()] = { kind: "secret", prefix: ch.prefix };
    if (ch.secretId) {
      const targetScope = ch.targetScope ?? sourceScope;
      headerBindings.push({
        slot,
        secretId: ch.secretId,
        scope: targetScope,
        secretScope: ch.secretScope ?? targetScope,
      });
    }
  }
  for (const param of runtimeCredentials.queryParams) {
    const name = param.name.trim();
    if (!name) continue;
    if (param.secretId) {
      const slot = queryParamBindingSlot(name);
      const targetScope = param.targetScope ?? sourceScope;
      configuredQueryParams[name] = { kind: "secret", prefix: param.prefix };
      queryParamBindings.push({
        slot,
        secretId: param.secretId,
        scope: targetScope,
        secretScope: param.secretScope ?? targetScope,
      });
      continue;
    }
    if (param.literalValue?.trim()) {
      configuredQueryParams[name] = param.literalValue.trim();
    }
  }
  const configuredSpecFetchHeaders: Record<string, { kind: "secret"; prefix?: string }> = {};
  const configuredSpecFetchQueryParams: Record<
    string,
    string | { kind: "secret"; prefix?: string }
  > = {};
  const specFetchBindings: PendingSecretBinding[] = [];
  for (const header of specFetchCredentials.headers) {
    const name = header.name.trim();
    if (!name || !header.secretId) continue;
    const targetScope = header.targetScope ?? sourceScope;
    configuredSpecFetchHeaders[name] = { kind: "secret", prefix: header.prefix };
    specFetchBindings.push({
      slot: specFetchHeaderBindingSlot(name),
      secretId: header.secretId,
      scope: targetScope,
      secretScope: header.secretScope ?? targetScope,
    });
  }
  for (const param of specFetchCredentials.queryParams) {
    const name = param.name.trim();
    if (!name) continue;
    if (param.secretId) {
      const targetScope = param.targetScope ?? sourceScope;
      configuredSpecFetchQueryParams[name] = { kind: "secret", prefix: param.prefix };
      specFetchBindings.push({
        slot: specFetchQueryParamBindingSlot(name),
        secretId: param.secretId,
        scope: targetScope,
        secretScope: param.secretScope ?? targetScope,
      });
      continue;
    }
    if (param.literalValue?.trim()) {
      configuredSpecFetchQueryParams[name] = param.literalValue.trim();
    }
  }
  const configuredSpecFetchCredentials =
    Object.keys(configuredSpecFetchHeaders).length > 0 ||
    Object.keys(configuredSpecFetchQueryParams).length > 0
      ? {
          ...(Object.keys(configuredSpecFetchHeaders).length > 0
            ? { headers: configuredSpecFetchHeaders }
            : {}),
          ...(Object.keys(configuredSpecFetchQueryParams).length > 0
            ? { queryParams: configuredSpecFetchQueryParams }
            : {}),
        }
      : null;

  const oauth2Presets: readonly OAuth2Preset[] = preview?.oauth2Presets ?? [];
  const oauth2RedirectUrl = oauthCallbackUrl(OPENAPI_OAUTH_CALLBACK_PATH);
  // Stable source id derivation. Matches the value `handleAdd` sends as
  // `namespace`, and is also the default credential key when the user
  // does not provide a more explicit shared connection id.
  const resolvedSourceId =
    slugifyNamespace(identity.namespace) ||
    (preview ? Option.getOrElse(preview.title, () => "openapi") : "openapi");
  const resolvedDisplayName =
    identity.name.trim() ||
    (preview ? Option.getOrElse(preview.title, () => resolvedSourceId) : resolvedSourceId);
  const selectedOAuth2Preset: OAuth2Preset | null =
    strategy.kind === "oauth2" ? (oauth2Presets[strategy.presetIndex] ?? null) : null;
  const selectedOAuth2Fingerprint = selectedOAuth2Preset
    ? [
        resolvedBaseUrl,
        selectedOAuth2Preset.securitySchemeName,
        selectedOAuth2Preset.flow,
        selectedOAuth2Preset.tokenUrl,
        Option.getOrElse(selectedOAuth2Preset.authorizationUrl, () => ""),
      ].join("\n")
    : "";
  const oauth2Auth =
    oauth2AuthState?.fingerprint === selectedOAuth2Fingerprint ? oauth2AuthState.auth : null;
  const selectedOAuth2AvailableIdentityScopes = selectedOAuth2Preset
    ? identityScopesForPreset(selectedOAuth2Preset.identityScopes)
    : [];
  const selectedOAuth2IsGoogle = selectedOAuth2Preset
    ? isGoogleOAuthTarget(selectedOAuth2Preset, resolvedBaseUrl, specUrl)
    : false;
  const selectedOAuth2ProviderLabel = selectedOAuth2IsGoogle ? "Google" : "OAuth";
  const configuredOAuth2IdentityScopes =
    selectedOAuth2Preset && includeOAuth2IdentityScopes
      ? selectedOAuth2Preset.identityScopes
      : false;
  const selectedOAuth2Scopes = useMemo(
    () =>
      selectedOAuth2Preset
        ? resolvedOAuthScopes(oauth2SelectedScopes, configuredOAuth2IdentityScopes)
        : [...oauth2SelectedScopes],
    [configuredOAuth2IdentityScopes, oauth2SelectedScopes, selectedOAuth2Preset],
  );
  const existingOAuthConnections = useMemo(() => {
    if (
      !selectedOAuth2Preset ||
      selectedOAuth2Preset.flow !== "authorizationCode" ||
      !AsyncResult.isSuccess(connectionsResult)
    ) {
      return [];
    }
    return connectionsResult.value
      .flatMap((connection) => {
        if (connection.provider !== "oauth2") return [];
        const missingApiScopes = missingOAuthScopes(connection, oauth2SelectedScopes);
        if (missingApiScopes.length === 0) {
          return [{ ...connection, missingApiScopes }];
        }
        if (selectedOAuth2IsGoogle && hasGoogleOAuthScope(connection)) {
          return [{ ...connection, missingApiScopes }];
        }
        return [];
      })
      .sort((a, b) => a.missingApiScopes.length - b.missingApiScopes.length);
  }, [connectionsResult, oauth2SelectedScopes, selectedOAuth2IsGoogle, selectedOAuth2Preset]);

  const configuredOAuth2 =
    strategy.kind === "oauth2" && selectedOAuth2Preset
      ? OAuth2SourceConfig.make({
          kind: "oauth2",
          securitySchemeName: selectedOAuth2Preset.securitySchemeName,
          flow: selectedOAuth2Preset.flow,
          tokenUrl: resolveOAuthUrl(selectedOAuth2Preset.tokenUrl, resolvedBaseUrl),
          authorizationUrl:
            selectedOAuth2Preset.flow === "authorizationCode"
              ? resolveOAuthUrl(
                  Option.getOrElse(selectedOAuth2Preset.authorizationUrl, () => ""),
                  resolvedBaseUrl,
                ) || null
              : null,
          clientIdSlot: oauth2ClientIdSlot(selectedOAuth2Preset.securitySchemeName),
          // Authorization-code specs can still be confidential clients
          // (Spotify is one example). Persist the slot even when the value is
          // deferred so the edit screen can collect the secret later.
          clientSecretSlot: oauth2ClientSecretSlot(selectedOAuth2Preset.securitySchemeName),
          connectionSlot: oauth2ConnectionSlot(selectedOAuth2Preset.securitySchemeName),
          scopes: [...oauth2SelectedScopes],
          identityScopes: configuredOAuth2IdentityScopes,
        })
      : null;
  const hasHeaders = Object.keys(configuredHeaders).length > 0;
  const oauth2Busy = startingOAuth || oauth.busy;
  const canConnectOAuth2 = Boolean(oauth2ClientIdSecretId) && resolvedBaseUrl.length > 0;
  const hasIncompleteHeaderCredentials =
    strategy.kind !== "none" &&
    strategy.kind !== "oauth2" &&
    customHeaders.some((header) => header.name.trim() && !header.secretId);
  const hasIncompleteQueryCredentials = runtimeCredentials.queryParams.some(
    (param) => param.name.trim() && !param.secretId && !param.literalValue?.trim(),
  );
  const hasIncompleteSpecFetchCredentials =
    specFetchCredentials.headers.some((header) => header.name.trim() && !header.secretId) ||
    specFetchCredentials.queryParams.some(
      (param) => param.name.trim() && !param.secretId && !param.literalValue?.trim(),
    );
  const willAddWithoutInitialCredentials =
    Boolean(selectedOAuth2Preset && !oauth2Auth) ||
    hasIncompleteSpecFetchCredentials ||
    hasIncompleteHeaderCredentials ||
    hasIncompleteQueryCredentials;

  const canAdd = preview !== null && resolvedBaseUrl.length > 0;

  // ---- Handlers ----

  const handleAnalyze = async () => {
    setAnalyzing(true);
    setAnalyzeError(null);
    setAddError(null);
    const credentials = serializeHttpCredentials(specFetchCredentials);
    const exit = await doPreview({
      params: { scopeId },
      payload: {
        spec: specUrl,
        specFetchCredentials: credentials,
      },
    });
    if (Exit.isFailure(exit)) {
      setAnalyzeError(errorMessageFromExit(exit, "Failed to parse spec"));
      setAnalyzing(false);
      return;
    }
    const result = exit.value;
    setPreview(result);

    const firstServer = result.servers[0];
    setBaseUrl(firstServer ? (expandServerOptions(firstServer)[0]?.value ?? "") : "");

    const firstPreset = result.headerPresets[0];
    if (firstPreset) {
      setStrategy({ kind: "header", presetIndex: 0 });
      setCustomHeaders(entriesFromSpecPreset(firstPreset));
    } else if (result.oauth2Presets[0]) {
      setStrategy({ kind: "oauth2", presetIndex: 0 });
      setCustomHeaders([]);
      setOauth2SelectedScopes(new Set(Object.keys(result.oauth2Presets[0].scopes)));
      setIncludeOAuth2IdentityScopes(result.oauth2Presets[0].identityScopes !== false);
    } else {
      // No header presets — default to "custom" so the headers editor is
      // visible immediately. Specs with no `security` block (e.g. Microsoft
      // Graph) would otherwise leave the user staring at just the
      // Authentication heading with no way to add headers.
      setStrategy({ kind: "custom" });
      setCustomHeaders([]);
    }
    setAnalyzing(false);
  };

  handleAnalyzeRef.current = handleAnalyze;

  const selectStrategy = (next: StrategySelection) => {
    setStrategy(next);
    // Clear any stale OAuth grant whenever the strategy changes away from oauth2.
    if (next.kind !== "oauth2") {
      setOauth2AuthState(null);
      setOauth2Error(null);
    }
    Match.value(next).pipe(
      Match.when({ kind: "none" }, () => {
        setCustomHeaders([]);
      }),
      Match.when({ kind: "custom" }, () => {
        const userHeaders = customHeaders.filter((h) => !h.fromPreset);
        setCustomHeaders(userHeaders.length > 0 ? userHeaders : []);
      }),
      Match.when({ kind: "header" }, (n) => {
        const preset = preview?.headerPresets[n.presetIndex];
        if (!preset) return;
        const userHeaders = customHeaders.filter((h) => !h.fromPreset);
        setCustomHeaders([...entriesFromSpecPreset(preset), ...userHeaders]);
      }),
      Match.when({ kind: "oauth2" }, (n) => {
        setCustomHeaders([]);
        const preset = preview?.oauth2Presets[n.presetIndex];
        if (preset) {
          setOauth2SelectedScopes(new Set(Object.keys(preset.scopes)));
          setIncludeOAuth2IdentityScopes(preset.identityScopes !== false);
        }
      }),
      Match.exhaustive,
    );
  };

  const handleHeadersChange = (next: HeaderState[]) => {
    setCustomHeaders(next);
    if (strategy.kind === "header" && next.every((h) => !h.fromPreset)) {
      setStrategy(next.length === 0 ? { kind: "none" } : { kind: "custom" });
    }
  };

  const toggleOAuth2Scope = (scope: string) => {
    setOauth2SelectedScopes((prev) => {
      const copy = new Set(prev);
      if (copy.has(scope)) copy.delete(scope);
      else copy.add(scope);
      return copy;
    });
    // Changing scopes invalidates any previously-granted token.
    setOauth2AuthState(null);
  };

  const handleConnectOAuth2 = useCallback(
    async (existingConnection?: OAuthConnectionChoice) => {
      if (!selectedOAuth2Preset || !preview) return;
      oauth.cancel();
      setOauth2Error(null);
      const displayName = identity.name.trim() || selectedOAuth2Preset.securitySchemeName;
      const tokenTargetScope = existingConnection?.scopeId ?? oauthTokenTargetScope;
      const connectionId =
        existingConnection?.id ??
        openApiOAuthConnectionId(resolvedSourceId, selectedOAuth2Preset.flow);
      const scopesForAuthorization = existingConnection
        ? mergeOAuthScopes(
            splitOAuthScopes(existingConnection.oauthScope),
            selectedOAuth2IsGoogle ? oauth2SelectedScopes : selectedOAuth2Scopes,
          )
        : selectedOAuth2Scopes;
      const scopesForProviderAuthorization = selectedOAuth2IsGoogle
        ? compactGoogleOAuthScopes(scopesForAuthorization)
        : undefined;
      const extraAuthorizationParams = googleAuthorizationParams(selectedOAuth2IsGoogle);

      const tokenUrl = resolveOAuthUrl(selectedOAuth2Preset.tokenUrl, resolvedBaseUrl);
      const clientIdSecretScope = oauth2ClientIdScope ?? sourceScope;
      const clientSecretSecretScope = oauth2ClientSecretScope ?? sourceScope;

      if (selectedOAuth2Preset.flow === "clientCredentials") {
        if (!oauth2ClientIdSecretId) return;
        // RFC 6749 §4.4: no user-interactive consent step. The client_secret
        // is mandatory; the backend exchanges tokens inline and returns a
        // completed Connection we bind to the source's connection slot.
        if (!oauth2ClientSecretSecretId) {
          setOauth2Error("client_credentials requires a client secret");
          return;
        }
        setStartingOAuth(true);
        const exit = await doStartOAuth({
          params: { scopeId: tokenTargetScope },
          payload: {
            endpoint: tokenUrl,
            redirectUrl: tokenUrl,
            connectionId,
            tokenScope: tokenTargetScope,
            strategy: {
              kind: "client-credentials",
              tokenEndpoint: tokenUrl,
              clientIdSecretId: oauth2ClientIdSecretId,
              clientIdSecretScopeId: String(clientIdSecretScope),
              clientSecretSecretId: oauth2ClientSecretSecretId,
              clientSecretSecretScopeId: String(clientSecretSecretScope),
              scopes: scopesForAuthorization,
            },
            pluginId: "openapi",
            identityLabel: `${displayName} OAuth`,
          },
        });
        setStartingOAuth(false);
        if (Exit.isFailure(exit)) {
          setOauth2Error(errorMessageFromExit(exit, "Failed to start OAuth"));
          return;
        }
        const response = exit.value;
        if (!response.completedConnection) {
          setOauth2Error("client_credentials flow did not mint a connection");
          return;
        }
        setOAuthTokenTargetScope(tokenTargetScope);
        setOauth2AuthState({
          fingerprint: selectedOAuth2Fingerprint,
          auth: { connectionId: response.completedConnection.connectionId },
        });
        setOauth2Error(null);
        return;
      }
      if (!existingConnection && !oauth2ClientIdSecretId) return;

      const authorizationUrl = resolveOAuthUrl(
        Option.getOrElse(selectedOAuth2Preset.authorizationUrl, () => ""),
        resolvedBaseUrl,
      );
      const issuerUrl = inferOAuthIssuerUrl(authorizationUrl);
      const authorizationStrategy = existingConnection
        ? {
            kind: "authorization-code-existing-client" as const,
            authorizationEndpoint: authorizationUrl,
            tokenEndpoint: tokenUrl,
            issuerUrl,
            scopes: scopesForAuthorization,
            ...(scopesForProviderAuthorization && scopesForProviderAuthorization.length > 0
              ? { authorizationScopes: scopesForProviderAuthorization }
              : {}),
            extraAuthorizationParams,
          }
        : oauth2ClientIdSecretId
          ? {
              kind: "authorization-code" as const,
              authorizationEndpoint: authorizationUrl,
              tokenEndpoint: tokenUrl,
              issuerUrl,
              clientIdSecretId: oauth2ClientIdSecretId,
              clientIdSecretScopeId: String(clientIdSecretScope),
              clientSecretSecretId: oauth2ClientSecretSecretId ?? null,
              clientSecretSecretScopeId: oauth2ClientSecretSecretId
                ? String(clientSecretSecretScope)
                : null,
              scopes: scopesForAuthorization,
              ...(scopesForProviderAuthorization && scopesForProviderAuthorization.length > 0
                ? { authorizationScopes: scopesForProviderAuthorization }
                : {}),
              extraAuthorizationParams,
            }
          : null;
      if (!authorizationStrategy) return;

      await oauth.openAuthorization({
        tokenScope: tokenTargetScope,
        run: async () => {
          const exit = await doStartOAuth({
            params: { scopeId: tokenTargetScope },
            payload: {
              endpoint: authorizationUrl,
              connectionId,
              tokenScope: tokenTargetScope,
              redirectUrl: oauth2RedirectUrl,
              strategy: authorizationStrategy,
              pluginId: "openapi",
              identityLabel: existingConnection?.identityLabel ?? `${displayName} OAuth`,
            },
          });
          if (Exit.isFailure(exit)) {
            // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: OAuth popup API represents start failure by rejecting run()
            throw new Error(errorMessageFromExit(exit, "Failed to start OAuth"));
          }
          const response = exit.value;
          if (response.authorizationUrl === null) {
            // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: OAuth popup API represents start failure by rejecting run()
            throw new Error("Unexpected response flow from server");
          }
          return {
            sessionId: response.sessionId,
            authorizationUrl: response.authorizationUrl,
          };
        },
        onSuccess: (result) => {
          setOAuthTokenTargetScope(tokenTargetScope);
          setOauth2AuthState({
            fingerprint: selectedOAuth2Fingerprint,
            auth: { connectionId: result.connectionId },
          });
          setOauth2Error(null);
        },
        onError: (message) => {
          setStartingOAuth(false);
          setOauth2Error(message);
        },
      });
    },
    [
      selectedOAuth2Preset,
      oauth2ClientIdSecretId,
      oauth2ClientSecretSecretId,
      oauth2SelectedScopes,
      selectedOAuth2Scopes,
      selectedOAuth2IsGoogle,
      oauth2RedirectUrl,
      resolvedBaseUrl,
      preview,
      doStartOAuth,
      identity.name,
      resolvedSourceId,
      selectedOAuth2Fingerprint,
      oauth,
      oauthTokenTargetScope,
      oauth2ClientIdScope,
      oauth2ClientSecretScope,
      sourceScope,
    ],
  );

  const handleCancelOAuth2 = useCallback(() => {
    oauth.cancel();
    setStartingOAuth(false);
    setOauth2Error(null);
  }, [oauth]);

  const handleReuseOAuthConnection = useCallback(
    (connection: OAuthConnectionChoice) => {
      oauth.cancel();
      setStartingOAuth(false);
      setOAuthTokenTargetScope(connection.scopeId);
      setOauth2AuthState({
        fingerprint: selectedOAuth2Fingerprint,
        auth: { connectionId: connection.id },
      });
      setOauth2Error(null);
    },
    [oauth, selectedOAuth2Fingerprint],
  );

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);
    const namespace = resolvedSourceId;
    const exit = await doAdd({
      params: { scopeId },
      payload: {
        spec: specInputForAdd(specUrl),
        name: resolvedDisplayName,
        namespace,
        baseUrl: resolvedBaseUrl,
        ...(configuredSpecFetchCredentials
          ? { specFetchCredentials: configuredSpecFetchCredentials }
          : {}),
        ...(hasHeaders ? { headers: configuredHeaders } : {}),
        ...(Object.keys(configuredQueryParams).length > 0
          ? { queryParams: configuredQueryParams }
          : {}),
        ...(configuredOAuth2 ? { oauth2: configuredOAuth2 } : {}),
      },
      reactivityKeys: addSpecWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setAddError(errorMessageFromExit(exit, "Failed to add source"));
      setAdding(false);
      return;
    }

    const sourceId = exit.value.namespace;
    const oauthTokenBindingScope = ScopeId.make(oauthTokenTargetScope);
    const clientIdBindingScope = oauth2ClientIdScope ?? sourceScope;
    const clientSecretBindingScope = oauth2ClientSecretScope ?? sourceScope;

    for (const binding of headerBindings) {
      const bindingExit = await doSetBinding({
        params: { scopeId },
        payload: SetSourceCredentialBindingInput.make({
          source: { id: sourceId, scope: sourceScope },
          scope: binding.scope,
          slotKey: binding.slot,
          value: {
            kind: "secret",
            secretId: SecretId.make(binding.secretId),
            secretScopeId: binding.secretScope,
          },
        }),
        reactivityKeys: bindingWriteKeys,
      });
      if (Exit.isFailure(bindingExit)) {
        setAddError(errorMessageFromExit(bindingExit, "Failed to add source"));
        setAdding(false);
        return;
      }
    }

    for (const binding of queryParamBindings) {
      const bindingExit = await doSetBinding({
        params: { scopeId },
        payload: SetSourceCredentialBindingInput.make({
          source: { id: sourceId, scope: sourceScope },
          scope: binding.scope,
          slotKey: binding.slot,
          value: {
            kind: "secret",
            secretId: SecretId.make(binding.secretId),
            secretScopeId: binding.secretScope,
          },
        }),
        reactivityKeys: bindingWriteKeys,
      });
      if (Exit.isFailure(bindingExit)) {
        setAddError(errorMessageFromExit(bindingExit, "Failed to add source"));
        setAdding(false);
        return;
      }
    }

    for (const binding of specFetchBindings) {
      const bindingExit = await doSetBinding({
        params: { scopeId },
        payload: SetSourceCredentialBindingInput.make({
          source: { id: sourceId, scope: sourceScope },
          scope: binding.scope,
          slotKey: binding.slot,
          value: {
            kind: "secret",
            secretId: SecretId.make(binding.secretId),
            secretScopeId: binding.secretScope,
          },
        }),
        reactivityKeys: bindingWriteKeys,
      });
      if (Exit.isFailure(bindingExit)) {
        setAddError(errorMessageFromExit(bindingExit, "Failed to add source"));
        setAdding(false);
        return;
      }
    }

    if (configuredOAuth2 && oauth2ClientIdSecretId) {
      const bindingExit = await doSetBinding({
        params: { scopeId },
        payload: SetSourceCredentialBindingInput.make({
          source: { id: sourceId, scope: sourceScope },
          scope: clientIdBindingScope,
          slotKey: configuredOAuth2.clientIdSlot,
          value: {
            kind: "secret",
            secretId: SecretId.make(oauth2ClientIdSecretId),
            secretScopeId: clientIdBindingScope,
          },
        }),
        reactivityKeys: bindingWriteKeys,
      });
      if (Exit.isFailure(bindingExit)) {
        setAddError(errorMessageFromExit(bindingExit, "Failed to add source"));
        setAdding(false);
        return;
      }
    }

    if (configuredOAuth2?.clientSecretSlot && oauth2ClientSecretSecretId) {
      const bindingExit = await doSetBinding({
        params: { scopeId },
        payload: SetSourceCredentialBindingInput.make({
          source: { id: sourceId, scope: sourceScope },
          scope: clientSecretBindingScope,
          slotKey: configuredOAuth2.clientSecretSlot,
          value: {
            kind: "secret",
            secretId: SecretId.make(oauth2ClientSecretSecretId),
            secretScopeId: clientSecretBindingScope,
          },
        }),
        reactivityKeys: bindingWriteKeys,
      });
      if (Exit.isFailure(bindingExit)) {
        setAddError(errorMessageFromExit(bindingExit, "Failed to add source"));
        setAdding(false);
        return;
      }
    }

    if (configuredOAuth2 && oauth2Auth) {
      const bindingExit = await doSetBinding({
        params: { scopeId },
        payload: SetSourceCredentialBindingInput.make({
          source: { id: sourceId, scope: sourceScope },
          scope: oauthTokenBindingScope,
          slotKey: configuredOAuth2.connectionSlot,
          value: {
            kind: "connection",
            connectionId: ConnectionId.make(oauth2Auth.connectionId),
          },
        }),
        reactivityKeys: bindingWriteKeys,
      });
      if (Exit.isFailure(bindingExit)) {
        setAddError(errorMessageFromExit(bindingExit, "Failed to add source"));
        setAdding(false);
        return;
      }
    }

    props.onComplete();
  };

  // ---- Render ----

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Add OpenAPI Source</h1>
      </div>

      {!preview && (
        <>
          {/* ── Spec input ── */}
          <CardStack>
            <CardStackContent className="border-t-0">
              <CardStackEntryField
                label="OpenAPI Spec"
                hint="Paste a URL or raw JSON/YAML content."
              >
                <div className="relative">
                  <Textarea
                    value={specUrl}
                    onChange={(e) => {
                      setSpecUrl((e.target as HTMLTextAreaElement).value);
                    }}
                    placeholder="https://api.example.com/openapi.json"
                    rows={3}
                    maxRows={10}
                    className="font-mono text-sm"
                  />
                  {analyzing && (
                    <div className="pointer-events-none absolute right-2 top-2">
                      <IOSSpinner className="size-4" />
                    </div>
                  )}
                </div>
              </CardStackEntryField>
            </CardStackContent>
          </CardStack>

          <Collapsible
            open={specFetchCredentialsOpen}
            onOpenChange={setSpecFetchCredentialsOpen}
            className="space-y-3"
          >
            <CollapsibleTrigger asChild>
              <Button variant="outline" size="sm" className="self-start">
                {specFetchCredentialsOpen ? "Hide spec credentials" : "Add spec credentials"}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <HttpCredentialsEditor
                credentials={specFetchCredentials}
                onChange={setSpecFetchCredentials}
                existingSecrets={secretList}
                sourceName={identity.name}
                targetScope={sourceScope}
                credentialScopeOptions={credentialScopeOptions}
                bindingScopeOptions={credentialScopeOptions}
                labels={{
                  headers: "Spec fetch headers",
                  queryParams: "Spec fetch query parameters",
                }}
              />
            </CollapsibleContent>
          </Collapsible>
        </>
      )}

      {/* ── Source information card (shown after analysis) ── */}
      {preview ? (
        <OpenApiSourceDetailsFields
          title={Option.getOrElse(preview.title, () => "API")}
          description={`${Option.getOrElse(preview.version, () => "")}${
            Option.isSome(preview.version) ? " · " : ""
          }${preview.operationCount} operation${preview.operationCount !== 1 ? "s" : ""}${
            preview.tags.length > 0
              ? ` · ${preview.tags.length} tag${preview.tags.length !== 1 ? "s" : ""}`
              : ""
          }`}
          identity={identity}
          baseUrl={resolvedBaseUrl}
          onBaseUrlChange={setBaseUrl}
          baseUrlOptions={baseUrlOptions}
          specUrl={specUrl}
          onSpecUrlChange={(value) => {
            setSpecUrl(value);
            setPreview(null);
            setBaseUrl("");
            setCustomHeaders([]);
            setStrategy({ kind: "none" });
            setOauth2AuthState(null);
            setOauth2Error(null);
          }}
          faviconIcon={previewPresetIcon}
          faviconUrl={resolvedBaseUrl}
          baseUrlMissingMessage="A base URL is required to make requests."
        />
      ) : null}

      {analyzeError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-[12px] text-destructive">{analyzeError}</p>
        </div>
      )}

      {/* ── Everything below appears after analysis ── */}
      {preview && (
        <>
          <section className="space-y-2.5">
            <FieldLabel>Authentication method</FieldLabel>
            {/* RadioGroup always renders so the static Custom + None radios
                stay visible for specs with no security schemes (e.g. MS Graph).
                The preset .map() blocks below render nothing when their arrays
                are empty. */}
            <RadioGroup
              value={serializeStrategy(strategy)}
              onValueChange={(value) => selectStrategy(parseStrategy(value))}
              className="gap-1.5"
            >
              {preview.headerPresets.map((preset, i) => {
                const selected = strategy.kind === "header" && strategy.presetIndex === i;
                return (
                  <Label
                    key={`header-${i}`}
                    className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                      selected
                        ? "border-primary/50 bg-primary/[0.03]"
                        : "border-border hover:bg-accent/50"
                    }`}
                  >
                    <RadioGroupItem value={`header:${i}`} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-foreground">{preset.label}</div>
                      {preset.secretHeaders.length > 0 && (
                        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                          {preset.secretHeaders.join(" · ")}
                        </div>
                      )}
                    </div>
                  </Label>
                );
              })}
              {oauth2Presets.map((preset, i) => {
                const selected = strategy.kind === "oauth2" && strategy.presetIndex === i;
                const scopeCount = Object.keys(preset.scopes).length;
                return (
                  <Label
                    key={`oauth2-${i}`}
                    className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                      selected
                        ? "border-primary/50 bg-primary/[0.03]"
                        : "border-border hover:bg-accent/50"
                    }`}
                  >
                    <RadioGroupItem value={`oauth2:${i}`} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-foreground">{preset.label}</div>
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        {scopeCount} scope{scopeCount === 1 ? "" : "s"}
                      </div>
                    </div>
                  </Label>
                );
              })}
              <Label
                className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                  strategy.kind === "custom"
                    ? "border-primary/50 bg-primary/[0.03]"
                    : "border-border hover:bg-accent/50"
                }`}
              >
                <RadioGroupItem value="custom" />
                <span className="text-xs font-medium text-foreground">Custom</span>
              </Label>
              <Label
                className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                  strategy.kind === "none"
                    ? "border-primary/50 bg-primary/[0.03]"
                    : "border-border hover:bg-accent/50"
                }`}
              >
                <RadioGroupItem value="none" />
                <span className="text-xs font-medium text-foreground">None</span>
              </Label>
            </RadioGroup>

            {/* Header-based auth input */}
            {strategy.kind !== "none" && strategy.kind !== "oauth2" && (
              <div className="space-y-3">
                <HeadersList
                  headers={customHeaders}
                  onHeadersChange={handleHeadersChange}
                  existingSecrets={secretList}
                  sourceName={identity.name}
                  targetScope={sourceScope}
                  credentialScopeOptions={credentialScopeOptions}
                  bindingScopeOptions={credentialScopeOptions}
                  emptyLabel="No credentials yet. Add the header value this method should use."
                />
              </div>
            )}

            <HttpCredentialsEditor
              credentials={runtimeCredentials}
              onChange={setRuntimeCredentials}
              existingSecrets={secretList}
              sourceName={identity.name}
              targetScope={sourceScope}
              credentialScopeOptions={credentialScopeOptions}
              bindingScopeOptions={credentialScopeOptions}
              sections={{ headers: false, queryParams: true }}
              labels={{ queryParams: "Runtime query parameters" }}
            />

            {/* OAuth2 configuration */}
            {selectedOAuth2Preset && (
              <div className="space-y-3 rounded-lg border border-border/60 bg-muted/10 p-3">
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <FieldLabel className="text-[11px]">
                      Redirect URL{" "}
                      <span className="text-muted-foreground">
                        · add this to your OAuth app's allowed redirects
                      </span>
                    </FieldLabel>
                    <div className="flex items-center gap-1 rounded-md border border-border bg-background/50 px-2.5 py-1.5 font-mono text-[11px]">
                      <span className="truncate flex-1 text-foreground">{oauth2RedirectUrl}</span>
                      <CopyButton value={oauth2RedirectUrl} />
                    </div>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <div className="space-y-1.5">
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-1.5">
                            <FieldLabel className="text-[11px]">Client ID</FieldLabel>
                            <HelpTooltip label="Client ID secret">
                              Select or create the OAuth client ID secret.
                            </HelpTooltip>
                          </div>
                          <div
                            aria-hidden
                            className="invisible text-[10px] leading-tight text-muted-foreground"
                          >
                            Required OAuth client identifier.
                          </div>
                        </div>
                        <CreatableSecretPicker
                          value={oauth2ClientIdSecretId}
                          onSelect={(id: string, secretScopeId?: ScopeId) => {
                            setOauth2ClientIdSecretId(id);
                            setOauth2ClientIdScope(secretScopeId ?? sourceScope);
                            setOauth2AuthState(null);
                          }}
                          secrets={secretList}
                          sourceName={identity.name}
                          secretLabel="Client ID"
                          targetScope={oauth2ClientIdScope ?? sourceScope}
                          credentialScopeOptions={credentialScopeOptions}
                          onCreatedScope={setOauth2ClientIdScope}
                        />
                      </div>
                      <CredentialScopeDropdown
                        value={oauth2ClientIdScope ?? sourceScope}
                        options={credentialScopeOptions}
                        onChange={(targetScope) => {
                          setOauth2ClientIdScope(targetScope);
                          setOauth2ClientIdSecretId(null);
                          setOauth2AuthState(null);
                        }}
                        label="Used by"
                        help="Choose where this OAuth client ID credential lives."
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="space-y-1.5">
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-1.5">
                            <FieldLabel className="text-[11px]">Client Secret</FieldLabel>
                            <HelpTooltip label="Client secret">
                              Select or create the OAuth client secret.
                            </HelpTooltip>
                          </div>
                          <div className="text-[10px] leading-tight text-muted-foreground">
                            Optional for public clients with PKCE.
                          </div>
                        </div>
                        <CreatableSecretPicker
                          value={oauth2ClientSecretSecretId}
                          onSelect={(id: string, secretScopeId?: ScopeId) => {
                            setOauth2ClientSecretSecretId(id);
                            setOauth2ClientSecretScope(secretScopeId ?? sourceScope);
                            setOauth2AuthState(null);
                          }}
                          secrets={secretList}
                          sourceName={identity.name}
                          secretLabel="Client Secret"
                          targetScope={oauth2ClientSecretScope ?? sourceScope}
                          credentialScopeOptions={credentialScopeOptions}
                          onCreatedScope={setOauth2ClientSecretScope}
                        />
                      </div>
                      <CredentialScopeDropdown
                        value={oauth2ClientSecretScope ?? sourceScope}
                        options={credentialScopeOptions}
                        onChange={(targetScope) => {
                          setOauth2ClientSecretScope(targetScope);
                          setOauth2ClientSecretSecretId(null);
                          setOauth2AuthState(null);
                        }}
                        label="Used by"
                        help="Choose where this OAuth client secret credential lives."
                      />
                    </div>
                  </div>
                  <Collapsible
                    open={oauth2ScopesOpen}
                    onOpenChange={setOauth2ScopesOpen}
                    className="space-y-1.5"
                  >
                    <CollapsibleTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-full justify-between !px-0 text-[11px] hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="font-medium text-foreground">Scopes</span>
                          <span className="text-muted-foreground">
                            {selectedOAuth2Scopes.length} selected
                          </span>
                        </span>
                        <span className="flex size-3 shrink-0 items-center justify-center">
                          <ChevronDownIcon
                            className={`size-3 text-muted-foreground transition-transform ${
                              oauth2ScopesOpen ? "" : "-rotate-90"
                            }`}
                          />
                        </span>
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="space-y-1 rounded-md border border-border/50 bg-background/50 p-2">
                        {Object.keys(selectedOAuth2Preset.scopes).length === 0 ? (
                          <div className="text-[11px] italic text-muted-foreground">
                            No scopes declared by the spec.
                          </div>
                        ) : (
                          Object.entries(selectedOAuth2Preset.scopes).map(
                            ([scope, description]) => (
                              <Label
                                key={scope}
                                className="flex items-start gap-2 cursor-pointer py-1"
                              >
                                <Checkbox
                                  checked={oauth2SelectedScopes.has(scope)}
                                  onCheckedChange={() => toggleOAuth2Scope(scope)}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="font-mono text-[11px] text-foreground">
                                    {scope}
                                  </div>
                                  {description && (
                                    <div className="text-[10px] text-muted-foreground">
                                      {description}
                                    </div>
                                  )}
                                </div>
                              </Label>
                            ),
                          )
                        )}
                        {selectedOAuth2AvailableIdentityScopes.length > 0 && (
                          <Label className="mt-2 flex cursor-pointer items-start gap-2 border-t border-border/50 pt-2">
                            <Checkbox
                              checked={includeOAuth2IdentityScopes}
                              onCheckedChange={(checked) => {
                                setIncludeOAuth2IdentityScopes(checked === true);
                                setOauth2AuthState(null);
                              }}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="text-[11px] font-medium text-foreground">
                                Account identity
                              </div>
                              <div className="font-mono text-[10px] text-muted-foreground">
                                {selectedOAuth2AvailableIdentityScopes.join(" · ")}
                              </div>
                              <div className="text-[10px] text-muted-foreground">
                                Lets the connections page show the signed-in account.
                              </div>
                            </div>
                          </Label>
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>

                  {oauth2Auth ? (
                    <div className="flex items-center justify-between rounded-md border border-border/60 bg-background/50 px-3 py-2">
                      <div className="min-w-0 text-[12px]">
                        <OAuthConnectedAccount
                          scopeId={oauthTokenTargetScope}
                          connectionId={oauth2Auth.connectionId}
                          scopeSummary={`${selectedOAuth2Scopes.length} scope${
                            selectedOAuth2Scopes.length === 1 ? "" : "s"
                          } granted`}
                          sourceName={resolvedDisplayName}
                          onSetSourceName={identity.setName}
                        />
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => setOauth2AuthState(null)}>
                        Disconnect
                      </Button>
                    </div>
                  ) : oauth2Busy ? (
                    <div className="flex items-center gap-2">
                      <div className="flex flex-1 items-center gap-2 rounded-md border border-border/60 bg-background/50 px-3 py-2 text-[11px] text-muted-foreground">
                        <Spinner className="size-3.5" />
                        Waiting for OAuth… complete the flow in the popup, or cancel to retry.
                      </div>
                      <Button variant="ghost" size="sm" onClick={handleCancelOAuth2}>
                        Cancel
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void handleConnectOAuth2()}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {existingOAuthConnections.length > 0 && (
                        <div className="space-y-2">
                          <div className="space-y-0.5">
                            <FieldLabel className="text-[11px]">
                              Use {selectedOAuth2ProviderLabel} account
                            </FieldLabel>
                            <div className="text-[10px] leading-tight text-muted-foreground">
                              Continue with an account you already connected. If permissions are
                              missing, Google will confirm access for this source.
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            {existingOAuthConnections.map((connection) => (
                              <ExistingOAuthConnectionOption
                                key={`${connection.scopeId}:${connection.id}`}
                                connection={connection}
                                selected={false}
                                providerLabel={selectedOAuth2ProviderLabel}
                                onSelect={() =>
                                  connection.missingApiScopes.length > 0
                                    ? void handleConnectOAuth2(connection)
                                    : handleReuseOAuthConnection(connection)
                                }
                              />
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="grid gap-2 md:grid-cols-2">
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            <FieldLabel className="text-[11px]">
                              {existingOAuthConnections.length > 0
                                ? "Sign in with another account"
                                : "OAuth sign-in"}
                            </FieldLabel>
                            <HelpTooltip label="OAuth sign-in">
                              Start the provider OAuth flow.
                            </HelpTooltip>
                          </div>
                          <Button
                            variant="secondary"
                            onClick={() => void handleConnectOAuth2()}
                            disabled={!canConnectOAuth2}
                            className={
                              canConnectOAuth2
                                ? "w-full border border-green-500/30 bg-green-600 text-white hover:bg-green-700 focus-visible:ring-green-500/30 dark:bg-green-500 dark:text-white dark:hover:bg-green-600"
                                : "w-full"
                            }
                          >
                            Connect via OAuth
                          </Button>
                        </div>
                        <CredentialScopeDropdown
                          value={oauthTokenTargetScope}
                          options={credentialScopeOptions}
                          onChange={(targetScope) => {
                            setOAuthTokenTargetScope(targetScope);
                            setOauth2AuthState(null);
                          }}
                          label="Token saved to"
                          help="Choose who can use the signed-in OAuth token."
                        />
                      </div>
                    </div>
                  )}

                  {oauth2Error && (
                    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                      <p className="text-[11px] text-destructive">{oauth2Error}</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* Add error */}
          {addError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="text-[12px] text-destructive">{addError}</p>
            </div>
          )}
        </>
      )}

      <FloatActions>
        <Button variant="ghost" onClick={props.onCancel} disabled={adding}>
          Cancel
        </Button>
        {preview && (
          <Button onClick={handleAdd} disabled={!canAdd || adding}>
            {adding && <Spinner className="size-3.5" />}
            {adding
              ? "Adding…"
              : willAddWithoutInitialCredentials
                ? "Add without credentials"
                : "Add source"}
          </Button>
        )}
      </FloatActions>
    </div>
  );
}
