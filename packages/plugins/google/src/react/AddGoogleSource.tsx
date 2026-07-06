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
  errorMessageFromExit,
  FormErrorAlert,
  SlugCollisionAlert,
  useSlugAlreadyExists,
} from "@executor-js/react/lib/integration-add";
import { OpenApiSourceDetailsFields } from "@executor-js/plugin-openapi/react";

import { addGoogleServices } from "./atoms";
import { GoogleProductPicker } from "./GoogleProductPicker";
import {
  GOOGLE_PHOTOS_PRESET_ID,
  googleOpenApiPresets,
  googlePhotosPresetIds,
  googleServiceSlug,
  type GoogleOpenApiPreset,
} from "../sdk/presets";
import type { GoogleAddServicesInput, GoogleAddServicesResult } from "../sdk/plugin";
import { GOOGLE_CUSTOM_SERVICE_ID } from "../sdk/plugin";

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

export type GoogleCustomServiceInput = {
  readonly urls: readonly string[];
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
};

export type AddGoogleServicesMutation = (input: {
  readonly payload: GoogleAddServicesInput;
  readonly reactivityKeys: typeof integrationWriteKeys;
}) => Promise<Exit.Exit<GoogleAddServicesResult, unknown>>;

export const googleAddServicesPayload = (input: {
  readonly presetIds: readonly string[];
  readonly identityOverride?: GoogleServiceIdentityOverride;
  readonly custom?: GoogleCustomServiceInput;
  readonly baseUrl?: string;
}): GoogleAddServicesInput => {
  const identityOverride =
    input.presetIds.length === 1 && !input.custom ? input.identityOverride : undefined;
  const presetServices = input.presetIds.map((presetId: string) => ({
    presetId,
    ...(identityOverride?.slug.trim() ? { slug: identityOverride.slug.trim() } : {}),
    ...(identityOverride?.name.trim() ? { name: identityOverride.name.trim() } : {}),
  }));
  const custom =
    input.custom && input.custom.urls.length > 0
      ? [
          {
            custom: {
              urls: [...input.custom.urls],
              slug: input.custom.slug,
              name: input.custom.name,
              ...(input.custom.description?.trim()
                ? { description: input.custom.description.trim() }
                : {}),
            },
          },
        ]
      : [];
  const services = [...presetServices, ...custom];
  const baseUrl = input.baseUrl?.trim() ?? "";
  return baseUrl.length > 0 ? { services, baseUrl } : { services };
};

export const submitGoogleServicesSelection = (
  doAddServices: AddGoogleServicesMutation,
  input: {
    readonly presetIds: readonly string[];
    readonly identityOverride?: GoogleServiceIdentityOverride;
    readonly custom?: GoogleCustomServiceInput;
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
  presetId === GOOGLE_CUSTOM_SERVICE_ID
    ? "Custom Discovery URLs"
    : (googleOpenApiPresetById.get(presetId)?.name ?? presetId);

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

  const selectedIds = useMemo(() => [...selectedPresetIds], [selectedPresetIds]);
  const singleSelectedPreset =
    selectedIds.length === 1 ? googleOpenApiPresetById.get(selectedIds[0]!) : undefined;
  const hasCustomDiscoveryUrls = customDiscoveryUrls.length > 0;

  const identity = useIntegrationIdentity({
    fallbackName: hasCustomDiscoveryUrls
      ? "Custom Google APIs"
      : (singleSelectedPreset?.name ?? (isGooglePhotosPreset ? "Google Photos" : "Google")),
    fallbackNamespace:
      props.initialNamespace ??
      (hasCustomDiscoveryUrls
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

  const resolvedSourceId = slugifyNamespace(identity.namespace) || "google_custom";
  const resolvedDisplayName =
    identity.name.trim() ||
    (hasCustomDiscoveryUrls
      ? "Custom Google APIs"
      : (singleSelectedPreset?.name ?? (isGooglePhotosPreset ? "Google Photos" : "Google")));
  const resolvedDescription =
    descriptionDraft ??
    (hasCustomDiscoveryUrls
      ? "Custom Google APIs."
      : isGooglePhotosPreset
        ? "Google Photos albums, uploads, app-created media, and selected picker media."
        : "Google APIs");
  const customSlugAlreadyExists = useSlugAlreadyExists(
    hasCustomDiscoveryUrls ? resolvedSourceId : "",
  );
  const identityOverride =
    selectedIds.length === 1 && !hasCustomDiscoveryUrls
      ? { slug: resolvedSourceId, name: resolvedDisplayName }
      : undefined;
  const customService =
    customDiscoveryUrls.length > 0
      ? {
          urls: [...customDiscoveryUrls],
          slug: resolvedSourceId,
          name: resolvedDisplayName,
          description: resolvedDescription,
        }
      : undefined;
  const canAdd =
    (selectedIds.length > 0 || customDiscoveryUrls.length > 0) &&
    !customSlugAlreadyExists &&
    !adding;

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);
    setServicesResult(null);
    const exit = await submitGoogleServicesSelection(doAddServices, {
      presetIds: selectedIds,
      ...(identityOverride ? { identityOverride } : {}),
      ...(customService ? { custom: customService } : {}),
      baseUrl,
    });
    if (Exit.isFailure(exit)) {
      setAddError(errorMessageFromExit(exit, "Failed to add Google services"));
      setAdding(false);
      return;
    }
    setServicesResult(exit.value);
    setAdding(false);
  };

  const handleRetry = async (presetId: string) => {
    setRetryingPresetId(presetId);
    setAddError(null);
    const retryingCustom = presetId === GOOGLE_CUSTOM_SERVICE_ID;
    const retryIdentityOverride =
      !retryingCustom && identityOverride && selectedIds.length === 1 && selectedIds[0] === presetId
        ? identityOverride
        : undefined;
    const exit = await submitGoogleServicesSelection(doAddServices, {
      presetIds: retryingCustom ? [] : [presetId],
      ...(retryIdentityOverride ? { identityOverride: retryIdentityOverride } : {}),
      ...(retryingCustom && customService ? { custom: customService } : {}),
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

  const showIdentityDetails = selectedIds.length === 1 || hasCustomDiscoveryUrls;
  const detailTitle = hasCustomDiscoveryUrls
    ? "Custom Google Discovery URLs"
    : (singleSelectedPreset?.name ?? "Google");
  const detailSubtitle = hasCustomDiscoveryUrls
    ? selectedIds.length > 0
      ? `${customDiscoveryUrls.length} custom URL${
          customDiscoveryUrls.length === 1 ? "" : "s"
        } added as its own integration. Selected products keep preset names.`
      : `${customDiscoveryUrls.length} custom URL${
          customDiscoveryUrls.length === 1 ? "" : "s"
        } added as its own integration.`
    : "This product is added as its own integration.";

  const dismiss = () => {
    if (servicesResult) {
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
          {...(hasCustomDiscoveryUrls
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

      <FloatActions>
        <Button variant="ghost" onClick={dismiss} disabled={adding || retryingPresetId !== null}>
          {servicesResult ? "Done" : "Cancel"}
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
