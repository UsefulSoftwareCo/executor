import { useCallback, useMemo, useState, type ChangeEvent } from "react";
import { useAtomSet } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import { CheckIcon, CircleIcon, TriangleAlert } from "lucide-react";

import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import {
  slugifyNamespace,
  useIntegrationIdentity,
} from "@executor-js/react/plugins/integration-identity";
import { Button } from "@executor-js/react/components/button";
import { FieldLabel } from "@executor-js/react/components/field";
import { FloatActions } from "@executor-js/react/components/float-actions";
import { Input } from "@executor-js/react/components/input";
import {
  addIntegrationErrorMessage,
  errorMessageFromExit,
  FormErrorAlert,
  SlugCollisionAlert,
  useSlugAlreadyExists,
} from "@executor-js/react/lib/integration-add";
import { OpenApiSourceDetailsFields } from "@executor-js/plugin-openapi/react";

import { addGoogleBundle, addGoogleServices } from "./atoms";
import { GoogleProductPicker } from "./GoogleProductPicker";
import {
  GOOGLE_PHOTOS_PRESET_ID,
  googleOpenApiPresets,
  googlePhotosPresetIds,
  googleServiceSlug,
  type GoogleOpenApiPreset,
} from "../sdk/presets";
import type {
  GoogleAddServicesInput,
  GoogleAddServicesResult,
  GoogleBundleConfig,
} from "../sdk/plugin";

const GOOGLE_BUNDLE_FAVICON = "https://fonts.gstatic.com/s/i/productlogos/googleg/v6/192px.svg";

const googleBundleDefaultPresetIds: ReadonlySet<string> = new Set(
  googleOpenApiPresets
    .filter((preset: GoogleOpenApiPreset) => preset.featured)
    .map((preset: GoogleOpenApiPreset) => preset.id),
);

const googleOpenApiPresetById: ReadonlyMap<string, GoogleOpenApiPreset> = new Map(
  googleOpenApiPresets.map((preset: GoogleOpenApiPreset) => [preset.id, preset]),
);

export type GoogleServiceIdentityOverride = {
  readonly slug: string;
  readonly name: string;
};

export type AddGoogleServicesMutation = (input: {
  readonly payload: GoogleAddServicesInput;
  readonly reactivityKeys: typeof integrationWriteKeys;
}) => Promise<Exit.Exit<GoogleAddServicesResult, unknown>>;

export const googleAddServicesPayload = (input: {
  readonly presetIds: readonly string[];
  readonly identityOverride?: GoogleServiceIdentityOverride;
  readonly baseUrl?: string;
}): GoogleAddServicesInput => {
  const identityOverride = input.presetIds.length === 1 ? input.identityOverride : undefined;
  const services = input.presetIds.map((presetId: string) => ({
    presetId,
    ...(identityOverride?.slug.trim() ? { slug: identityOverride.slug.trim() } : {}),
    ...(identityOverride?.name.trim() ? { name: identityOverride.name.trim() } : {}),
  }));
  const baseUrl = input.baseUrl?.trim() ?? "";
  return baseUrl.length > 0 ? { services, baseUrl } : { services };
};

export const submitGoogleServicesSelection = (
  doAddServices: AddGoogleServicesMutation,
  input: {
    readonly presetIds: readonly string[];
    readonly identityOverride?: GoogleServiceIdentityOverride;
    readonly baseUrl?: string;
  },
): Promise<Exit.Exit<GoogleAddServicesResult, unknown>> =>
  doAddServices({
    payload: googleAddServicesPayload(input),
    reactivityKeys: integrationWriteKeys,
  });

export type GoogleServiceResultRow =
  | {
      readonly status: "added";
      readonly presetId: string;
      readonly slug: string;
      readonly toolCount: number;
    }
  | {
      readonly status: "skipped";
      readonly presetId: string;
      readonly slug: string;
      readonly reason: "already_exists";
    }
  | {
      readonly status: "failed";
      readonly presetId: string;
      readonly slug: string;
      readonly error: string;
    };

export const googleAddServicesResultRows = (
  result: GoogleAddServicesResult,
): readonly GoogleServiceResultRow[] => [
  ...result.added.map((entry) => ({
    status: "added" as const,
    presetId: entry.presetId,
    slug: String(entry.slug),
    toolCount: entry.toolCount,
  })),
  ...result.skipped.map((entry) => ({
    status: "skipped" as const,
    presetId: entry.presetId,
    slug: String(entry.slug),
    reason: entry.reason,
  })),
  ...result.failed.map((entry) => ({
    status: "failed" as const,
    presetId: entry.presetId,
    slug: String(entry.slug),
    error: entry.error,
  })),
];

