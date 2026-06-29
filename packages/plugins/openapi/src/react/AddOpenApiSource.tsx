import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { IntegrationSlug } from "@executor-js/sdk/shared";
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
import { IOSSpinner } from "@executor-js/react/components/spinner";
import {
  addIntegrationErrorMessage,
  errorMessageFromExit,
  FormErrorAlert,
  SlugCollisionAlert,
  useSlugAlreadyExists,
} from "@executor-js/react/lib/integration-add";

import {
  authenticationFromEditorValue,
  editorValueFromAuthentication,
  openApiWireAuthInput,
} from "./auth-method-config";
import { addOpenApiSpec, previewOpenApiSpec } from "./atoms";
import { OpenApiSourceDetailsFields } from "./OpenApiSourceDetailsFields";
import { openApiPresets } from "../sdk/presets";
import type { SpecPreviewSummary } from "../sdk/preview";
import { type Authentication } from "../sdk/types";
import { resolveServerUrl } from "../sdk/openapi-utils";
import { detectedAuthenticationTemplates } from "../sdk/derive-auth";

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
    ? { kind: "url" as const, url: value }
    : { kind: "blob" as const, value };
};

export const baseUrlFromSpecInput = (input: string): string => {
  const value = input.trim();
  if (!URL.canParse(value)) return "";
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
  return parsed.origin;
};

// ---------------------------------------------------------------------------
// Component: single progressive form. Post-redesign: preview -> addSpec
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
  const [specUrl, setSpecUrl] = useState(props.initialUrl ?? "");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  // After analysis
  const [preview, setPreview] = useState<SpecPreviewSummary | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  // Agent-visible description: prefilled from the spec's `info.description`
  // until the user types (null = untouched, keep deriving from the preview).
  const [descriptionDraft, setDescriptionDraft] = useState<string | null>(null);
  const identityFallbackName = preview ? Option.getOrElse(preview.title, () => "") : "";
  const identity = useIntegrationIdentity({
    fallbackName: identityFallbackName,
    fallbackNamespace: props.initialNamespace,
  });

  // Submit
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const doPreview = useAtomSet(previewOpenApiSpec, { mode: "promiseExit" });
  const doAdd = useAtomSet(addOpenApiSpec, { mode: "promiseExit" });

  // Keep the latest handleAnalyze in a ref so the debounced effect doesn't need
  // it as a dependency (it closes over fresh state).
  const handleAnalyzeRef = useRef<() => void>(() => {});

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

  const previewHasNoServers = preview !== null && preview.servers.length === 0;
  // Offer the spec's servers (resolved with defaults) as base-URL choices when
  // there's more than one; a single/no server uses a plain input.
  const baseUrlOptions =
    preview && preview.servers.length > 1
      ? preview.servers.map((server) => {
          const url = resolveServerUrl(server.url, Option.getOrUndefined(server.variables), {});
          return { value: url, label: url };
        })
      : undefined;
  const firstServer = preview?.servers[0];
  const firstServerUrl = firstServer
    ? resolveServerUrl(firstServer.url, Option.getOrUndefined(firstServer.variables), {})
    : "";
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
  const resolvedDescription =
    descriptionDraft ?? (preview ? Option.getOrElse(preview.description, () => "") : "");

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
  // registers EVERY method (P6), so this is a LIST, preserving multi-method
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

  // The base URL is optional when the spec declares servers (resolved per call);
  // required only when it doesn't.
  const canAdd =
    preview !== null && !slugAlreadyExists && (!previewHasNoServers || resolvedBaseUrl.length > 0);

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
    setBaseUrl(result.servers.length === 0 ? baseUrlFromSpecInput(specUrl) : "");
    setAnalyzing(false);
  };

  handleAnalyzeRef.current = handleAnalyze;

  // Persist the integration and return its slug. Registers the catalog entry
  // with every detected auth method. Adding a slug that already exists is
  // rejected by the API (`IntegrationAlreadyExistsError`), surfaced inline.
  const ensureIntegration = useCallback(async (): Promise<IntegrationSlug | null> => {
    const exit = await doAdd({
      payload: {
        spec: specInputForAdd(specUrl),
        slug: resolvedSourceId,
        name: resolvedDisplayName,
        ...(resolvedDescription.trim().length > 0
          ? { description: resolvedDescription.trim() }
          : {}),
        baseUrl: resolvedBaseUrl,
        // Always send the edited method list (even empty) when the user has
        // inspected a preview: an explicit [] means "no auth methods", while
        // OMITTING the field tells the server to derive defaults from the
        // spec, which would silently resurrect methods the user deleted.
        // Serialize to the wire input dialect (apikey -> request-shaped).
        authenticationTemplate: editedAuthenticationTemplate.map(openApiWireAuthInput),
      },
      reactivityKeys: integrationWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setAddError(addIntegrationErrorMessage(exit, resolvedSourceId, "Failed to add integration"));
      return null;
    }
    return exit.value.slug;
  }, [
    specUrl,
    doAdd,
    resolvedSourceId,
    resolvedDisplayName,
    resolvedDescription,
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
        <h1 className="text-xl font-semibold text-foreground">Add OpenAPI Integration</h1>
      </div>

      {!preview ? (
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

      {preview ? (
        <OpenApiSourceDetailsFields
          title={Option.getOrElse(preview.title, () => "API")}
          subtitle={`${Option.getOrElse(preview.version, () => "")}${
            Option.isSome(preview.version) ? " · " : ""
          }${preview.operationCount} operation${preview.operationCount !== 1 ? "s" : ""}${
            preview.tags.length > 0
              ? ` · ${preview.tags.length} tag${preview.tags.length !== 1 ? "s" : ""}`
              : ""
          }`}
          identity={identity}
          description={resolvedDescription}
          onDescriptionChange={setDescriptionDraft}
          baseUrl={resolvedBaseUrl}
          onBaseUrlChange={setBaseUrl}
          baseUrlOptions={baseUrlOptions}
          baseUrlLabel={previewHasNoServers ? "Base URL" : "Base URL override (optional)"}
          baseUrlPlaceholder={firstServerUrl || "https://api.example.com"}
          baseUrlHint={
            previewHasNoServers
              ? undefined
              : "Overrides the spec's servers; leave empty to choose the server (and variables) per tool call."
          }
          baseUrlMissingMessage={
            previewHasNoServers ? "This spec declares no servers, enter a base URL." : undefined
          }
          specUrl={specUrl}
          onSpecUrlChange={(value) => {
            setSpecUrl(value);
            setPreview(null);
            setBaseUrl("");
          }}
          faviconIcon={previewPresetIcon}
          faviconUrl={resolvedBaseUrl || firstServerUrl}
        />
      ) : null}

      {analyzeError && <FormErrorAlert message={analyzeError} />}

      {preview && (
        <AuthMethodListEditor
          list={authMethodList}
          emptyHint="No authentication detected. Add a method, or add the integration without auth and connect an account from the integration page later."
          footerHint="Every method here is registered with the integration. Connect an account from the integration page after adding."
        />
      )}

      {preview && slugAlreadyExists && !adding && <SlugCollisionAlert slug={resolvedSourceId} />}

      {addError && <FormErrorAlert message={addError} />}

      <FloatActions>
        <Button variant="ghost" onClick={() => props.onCancel()} disabled={adding}>
          Cancel
        </Button>
        {preview && (
          <Button onClick={() => void handleAdd()} disabled={!canAdd} loading={adding}>
            Add integration
          </Button>
        )}
      </FloatActions>
    </div>
  );
}
