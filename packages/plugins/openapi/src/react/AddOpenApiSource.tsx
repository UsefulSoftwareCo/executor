import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import {
  AuthTemplateSlug,
  IntegrationSlug,
  type OAuthAuthentication,
} from "@executor-js/sdk/shared";
import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import {
  slugifyNamespace,
  useIntegrationIdentity,
} from "@executor-js/react/plugins/integration-identity";
import { Button } from "@executor-js/react/components/button";
import {
  AuthMethodListEditor,
  useAuthMethodList,
  type AuthMethodRow,
  type AuthMethodSeed,
} from "@executor-js/react/components/auth-method-list-editor";
import { CardStack, CardStackContent } from "@executor-js/react/components/card-stack";
import { FieldLabel } from "@executor-js/react/components/field";
import { FloatActions } from "@executor-js/react/components/float-actions";
import { Textarea } from "@executor-js/react/components/textarea";
import { IOSSpinner, Spinner } from "@executor-js/react/components/spinner";
import {
  addIntegrationErrorMessage,
  errorMessageFromExit,
  FormErrorAlert,
  SlugCollisionAlert,
  useSlugAlreadyExists,
} from "@executor-js/react/lib/integration-add";

import { authenticationFromEditorValue, editorValueFromAuthentication } from "./auth-method-config";
import { addOpenApiSpec, previewOpenApiSpec } from "./atoms";
import { OpenApiSourceDetailsFields } from "./OpenApiSourceDetailsFields";
import { GoogleProductPicker } from "./GoogleProductPicker";
import { openApiPresets } from "../sdk/presets";
import {
  GOOGLE_BUNDLE_PRESET_ID,
  googleOpenApiPresets,
  type GoogleOpenApiPreset,
} from "../sdk/google-presets";
import type { SpecPreview, HeaderPreset, OAuth2Preset } from "../sdk/preview";
import {
  type APIKeyAuthentication,
  type Authentication,
  type ServerInfo,
  TOKEN_VARIABLE,
  variable,
} from "../sdk/types";
import { expandServerUrlOptions } from "../sdk/openapi-utils";

const GOOGLE_BUNDLE_BASE_URL = "https://www.googleapis.com/";
const GOOGLE_BUNDLE_FAVICON = "https://fonts.gstatic.com/s/i/productlogos/googleg/v6/192px.svg";

// The bundle picker opens with the featured Google APIs pre-checked.
const googleBundleDefaultPresetIds: ReadonlySet<string> = new Set(
  googleOpenApiPresets
    .filter((preset: GoogleOpenApiPreset) => preset.featured)
    .map((preset: GoogleOpenApiPreset) => preset.id),
);

const googleBundleUrls = (
  selectedPresetIds: ReadonlySet<string>,
  customUrls: readonly string[],
): readonly string[] => {
  const fromPresets = googleOpenApiPresets.flatMap((preset: GoogleOpenApiPreset) =>
    preset.url && selectedPresetIds.has(preset.id) ? [preset.url] : [],
  );
  // Preset URLs first (stable order), then any custom Discovery URLs, de-duped.
  return [...new Set([...fromPresets, ...customUrls])];
};

// ---------------------------------------------------------------------------
// OpenAPI url helpers — specs sometimes ship relative OAuth endpoints; resolve
// them against the chosen base URL so the stored auth template is absolute.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Auth-template builders — turn a preview preset into the integration's stored
// `Authentication` template (v2). The header preset becomes an `apiKey` template
// whose secret header value renders the resolved credential via `variable(token)`;
// the oauth2 preset becomes an `oauth` template carrying the provider endpoints.
//
// Post-redesign the add flow no longer asks the user to pick ONE method: every
// spec-detected method is registered so the integration's detail hub can list
// them and Add-account can choose among them (P6: add without auth, connect
// later).
// ---------------------------------------------------------------------------

const headerPrefix = (preset: HeaderPreset, headerName: string): string | undefined => {
  const label = preset.label.toLowerCase();
  if (headerName.toLowerCase() === "authorization") {
    if (label.includes("bearer")) return "Bearer ";
    if (label.includes("basic")) return "Basic ";
  }
  return undefined;
};

