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

import { addMicrosoftGraph } from "./atoms";
import { MicrosoftScopePicker } from "./MicrosoftScopePicker";
import {
  MICROSOFT_GRAPH_BASE_URL,
  MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
  microsoftGraphScopesForPresetIds,
} from "../sdk/presets";

const MICROSOFT_FAVICON = "https://www.microsoft.com/favicon.ico";

const defaultPresetIds: ReadonlySet<string> = new Set(MICROSOFT_GRAPH_DEFAULT_PRESET_IDS);

export default function AddMicrosoftSource(props: {
  onComplete: (slug?: string) => void;
  onCancel: () => void;
  initialNamespace?: string;
}) {
  const [selectedPresetIds, setSelectedPresetIds] = useState<ReadonlySet<string>>(defaultPresetIds);
  const [customScopes, setCustomScopes] = useState<readonly string[]>([]);
  const [baseUrl, setBaseUrl] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const identity = useIntegrationIdentity({
    fallbackName: "Microsoft Graph",
    fallbackNamespace: props.initialNamespace ?? "microsoft_graph",
  });

  const selectedIds = useMemo(() => [...selectedPresetIds], [selectedPresetIds]);
  const selectedScopes = useMemo(
    () => microsoftGraphScopesForPresetIds(selectedIds, customScopes),
    [selectedIds, customScopes],
  );

  const togglePreset = useCallback((presetId: string, checked: boolean) => {
    setSelectedPresetIds((current: ReadonlySet<string>) => {
      const next = new Set(current);
      if (checked) next.add(presetId);
      else next.delete(presetId);
      return next;
    });
  }, []);

  const addCustomScope = useCallback((scope: string) => {
    setCustomScopes((current: readonly string[]) =>
      current.includes(scope) ? current : [...current, scope],
    );
  }, []);

  const removeCustomScope = useCallback((scope: string) => {
    setCustomScopes((current: readonly string[]) =>
      current.filter((entry: string) => entry !== scope),
    );
  }, []);

  const doAdd = useAtomSet(addMicrosoftGraph, { mode: "promiseExit" });

  const resolvedSourceId = slugifyNamespace(identity.namespace) || "microsoft_graph";
  const resolvedDisplayName = identity.name.trim() || "Microsoft Graph";
  const resolvedDescription = descriptionDraft ?? "Selected Microsoft Graph workloads.";
  const slugAlreadyExists = useSlugAlreadyExists(resolvedSourceId);
  const canAdd = selectedIds.length > 0 && !slugAlreadyExists;

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);
    const exit = await doAdd({
      payload: {
        presetIds: selectedIds,
        customScopes: [...customScopes],
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
      setAddError(addIntegrationErrorMessage(exit, resolvedSourceId, "Failed to add Microsoft"));
      setAdding(false);
      return;
    }
    props.onComplete(String(exit.value.slug));
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Add Microsoft Graph</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Pick Microsoft 365 workloads and connect them through one delegated OAuth consent.
        </p>
      </div>

      <MicrosoftScopePicker
        selectedPresetIds={selectedPresetIds}
        onToggle={togglePreset}
        customScopes={customScopes}
        onAddCustomScope={addCustomScope}
        onRemoveCustomScope={removeCustomScope}
      />

      <OpenApiSourceDetailsFields
        title="Microsoft Graph"
        subtitle={`${selectedIds.length} operation group${
          selectedIds.length !== 1 ? "s" : ""
        } with ${selectedScopes.length} preview scope${selectedScopes.length !== 1 ? "s" : ""}`}
        identity={identity}
        description={resolvedDescription}
        onDescriptionChange={setDescriptionDraft}
        baseUrl={baseUrl}
        onBaseUrlChange={setBaseUrl}
        baseUrlLabel="Base URL override (optional)"
        baseUrlPlaceholder={MICROSOFT_GRAPH_BASE_URL}
        faviconIcon={MICROSOFT_FAVICON}
        faviconUrl={baseUrl || MICROSOFT_GRAPH_BASE_URL}
      />

      {slugAlreadyExists && !adding && <SlugCollisionAlert slug={resolvedSourceId} />}

      {addError && <FormErrorAlert message={addError} />}

      <FloatActions>
        <Button variant="ghost" onClick={() => props.onCancel()} disabled={adding}>
          Cancel
        </Button>
        <Button onClick={() => void handleAdd()} disabled={!canAdd} loading={adding}>
          Connect Microsoft
        </Button>
      </FloatActions>
    </div>
  );
}