export const mergeGoogleAddServicesResult = (
  previous: GoogleAddServicesResult,
  next: GoogleAddServicesResult,
): GoogleAddServicesResult => {
  const nextPresetIds = new Set(googleAddServicesResultRows(next).map((row) => row.presetId));
  return {
    added: [...previous.added.filter((entry) => !nextPresetIds.has(entry.presetId)), ...next.added],
    skipped: [
      ...previous.skipped.filter((entry) => !nextPresetIds.has(entry.presetId)),
      ...next.skipped,
    ],
    failed: [
      ...previous.failed.filter((entry) => !nextPresetIds.has(entry.presetId)),
      ...next.failed,
    ],
  };
};

const googlePresetName = (presetId: string): string =>
  googleOpenApiPresetById.get(presetId)?.name ?? presetId;

export function GoogleServiceResultPanel(props: {
  readonly result: GoogleAddServicesResult;
  readonly retryingPresetId: string | null;
  readonly onRetry: (presetId: string) => void | Promise<void>;
}) {
  const rows = googleAddServicesResultRows(props.result);
  if (rows.length === 0) return null;

  return (
    <section
      data-testid="google-add-results"
      className="space-y-3 rounded-lg border border-border bg-muted/10 px-3 py-3"
    >
      <div>
        <h2 className="text-sm font-medium text-foreground">Google products</h2>
        <p className="text-[11px] text-muted-foreground">
          Each selected product is added as its own integration.
        </p>
      </div>
      <ul className="space-y-2">
        {rows.map((row: GoogleServiceResultRow) => {
          const presetName = googlePresetName(row.presetId);
          return (
            <li
              key={`${row.status}:${row.presetId}`}
              data-testid={`add-result-row-${row.presetId}`}
              data-state={row.status}
              className="flex items-start gap-2 rounded-md border border-border bg-background px-2.5 py-2"
            >
              <span
                className={
                  row.status === "added"
                    ? "mt-0.5 text-emerald-600"
                    : row.status === "skipped"
                      ? "mt-0.5 text-muted-foreground"
                      : "mt-0.5 text-destructive"
                }
              >
                {row.status === "added" ? (
                  <CheckIcon className="size-3.5" />
                ) : row.status === "skipped" ? (
                  <CircleIcon className="size-3.5" />
                ) : (
                  <TriangleAlert className="size-3.5" />
                )}
              </span>
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{presetName}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {row.status === "added"
                      ? "Added"
                      : row.status === "skipped"
                        ? "Already exists"
                        : "Failed"}
                  </span>
                </div>
                {row.status === "added" ? (
                  <p className="text-[11px] text-muted-foreground">
                    {row.toolCount} tool{row.toolCount === 1 ? "" : "s"} added.
                  </p>
                ) : row.status === "skipped" ? (
                  <p className="text-[11px] text-muted-foreground">
                    This integration already exists.
                  </p>
                ) : (
                  <p className="text-[11px] text-destructive">{row.error}</p>
                )}
              </div>
              {row.status === "failed" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  data-testid={`add-result-retry-${row.presetId}`}
                  loading={props.retryingPresetId === row.presetId}
                  onClick={() => void props.onRetry(row.presetId)}
                >
                  Retry
                </Button>
              ) : (
                <Button variant="ghost" size="xs" asChild>
                  <Link to="/{-$orgSlug}/integrations/$namespace" params={{ namespace: row.slug }}>
                    Open
                  </Link>
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const BaseUrlSettings = (props: {
  readonly baseUrl: string;
  readonly onBaseUrlChange: (value: string) => void;
}) => (
  <section className="space-y-2 rounded-lg border border-border bg-muted/10 px-3 py-3">
    <div className="space-y-1">
      <FieldLabel>Google product settings</FieldLabel>
      <p className="text-[11px] text-muted-foreground">
        Selected products keep their preset names and namespaces.
      </p>
    </div>
    <Input
      value={props.baseUrl}
      onChange={(event: ChangeEvent<HTMLInputElement>) => props.onBaseUrlChange(event.target.value)}
      placeholder="Base URL override (optional)"
      className="font-mono text-sm"
    />
  </section>
);

const CustomGoogleBundleResult = (props: { readonly slug: string }) => (
  <section className="rounded-lg border border-border bg-muted/10 px-3 py-3">
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-sm font-medium text-foreground">Custom Discovery URLs</h2>
        <p className="text-[11px] text-muted-foreground">
          Custom URLs were added through the legacy Google bundle path.
        </p>
      </div>
      <Button variant="ghost" size="xs" asChild>
        <Link to="/{-$orgSlug}/integrations/$namespace" params={{ namespace: props.slug }}>
          Open
        </Link>
      </Button>
    </div>
  </section>
);

const googleBundlePayload = (config: GoogleBundleConfig): GoogleBundleConfig => {
  const baseUrl = config.baseUrl?.trim() ?? "";
  const description = config.description?.trim() ?? "";
  return {
    urls: config.urls,
    ...(config.slug !== undefined ? { slug: config.slug } : {}),
    ...(config.name !== undefined ? { name: config.name } : {}),
    ...(description.length > 0 ? { description } : {}),
    ...(baseUrl.length > 0 ? { baseUrl } : {}),
  };
};

export default function AddGoogleSource(props: {
  onComplete: (slug?: string) => void;
  onCancel: () => void;
  initialPreset?: string;
  initialNamespace?: string;
}) {
  const isGooglePhotosPreset = props.initialPreset === GOOGLE_PHOTOS_PRESET_ID;
  const [selectedPresetIds, setSelectedPresetIds] = useState<ReadonlySet<string>>(
    isGooglePhotosPreset ? new Set(googlePhotosPresetIds) : googleBundleDefaultPresetIds,
  );
  const [customDiscoveryUrls, setCustomDiscoveryUrls] = useState<readonly string[]>([]);
  const [baseUrl, setBaseUrl] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [retryingPresetId, setRetryingPresetId] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [servicesResult, setServicesResult] = useState<GoogleAddServicesResult | null>(null);
  const [customBundleSlug, setCustomBundleSlug] = useState<string | null>(null);

  const selectedIds = useMemo(() => [...selectedPresetIds], [selectedPresetIds]);
  const singleSelectedPreset =
    selectedIds.length === 1 ? googleOpenApiPresetById.get(selectedIds[0]!) : undefined;
  const usesCustomBundleFallback = customDiscoveryUrls.length > 0;

  const identity = useIntegrationIdentity({
    fallbackName: usesCustomBundleFallback
      ? "Custom Google APIs"
      : (singleSelectedPreset?.name ?? (isGooglePhotosPreset ? "Google Photos" : "Google")),
    fallbackNamespace:
      props.initialNamespace ??
      (usesCustomBundleFallback
        ? "google_custom"
        : singleSelectedPreset
          ? googleServiceSlug(singleSelectedPreset.id)
          : isGooglePhotosPreset
            ? "google_photos"
            : "google"),
  });

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

  const doAddServices = useAtomSet(addGoogleServices, { mode: "promiseExit" });
  const doAddBundle = useAtomSet(addGoogleBundle, { mode: "promiseExit" });

  const resolvedSourceId = slugifyNamespace(identity.namespace) || "google_custom";
  const resolvedDisplayName =
    identity.name.trim() ||
    (usesCustomBundleFallback
      ? "Custom Google APIs"
      : (singleSelectedPreset?.name ?? (isGooglePhotosPreset ? "Google Photos" : "Google")));
  const resolvedDescription =
    descriptionDraft ??
    (usesCustomBundleFallback
      ? "Custom Google APIs."
      : isGooglePhotosPreset
        ? "Google Photos albums, uploads, app-created media, and selected picker media."
        : "Google APIs");
  const customSlugAlreadyExists = useSlugAlreadyExists(
    usesCustomBundleFallback ? resolvedSourceId : "",
  );
  const identityOverride =
    selectedIds.length === 1 && !usesCustomBundleFallback
      ? { slug: resolvedSourceId, name: resolvedDisplayName }
      : undefined;
  const canAdd =
    (selectedIds.length > 0 || customDiscoveryUrls.length > 0) &&
    !customSlugAlreadyExists &&
    !adding;

  const addCustomDiscoveryBundle = async (): Promise<boolean> => {
    if (customDiscoveryUrls.length === 0) return true;
    const exit = await doAddBundle({
      payload: googleBundlePayload({
        urls: [...customDiscoveryUrls],
        slug: resolvedSourceId,
        name: resolvedDisplayName,
        description: resolvedDescription,
        baseUrl,
      }),
      reactivityKeys: integrationWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setAddError(addIntegrationErrorMessage(exit, resolvedSourceId, "Failed to add Google"));
      return false;
    }
    setCustomBundleSlug(String(exit.value.slug));
    return true;
  };

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);
    setServicesResult(null);
    setCustomBundleSlug(null);
    if (selectedIds.length > 0) {
      const exit = await submitGoogleServicesSelection(doAddServices, {
        presetIds: selectedIds,
        ...(identityOverride ? { identityOverride } : {}),
        baseUrl,
      });
      if (Exit.isFailure(exit)) {
        setAddError(errorMessageFromExit(exit, "Failed to add Google services"));
        setAdding(false);
        return;
      }
      setServicesResult(exit.value);
    }
    await addCustomDiscoveryBundle();
    setAdding(false);
  };

  const handleRetry = async (presetId: string) => {
    setRetryingPresetId(presetId);
    setAddError(null);
    const retryIdentityOverride =
      identityOverride && selectedIds.length === 1 && selectedIds[0] === presetId
        ? identityOverride
        : undefined;
    const exit = await submitGoogleServicesSelection(doAddServices, {
      presetIds: [presetId],
      ...(retryIdentityOverride ? { identityOverride: retryIdentityOverride } : {}),
      baseUrl,
    });
    if (Exit.isFailure(exit)) {
      setAddError(errorMessageFromExit(exit, "Failed to add Google service"));
      setRetryingPresetId(null);
      return;
    }
    setServicesResult((current) =>
      current ? mergeGoogleAddServicesResult(current, exit.value) : exit.value,
    );
    setRetryingPresetId(null);
  };

  const showIdentityDetails = selectedIds.length === 1 || usesCustomBundleFallback;
  const detailTitle = usesCustomBundleFallback
    ? "Custom Google Discovery URLs"
    : (singleSelectedPreset?.name ?? "Google");
  const detailSubtitle = usesCustomBundleFallback
    ? selectedIds.length > 0
      ? `${customDiscoveryUrls.length} custom URL${
          customDiscoveryUrls.length === 1 ? "" : "s"
        } added through the legacy bundle path. Selected products keep preset names.`
      : `${customDiscoveryUrls.length} custom URL${
          customDiscoveryUrls.length === 1 ? "" : "s"
        } added through the legacy bundle path.`
    : "This product is added as its own integration.";

  const dismiss = () => {
    if (servicesResult || customBundleSlug) {
      props.onComplete();
      return;
    }
    props.onCancel();
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Add Google integration</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Each selected product is added as its own integration.
        </p>
      </div>

      <GoogleProductPicker
        selectedPresetIds={selectedPresetIds}
        onToggle={toggleBundlePreset}
        customUrls={customDiscoveryUrls}
        onAddCustomUrl={addCustomDiscoveryUrl}
        onRemoveCustomUrl={removeCustomDiscoveryUrl}
      />

      {showIdentityDetails ? (
        <OpenApiSourceDetailsFields
          title={detailTitle}
          subtitle={detailSubtitle}
          identity={identity}
          {...(usesCustomBundleFallback
            ? { description: resolvedDescription, onDescriptionChange: setDescriptionDraft }
            : {})}
          baseUrl={baseUrl}
          onBaseUrlChange={setBaseUrl}
          baseUrlLabel="Base URL override (optional)"
          faviconIcon={GOOGLE_BUNDLE_FAVICON}
          faviconUrl={baseUrl}
        />
      ) : (
        <BaseUrlSettings baseUrl={baseUrl} onBaseUrlChange={setBaseUrl} />
      )}

      {customSlugAlreadyExists && !adding && <SlugCollisionAlert slug={resolvedSourceId} />}

      {addError && <FormErrorAlert message={addError} />}

      {servicesResult && (
        <GoogleServiceResultPanel
          result={servicesResult}
          retryingPresetId={retryingPresetId}
          onRetry={handleRetry}
        />
      )}

      {customBundleSlug && <CustomGoogleBundleResult slug={customBundleSlug} />}

      <FloatActions>
        <Button variant="ghost" onClick={dismiss} disabled={adding || retryingPresetId !== null}>
          {servicesResult || customBundleSlug ? "Done" : "Cancel"}
        </Button>
        <Button
          data-testid="google-add-submit"
          onClick={() => void handleAdd()}
          disabled={!canAdd}
          loading={adding}
        >
          Connect Google
        </Button>
      </FloatActions>
    </div>
  );
}
