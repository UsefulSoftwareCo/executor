import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useScope } from "@executor-js/react/api/scope-context";
import { Badge } from "@executor-js/react/components/badge";
import { Button } from "@executor-js/react/components/button";

import { googleDiscoverySourceAtom } from "./atoms";
import GoogleDiscoverySignInButton from "./GoogleDiscoverySignInButton";

export default function EditGoogleDiscoverySource({
  sourceId,
  onSave,
}: {
  readonly sourceId: string;
  readonly onSave: () => void;
}) {
  const scopeId = useScope();
  const sourceResult = useAtomValue(googleDiscoverySourceAtom(scopeId, sourceId));

  const source = AsyncResult.isSuccess(sourceResult) ? sourceResult.value : null;
  const config = source?.config;
  const authKind = config?.auth.kind ?? "none";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Edit Google Discovery Source</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          View configuration for this Google API source. To change authentication, remove and re-add
          the source with updated OAuth credentials.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-card-foreground">
            {source?.name ?? sourceId}
          </p>
          {config?.discoveryUrl && (
            <p className="mt-0.5 text-xs text-muted-foreground font-mono truncate">
              {config.discoveryUrl}
            </p>
          )}
        </div>
        <Badge variant="secondary" className="text-xs">
          Google Discovery
        </Badge>
      </div>

      {config && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg border border-border bg-card/50 p-3">
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Service</p>
              <p className="text-sm font-medium text-foreground">{config.service}</p>
            </div>
            <div className="rounded-lg border border-border bg-card/50 p-3">
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Version</p>
              <p className="text-sm font-medium text-foreground">{config.version}</p>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card/50 p-3">
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
              Authentication
            </p>
            <div className="flex min-h-9 items-center justify-between gap-3">
              <p className="text-sm font-medium text-foreground capitalize">
                {authKind === "oauth2" ? "OAuth 2.0" : authKind}
              </p>
              {authKind === "oauth2" && <GoogleDiscoverySignInButton sourceId={sourceId} />}
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-end border-t border-border pt-4">
        <Button onClick={onSave}>Done</Button>
      </div>
    </div>
  );
}
