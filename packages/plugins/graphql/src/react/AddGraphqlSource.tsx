import { useCallback, useMemo, useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { integrationsOptimisticAtom } from "@executor-js/react/api/atoms";
import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import {
  integrationDisplayNameFromUrl,
  slugifyNamespace,
  useIntegrationIdentity,
} from "@executor-js/react/plugins/integration-identity";
import { Button } from "@executor-js/react/components/button";
import {
  AuthTemplateEditor,
  type AuthTemplateEditorValue,
} from "@executor-js/react/components/auth-template-editor";
import { FieldLabel } from "@executor-js/react/components/field";
import { FloatActions } from "@executor-js/react/components/float-actions";
import { Spinner } from "@executor-js/react/components/spinner";

import { addGraphqlIntegrationOptimistic } from "./atoms";
import { GraphqlSourceFields } from "./GraphqlSourceFields";
import { graphqlTemplatesFromPlacements } from "./auth-method-config";

const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeErrorMessage = Schema.decodeUnknownOption(ErrorMessage);

const errorMessageFromExit = (exit: Exit.Exit<unknown, unknown>, fallback: string): string =>
  Option.match(Option.flatMap(Exit.findErrorOption(exit), decodeErrorMessage), {
    onNone: () => fallback,
    onSome: ({ message }) => message,
  });

const isIntegrationAlreadyExistsExit = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Option.match(Exit.findErrorOption(exit), {
    onNone: () => false,
    onSome: Predicate.isTagged("IntegrationAlreadyExistsError"),
  });

const integrationExistsMessage = (slug: string): string =>
  `An integration named "${slug}" already exists. To add more authentication, update your existing integration.`;

// v2 GraphQL add flow (post-redesign): register the integration (introspects
// the endpoint and declares an apiKey auth template when the user configures a
// header), then route to the integration's detail hub. Connection creation is
// no longer part of the add flow — accounts are added from the hub (P6: add
// without auth, connect later). Auth is declared through the shared
// `AuthTemplateEditor` (GraphQL stays header/query apiKey — OAuth is hidden).

export default function AddGraphqlSource(props: {
  onComplete: (slug?: string) => void;
  onCancel: () => void;
  initialUrl?: string;
}) {
  const [endpoint, setEndpoint] = useState(props.initialUrl ?? "");
  const identity = useIntegrationIdentity({
    fallbackName: integrationDisplayNameFromUrl(endpoint, "GraphQL") ?? "",
  });
  const [authValue, setAuthValue] = useState<AuthTemplateEditorValue>({ kind: "none" });
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const doAddIntegration = useAtomSet(addGraphqlIntegrationOptimistic, {
    mode: "promiseExit",
  });

  // An apiKey method needs at least one named placement; `none` is always valid.
  const apiKeyComplete =
    authValue.kind !== "apikey" ||
    authValue.placements.some((placement) => placement.name.trim().length > 0);

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
  const integrationsResult = useAtomValue(integrationsOptimisticAtom);
  const slugAlreadyExists = useMemo(
    () =>
      AsyncResult.isSuccess(integrationsResult) &&
      integrationsResult.value.some((integration) => String(integration.slug) === resolvedSlug),
    [integrationsResult, resolvedSlug],
  );

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

    const authenticationTemplate =
      authValue.kind === "apikey" ? graphqlTemplatesFromPlacements(authValue.placements) : [];

    const integrationExit = await doAddIntegration({
      payload: {
        endpoint: trimmedEndpoint,
        slug,
        name: displayName,
        ...(authenticationTemplate.length > 0 ? { authenticationTemplate } : {}),
      },
      reactivityKeys: integrationWriteKeys,
    });
    if (Exit.isFailure(integrationExit)) {
      setAddError(
        isIntegrationAlreadyExistsExit(integrationExit)
          ? integrationExistsMessage(slug)
          : errorMessageFromExit(integrationExit, "Failed to add source"),
      );
      setAdding(false);
      return;
    }
    const registeredSlug = integrationExit.value.slug;

    props.onComplete(String(registeredSlug));
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <h1 className="text-xl font-semibold text-foreground">Add GraphQL Source</h1>

      <GraphqlSourceFields endpoint={endpoint} onEndpointChange={setEndpoint} identity={identity} />

      <section className="space-y-2.5">
        <FieldLabel>How does this API authenticate?</FieldLabel>
        <AuthTemplateEditor
          value={authValue}
          onChange={setAuthValue}
          allowedKinds={["none", "apikey"]}
        />
      </section>

      {slugAlreadyExists && !adding && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-[12px] text-destructive">
            An integration named &quot;{resolvedSlug}&quot; already exists. To add more
            authentication, update your existing integration.{" "}
            <Link
              to="/integrations/$namespace"
              params={{ namespace: resolvedSlug }}
              className="font-medium underline underline-offset-2"
            >
              Open it
            </Link>
          </p>
        </div>
      )}

      {addError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-[12px] text-destructive">{addError}</p>
        </div>
      )}

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
