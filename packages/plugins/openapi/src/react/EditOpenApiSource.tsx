import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { connectionsAllAtom } from "@executor-js/react/api/atoms";
import { ownerLabel, useOwnerDisplay } from "@executor-js/react/api/owner-display";
import { IntegrationSlug, type Connection } from "@executor-js/sdk/shared";
import { Badge } from "@executor-js/react/components/badge";
import { Button } from "@executor-js/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryTitle,
} from "@executor-js/react/components/card-stack";

import { openApiIntegrationAtom } from "./atoms";

// ---------------------------------------------------------------------------
// v2 edit — the integration's spec, base URL, and auth templates are part of
// its catalog config, which core treats as opaque and the API exposes as a
// read-only `getIntegration`. There are no per-scope source rows, no credential
// slots, and no binding writers to configure here anymore. Editing is reduced
// to surfacing the integration's identity and its current connections; new
// credentials are created on the integration's detail/connections surface.
// ---------------------------------------------------------------------------

export default function EditOpenApiSource(props: {
  readonly sourceId: string;
  readonly onSave: () => void;
}) {
  const slug = IntegrationSlug.make(props.sourceId);
  const integrationResult = useAtomValue(openApiIntegrationAtom(slug));
  const ownerDisplay = useOwnerDisplay();
  // Connections across BOTH owners (omit-owner read); each row keeps its owner
  // for the per-connection badge below.
  const connectionsResult = useAtomValue(connectionsAllAtom);

  const integration =
    AsyncResult.isSuccess(integrationResult) && integrationResult.value
      ? integrationResult.value
      : null;
  const connections: readonly Connection[] = AsyncResult.isSuccess(connectionsResult)
    ? connectionsResult.value.filter((candidate: Connection) => candidate.integration === slug)
    : [];

  if (!integration) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold text-foreground">OpenAPI Integration</h1>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">OpenAPI Integration</h1>
      </div>

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntry>
            <CardStackEntryContent>
              <CardStackEntryTitle>{integration.description || String(slug)}</CardStackEntryTitle>
              <CardStackEntryDescription>{String(slug)}</CardStackEntryDescription>
            </CardStackEntryContent>
            <Badge variant="secondary">{integration.kind}</Badge>
          </CardStackEntry>
        </CardStackContent>
      </CardStack>

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntry>
            <CardStackEntryContent>
              <CardStackEntryTitle>Connections</CardStackEntryTitle>
              <CardStackEntryDescription>
                Credentials this integration uses to call its API.
              </CardStackEntryDescription>
            </CardStackEntryContent>
          </CardStackEntry>
          {connections.length === 0 ? (
            <CardStackEntry>
              <CardStackEntryContent>
                <CardStackEntryDescription>No connections yet.</CardStackEntryDescription>
              </CardStackEntryContent>
            </CardStackEntry>
          ) : (
            connections.map((connection: Connection) => (
              <CardStackEntry key={`${connection.owner}:${connection.name}`}>
                <CardStackEntryContent>
                  <CardStackEntryTitle>
                    {connection.identityLabel ?? String(connection.name)}
                  </CardStackEntryTitle>
                  <CardStackEntryDescription>
                    {String(connection.template)} · {String(connection.provider)}
                  </CardStackEntryDescription>
                </CardStackEntryContent>
                {ownerDisplay.showOwnerLabels ? (
                  <Badge variant="outline">{ownerLabel(connection.owner)}</Badge>
                ) : null}
              </CardStackEntry>
            ))
          )}
        </CardStackContent>
      </CardStack>

      <div className="flex items-center justify-start border-t border-border pt-4">
        <Button variant="ghost" onClick={props.onSave}>
          Back
        </Button>
      </div>
    </div>
  );
}