const apiKeyTemplateFromHeaderPreset = (
  preset: HeaderPreset,
  slug: AuthTemplateSlug,
): APIKeyAuthentication => {
  const headers: Record<string, (string | ReturnType<typeof variable>)[]> = {};
  for (const headerName of preset.secretHeaders) {
    const prefix = headerPrefix(preset, headerName);
    headers[headerName] = prefix ? [prefix, variable(TOKEN_VARIABLE)] : [variable(TOKEN_VARIABLE)];
  }
  return { slug, type: "apiKey", headers };
};

const oauthTemplateFromPreset = (
  preset: OAuth2Preset,
  baseUrl: string,
  slug: AuthTemplateSlug,
  scopes: readonly string[],
): OAuthAuthentication => ({
  slug,
  type: "oauth",
  authorizationUrl: resolveOAuthUrl(
    Option.getOrElse(preset.authorizationUrl, () => ""),
    baseUrl,
  ),
  tokenUrl: resolveOAuthUrl(preset.tokenUrl, baseUrl),
  scopes: [...scopes],
});

const expandServerOptions = (server: ServerInfo) =>
  expandServerUrlOptions(server).map((value) => ({ value, label: value }));

const firstBaseUrlForPreview = (preview: SpecPreview): string => {
  const firstServer = preview.servers[0];
  return firstServer ? (expandServerUrlOptions(firstServer)[0] ?? "") : "";
};

// ---------------------------------------------------------------------------
// All spec-detected auth methods → the union of stored `Authentication`
// templates. Header presets become apiKey templates; each oauth2 preset becomes
// an oauth template (with its declared API scopes plus, for auth-code flows,
// the standard identity scopes). Slugs stay deterministic per method so the
// stored template is stable across previews of the same spec. Adding an
// integration whose slug already exists is blocked (see the existing-slug
// guard below); to add more auth, update the existing integration instead.
// ---------------------------------------------------------------------------

const detectedAuthenticationTemplates = (
  headerPresets: readonly HeaderPreset[],
  oauth2Presets: readonly OAuth2Preset[],
  baseUrl: string,
): readonly Authentication[] => {
  const templates: Authentication[] = [];
  headerPresets.forEach((preset, index) => {
    templates.push(
      apiKeyTemplateFromHeaderPreset(preset, AuthTemplateSlug.make(`apikey-${index}`)),
    );
  });
  for (const preset of oauth2Presets) {
    const scopes = resolvedOAuthScopes(Object.keys(preset.scopes), preset.identityScopes);
    templates.push(
      oauthTemplateFromPreset(
        preset,
        baseUrl,
        AuthTemplateSlug.make(`oauth-${preset.securitySchemeName}`),
        scopes,
      ),
    );
  }
  return templates;
};

// ---------------------------------------------------------------------------
// Component — single progressive form. Post-redesign: preview → addSpec
// (register the integration catalog entry with ALL detected auth methods) →
// route to the integration's detail hub, where the user adds accounts. The add
// flow no longer creates a connection.
// ---------------------------------------------------------------------------

