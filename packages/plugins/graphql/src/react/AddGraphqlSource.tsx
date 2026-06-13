import { useCallback, useMemo, useState } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";

import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import {
  integrationDisplayNameFromUrl,
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
import { FloatActions } from "@executor-js/react/components/float-actions";
import { Spinner } from "@executor-js/react/components/spinner";
import {
  addIntegrationErrorMessage,
  FormErrorAlert,
  SlugCollisionAlert,
  useSlugAlreadyExists,
} from "@executor-js/react/lib/integration-add";

import { addGraphqlIntegrationOptimistic } from "./atoms";
import { GraphqlSourceFields } from "./GraphqlSourceFields";
import { graphqlAuthMethodInputsFromPlacements } from "./auth-method-config";
import type { GraphqlAuthMethodInput } from "../sdk/types";

// v2 GraphQL add flow: register the integration with its declared auth-method
// LIST (the shared `AuthMethodListEditor` — GraphQL stays header/query apiKey;
// OAuth is hidden), then route to the integration's detail hub. Connection
// creation is no longer part of the add flow — accounts are added from the hub
// (P6: add without auth, connect later).

// GraphQL has no add-time detection, so the list starts empty (module constant
// — a fresh [] every render would re-seed the list each render).
const NO_SEEDS: readonly AuthMethodSeed[] = [];

export default function AddGraphqlSource(props: {
  onComplete: (slug?: string) => void;
  onCancel: () => void;
  initialUrl?: string;
}) {
  const [endpoint, setEndpoint] = useState(props.initialUrl ?? "");
  const [description, setDescription] = useState("");
  const identity = useIntegrationIdentity({
    fallbackName: integrationDisplayNameFromUrl(endpoint, "GraphQL") ?? "",
  });
  const authMethodList = useAuthMethodList(NO_SEEDS);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const doAddIntegration = useAtomSet(addGraphqlIntegrationOptimistic, {
    mode: "promiseExit",
  });

  // The methods to register: each apikey row declares ONE method carrying
  // every named placement (header + query mix in a single method). Inputs
  // omit slugs — the backend assigns carrier-derived ones. `none` rows
  // register nothing.
  const authenticationTemplate = useMemo<readonly GraphqlAuthMethodInput[]>(
    () =>
      authMethodList.rows.flatMap((row: AuthMethodRow) =>
        row.value.kind === "apikey"
          ? graphqlAuthMethodInputsFromPlacements(row.value.placements)
          : [],
      ),
    [authMethodList.rows],
  );

  // Every apikey row needs at least one named placement; `none` rows are
  // always valid.
  const apiKeyComplete = authMethodList.rows.every(
    (row: AuthMethodRow) =>
      row.value.kind !== "apikey" ||
      row.value.placements.some((placement) => placement.name.trim().length > 0),
  );

  const resolvedSlug = useMemo(
    () =>
      slugifyNamespace(identity.namespace) ||
      slugifyNamespace(integrationDisplayNameFromUrl(endpoint.trim(), "GraphQL") ?? "") ||
      "graphql",
    [endpoint, identity.namespace],
  );

  // Pre-empt the API's `IntegrationAlreadyExistsError`: adding an integration
  // whose slug already exists clobbers the existing one's connections/policies,
  // so the API blocks it. Surface that here from the tenant-scoped catalog list.
  const slugAlreadyExists = useSlugAlreadyExists(resolvedSlug);

  const canAdd = endpoint.trim().length > 0 && apiKeyComplete && !adding && !slugAlreadyExists;

  const sourceIdentity = useCallback(() => {
    const trimmedEndpoint = endpoint.trim();
    const slug = resolvedSlug;
    const displayName =
      identity.name.trim() || integrationDisplayNameFromUrl(trimmedEndpoint, "GraphQL") || slug;
    return { trimmedEndpoint, slug, displayName };
  }, [endpoint, identity.name, resolvedSlug]);

  const handleAdd = async (): Promise<void> => {
    setAdding(true);
    setAddError(null);
    const { trimmedEndpoint, slug, displayName } = sourceIdentity();

    const integrationExit = await doAddIntegration({
      payload: {
        endpoint: trimmedEndpoint,
        slug,
        name: displayName,
        ...(description.trim().length > 0 ? { description: description.trim() } : {}),
        ...(authenticationTemplate.length > 0
          ? { authenticationTemplate: [...authenticationTemplate] }
          : {}),
      },
      reactivityKeys: integrationWriteKeys,
    });
    if (Exit.isFailure(integrationExit)) {
      setAddError(addIntegrationErrorMessage(integrationExit, slug, "Failed to add source"));
      setAdding(false);
      return;
    }
    const registeredSlug = integrationExit.value.slug;

    props.onComplete(String(registeredSlug));
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <h1 className="text-xl font-semibold text-foreground">Add GraphQL Source</h1>

      <GraphqlSourceFields
        endpoint={endpoint}
        onEndpointChange={setEndpoint}
        identity={identity}
        description={description}
        onDescriptionChange={setDescription}
      />

      <AuthMethodListEditor
        list={authMethodList}
        allowedKinds={["none", "apikey"]}
        emptyHint="No authentication declared. Add a method, or add the source without auth and connect an account from the integration page later."
        footerHint="Every method here is registered with the source. Connect an account from the integration page after adding."
      />

      {slugAlreadyExists && !adding && <SlugCollisionAlert slug={resolvedSlug} />}

      {addError && <FormErrorAlert message={addError} />}

      <FloatActions>
        <Button variant="ghost" onClick={() => props.onCancel()} disabled={adding}>
          Cancel
        </Button>
        <Button onClick={() => void handleAdd()} disabled={!canAdd}>
          {adding && <Spinner className="size-3.5" />}
          {adding ? "Adding..." : "Add source"}
        </Button>
      </FloatActions>
    </div>
  );
}
