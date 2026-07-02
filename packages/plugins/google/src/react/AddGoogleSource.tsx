import { useCallback, useMemo, useState } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";

import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import {
  slugifyNamespace,
  useIntegrationIdentity,
} from "@executor-js/react/plugins/integration-identity";
import { Button } from "@executor-js/react/components/button";
import { FloatActions } from "@executor-js/react/components/float-actions";
import {
  addIntegrationErrorMessage,
  FormErrorAlert,
  SlugCollisionAlert,
  useSlugAlreadyExists,
} from "@executor-js/react/lib/integration-add";
import { OpenApiSourceDetailsFields } from "@executor-js/plugin-openapi/react";

import { addGoogleBundle } from "./atoms";
import { GoogleProductPicker } from "./GoogleProductPicker";
import {
  GOOGLE_PHOTOS_PRESET_ID,
  googleOpenApiPresets,
  googlePhotosPresetIds,
  type GoogleOpenApiPreset,
} from "../sdk/presets";

const GOOGLE_BUNDLE_FAVICON = "https://fonts.gstatic.com/s/i/productlogos/googleg/v6/192px.svg";

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
  return [...new Set([...fromPresets, ...customUrls])];
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
  const [addError, setAddError] = useState<string | null>(null);

  const identity = useIntegrationIdentity({
    fallbackName: isGooglePhotosPreset ? "Google Photos" : "Google",
    fallbackNamespace:
      props.initialNamespace ?? (isGooglePhotosPreset ? "google_photos" : "google"),
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

  const doAdd = useAtomSet(addGoogleBundle, { mode: "promiseExit" });

  const resolvedSourceId =
    slugifyNamespace(identity.namespace) || (isGooglePhotosPreset ? "google_photos" : "google");
  const resolvedDisplayName =
    identity.name.trim() || (isGooglePhotosPreset ? "Google Photos" : "Google");
  const resolvedDescription =
    descriptionDraft ??
    (isGooglePhotosPreset
      ? "Google Photos albums, uploads, app-created media, and selected picker media."
      : "Google APIs");
  const slugAlreadyExists = useSlugAlreadyExists(resolvedSourceId);
  const canAdd = bundleDiscoveryUrls.length > 0 && !slugAlreadyExists;

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);
    const exit = await doAdd({
      payload: {
        urls: [...bundleDiscoveryUrls],
        slug: resolvedSourceId,
        name: resolvedDisplayName,
        ...(resolvedDescription.trim().length > 0
          ? { description: resolvedDescription.trim() }
          : {}),
        ...(baseUrl.trim().length > 0 ? { baseUrl: baseUrl.trim() } : {}),
      },
      reactivityKeys: integrationWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setAddError(addIntegrationErrorMessage(exit, resolvedSourceId, "Failed to add Google"));
      setAdding(false);
      return;
    }
    props.onComplete(String(exit.value.slug));
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Add Google</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Bundle Google APIs into one integration with a shared OAuth consent.
        </p>
      </div>

      <GoogleProductPicker
        selectedPresetIds={selectedPresetIds}
        onToggle={toggleBundlePreset}
        customUrls={customDiscoveryUrls}
        onAddCustomUrl={addCustomDiscoveryUrl}
        onRemoveCustomUrl={removeCustomDiscoveryUrl}
      />

      <OpenApiSourceDetailsFields
        title="Google"
        subtitle={`${bundleDiscoveryUrls.length} Google API${
          bundleDiscoveryUrls.length !== 1 ? "s" : ""
        } · one shared OAuth consent`}
        identity={identity}
        description={resolvedDescription}
        onDescriptionChange={setDescriptionDraft}
        baseUrl={baseUrl}
        onBaseUrlChange={setBaseUrl}
        baseUrlLabel="Base URL override (optional)"
        faviconIcon={GOOGLE_BUNDLE_FAVICON}
        faviconUrl={baseUrl}
      />

      {slugAlreadyExists && !adding && <SlugCollisionAlert slug={resolvedSourceId} />}

      {addError && <FormErrorAlert message={addError} />}

      <FloatActions>
        <Button variant="ghost" onClick={() => props.onCancel()} disabled={adding}>
          Cancel
        </Button>
        <Button onClick={() => void handleAdd()} disabled={!canAdd} loading={adding}>
          Connect Google
        </Button>
      </FloatActions>
    </div>
  );
}