export default function AddOpenApiSource(props: {
  onComplete: (slug?: string) => void;
  onCancel: () => void;
  initialUrl?: string;
  initialPreset?: string;
  initialNamespace?: string;
}) {
  const isGoogleBundlePreset = props.initialPreset === GOOGLE_BUNDLE_PRESET_ID;

  // Spec input. For the Google BUNDLE preset the input is a product picker (a set
  // of selected Discovery URLs), not a single spec URL/blob — the merge happens
  // server-side via `{ kind: "googleDiscoveryBundle", urls }`, so the textarea
  // preview path is bypassed entirely.
  const [specUrl, setSpecUrl] = useState(props.initialUrl ?? "");
  const [selectedPresetIds, setSelectedPresetIds] = useState<ReadonlySet<string>>(
    googleBundleDefaultPresetIds,
  );
  const [customDiscoveryUrls, setCustomDiscoveryUrls] = useState<readonly string[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  // After analysis
  const [preview, setPreview] = useState<SpecPreview | null>(null);
  const [baseUrl, setBaseUrl] = useState(isGoogleBundlePreset ? GOOGLE_BUNDLE_BASE_URL : "");
  const identityFallbackName = isGoogleBundlePreset
    ? "Google"
    : preview
      ? Option.getOrElse(preview.title, () => "")
      : "";
  const identity = useIntegrationIdentity({
    fallbackName: identityFallbackName,
    fallbackNamespace: props.initialNamespace ?? (isGoogleBundlePreset ? "google" : undefined),
  });

  const bundleDiscoveryUrls = useMemo(
    () => googleBundleUrls(selectedPresetIds, customDiscoveryUrls),
    [selectedPresetIds, customDiscoveryUrls],
  );

  const toggleBundlePreset = useCallback((presetId: string, checked: boolean) => {
    setSelectedPresetIds((current: ReadonlySet<string>) => {
      const next = new Set(current);
      if (checked) next.add(presetId);
      else next.delete(presetId);
      return next;
    });
  }, []);

  const addCustomDiscoveryUrl = useCallback((url: string) => {
    setCustomDiscoveryUrls((current: readonly string[]) =>
      current.includes(url) ? current : [...current, url],
    );
  }, []);

  const removeCustomDiscoveryUrl = useCallback((url: string) => {
    setCustomDiscoveryUrls((current: readonly string[]) =>
      current.filter((entry: string) => entry !== url),
    );
  }, []);

  // Submit
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const doPreview = useAtomSet(previewOpenApiSpec, { mode: "promiseExit" });
  const doAdd = useAtomSet(addOpenApiSpec, { mode: "promiseExit" });

  // Keep the latest handleAnalyze in a ref so the debounced effect doesn't need
  // it as a dependency (it closes over fresh state).
  const handleAnalyzeRef = useRef<() => void>(() => {});

  useEffect(() => {
    // The bundle preset never analyzes a single spec — its input is the picker.
    if (isGoogleBundlePreset) return;
    const trimmed = specUrl.trim();
    if (!trimmed) return;
    if (preview) return;
    const handle = setTimeout(() => {
      handleAnalyzeRef.current();
    }, 400);
    return () => clearTimeout(handle);
  }, [specUrl, preview, isGoogleBundlePreset]);

  // ---- Derived state ----

  const servers: readonly ServerInfo[] = preview?.servers ?? [];
  const baseUrlOptions = Array.from(
    new Map(servers.flatMap(expandServerOptions).map((option) => [option.value, option])).values(),
  );
  const previewPresetIcon =
    openApiPresets.find(
      (preset) => preset.url && normalizePresetUrl(preset.url) === normalizePresetUrl(specUrl),
    )?.icon ?? null;

  const resolvedBaseUrl = baseUrl.trim();
  const resolvedSourceId =
    slugifyNamespace(identity.namespace) ||
    (preview ? Option.getOrElse(preview.title, () => "openapi") : "openapi");
  const resolvedDisplayName =
    identity.name.trim() ||
    (preview ? Option.getOrElse(preview.title, () => resolvedSourceId) : resolvedSourceId);

  // Register EVERY spec-detected auth method, not just a single selected one.
  // Keyed off `preview` (stable per analysis) so the memo doesn't re-run on the
  // freshly-allocated `?? []` fallback arrays.
  const authenticationTemplate: readonly Authentication[] = useMemo(
    () =>
      detectedAuthenticationTemplates(
        preview?.headerPresets ?? [],
        preview?.oauth2Presets ?? [],
        resolvedBaseUrl,
      ),
    [preview, resolvedBaseUrl],
  );

  // Editable auth methods, seeded from the spec-detected templates. The add flow
  // registers EVERY method (P6) — so this is a LIST, preserving multi-method
  // specs (e.g. apiKey + OAuth). Each seed carries the detected template's
  // original slug, so an unedited detected method submits with its EXACT
  // original slug (preserving behavior); added methods (no seed) get a
  // deterministic fresh slug. Re-seeded whenever a fresh detection arrives
  // (keyed on the detected templates, stable per analysis + base URL).
  const authMethodSeeds: readonly AuthMethodSeed[] = useMemo(() => {
    const labels = [
      ...(preview?.headerPresets ?? []).map((preset) => preset.label),
      ...(preview?.oauth2Presets ?? []).map((preset) => preset.label),
    ];
    return authenticationTemplate.map(
      (template: Authentication, index: number): AuthMethodSeed => ({
        value: editorValueFromAuthentication(template),
        slug: String(template.slug),
        ...(labels[index] !== undefined ? { label: labels[index] } : {}),
      }),
    );
  }, [preview, authenticationTemplate]);
  const authMethodList = useAuthMethodList(authMethodSeeds);

  // The methods to register, mapped back to stored `Authentication[]`. Drops
  // `none` rows (nothing to register). An unedited detected method keeps its
  // original `seedSlug`; an added method gets a deterministic fresh slug.
  const editedAuthenticationTemplate: readonly Authentication[] = useMemo(() => {
    const templates: Authentication[] = [];
    authMethodList.rows.forEach((row: AuthMethodRow, index: number) => {
      const slug =
        row.seedSlug ?? (row.value.kind === "oauth" ? `oauth-${index}` : `apikey-${index}`);
      const template = authenticationFromEditorValue(row.value, slug);
      if (template !== null) templates.push(template);
    });
    return templates;
  }, [authMethodList.rows]);

  // Pre-empt the API's `IntegrationAlreadyExistsError`: adding an integration
  // whose slug already exists clobbers the existing one's connections/policies,
  // so the API blocks it. Surface that here from the tenant-scoped catalog list.
  const slugAlreadyExists = useSlugAlreadyExists(resolvedSourceId);

  // The bundle path is ready once at least one Google API is selected (no
  // network preview gates it); the single/custom-spec path still requires a
  // successful preview. Both require a base URL and a free slug.
  const hasPreviewOrBundle = isGoogleBundlePreset
    ? bundleDiscoveryUrls.length > 0
    : preview !== null;
  const canAdd = hasPreviewOrBundle && resolvedBaseUrl.length > 0 && !slugAlreadyExists;

  // ---- Handlers ----

  const handleAnalyze = async () => {
    setAnalyzing(true);
    setAnalyzeError(null);
    setAddError(null);
    const exit = await doPreview({ payload: { spec: specUrl } });
    if (Exit.isFailure(exit)) {
      setAnalyzeError(errorMessageFromExit(exit, "Failed to parse spec"));
      setAnalyzing(false);
      return;
    }
    const result = exit.value;
    setPreview(result);
    setBaseUrl(firstBaseUrlForPreview(result));
    setAnalyzing(false);
  };

  handleAnalyzeRef.current = handleAnalyze;

  // Persist the integration and return its slug. Registers the catalog entry
  // with every detected auth method. Adding a slug that already exists is
  // rejected by the API (`IntegrationAlreadyExistsError`) — surfaced inline.
  const ensureIntegration = useCallback(async (): Promise<IntegrationSlug | null> => {
    // The Google BUNDLE preset emits the multi-service bundle input; the server
    // merges the selected Discovery documents into one `google` spec and stores
    // the unioned `googleOAuth2` auth template (so no client template is sent).
    // Every other preset/custom input keeps the single-spec url/blob/discovery
    // branch unchanged.
    const specForAdd = isGoogleBundlePreset
      ? ({ kind: "googleDiscoveryBundle" as const, urls: [...bundleDiscoveryUrls] } satisfies {
          readonly kind: "googleDiscoveryBundle";
          readonly urls: readonly string[];
        })
      : specInputForAdd(specUrl);
    const exit = await doAdd({
      payload: {
        spec: specForAdd,
        slug: resolvedSourceId,
        description: resolvedDisplayName,
        baseUrl: resolvedBaseUrl,
        ...(!isGoogleBundlePreset && editedAuthenticationTemplate.length > 0
          ? {
              authenticationTemplate: editedAuthenticationTemplate.map((entry) => ({
                ...entry,
                slug: String(entry.slug),
              })),
            }
          : {}),
      },
      reactivityKeys: integrationWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setAddError(addIntegrationErrorMessage(exit, resolvedSourceId, "Failed to add integration"));
      return null;
    }
    return exit.value.slug;
  }, [
    isGoogleBundlePreset,
    bundleDiscoveryUrls,
    specUrl,
    doAdd,
    resolvedSourceId,
    resolvedDisplayName,
    resolvedBaseUrl,
    editedAuthenticationTemplate,
  ]);

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);

    const integration = await ensureIntegration();
    if (!integration) {
      setAdding(false);
      return;
    }

    props.onComplete(String(integration));
  };

  // ---- Render ----

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">
          {isGoogleBundlePreset ? "Add Google" : "Add OpenAPI Integration"}
        </h1>
        {isGoogleBundlePreset ? (
          <p className="mt-1 text-[13px] text-muted-foreground">
            Bundle Google APIs into one integration from their Discovery documents and register
            their methods as tools under a single shared OAuth consent.
          </p>
        ) : null}
      </div>

      {isGoogleBundlePreset ? (
        <GoogleProductPicker
          selectedPresetIds={selectedPresetIds}
          onToggle={toggleBundlePreset}
          customUrls={customDiscoveryUrls}
          onAddCustomUrl={addCustomDiscoveryUrl}
          onRemoveCustomUrl={removeCustomDiscoveryUrl}
        />
      ) : !preview ? (
        <CardStack>
          <CardStackContent className="border-t-0">
            <div className="space-y-2 p-3">
              <FieldLabel>OpenAPI Spec</FieldLabel>
              <div className="relative">
                <Textarea
                  value={specUrl}
                  onChange={(e) => setSpecUrl((e.target as HTMLTextAreaElement).value)}
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
              <p className="text-[11px] text-muted-foreground">
                Paste a URL or raw JSON/YAML content.
              </p>
            </div>
          </CardStackContent>
        </CardStack>
      ) : null}

      {isGoogleBundlePreset ? (
        <OpenApiSourceDetailsFields
          title="Google"
          description={`${bundleDiscoveryUrls.length} Google API${
            bundleDiscoveryUrls.length !== 1 ? "s" : ""
          } · one shared OAuth consent`}
          identity={identity}
          baseUrl={resolvedBaseUrl}
          onBaseUrlChange={setBaseUrl}
          faviconIcon={GOOGLE_BUNDLE_FAVICON}
          faviconUrl={resolvedBaseUrl}
          baseUrlMissingMessage="A base URL is required to make requests."
        />
      ) : preview ? (
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
          }}
          faviconIcon={previewPresetIcon}
          faviconUrl={resolvedBaseUrl}
          baseUrlMissingMessage="A base URL is required to make requests."
        />
      ) : null}

      {analyzeError && <FormErrorAlert message={analyzeError} />}

      {preview && !isGoogleBundlePreset && (
        <AuthMethodListEditor
          list={authMethodList}
          emptyHint="No authentication detected. Add a method, or add the integration without auth and connect an account from the integration page later."
          footerHint="Every method here is registered with the integration. Connect an account from the integration page after adding."
        />
      )}

      {hasPreviewOrBundle && slugAlreadyExists && !adding && (
        <SlugCollisionAlert slug={resolvedSourceId} />
      )}

      {addError && <FormErrorAlert message={addError} />}

      <FloatActions>
        <Button variant="ghost" onClick={() => props.onCancel()} disabled={adding}>
          Cancel
        </Button>
        {(hasPreviewOrBundle || isGoogleBundlePreset) && (
          <Button onClick={() => void handleAdd()} disabled={!canAdd || adding}>
            {adding && <Spinner className="size-3.5" />}
            {adding ? "Adding…" : isGoogleBundlePreset ? "Connect Google" : "Add integration"}
          </Button>
        )}
      </FloatActions>
    </div>
  );
}
