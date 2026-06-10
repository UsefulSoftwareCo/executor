import type { Connection, OAuthClientSummary } from "@executor-js/sdk/shared";

import { ownerLabel } from "../api/owner-display";
import { Alert, AlertDescription, AlertTitle } from "./alert";
import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";

// ---------------------------------------------------------------------------
// Remove-confirm dialog for a registered OAuth app — warns (does not block)
// when the app still backs connections. Removal never cascades into those
// connections; they keep their stored slug and surface a reconnect prompt at
// their next token refresh.
// ---------------------------------------------------------------------------

export function RemoveOAuthAppDialog(props: {
  readonly client: OAuthClientSummary;
  readonly connections: readonly Connection[];
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  const { client, connections } = props;
  const inUse = connections.length > 0;
  return (
    <Dialog open onOpenChange={(open: boolean) => (open ? undefined : props.onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {String(client.slug)}?</DialogTitle>
          <DialogDescription>
            This permanently removes the {ownerLabel(client.owner).toLowerCase()} OAuth app and its
            stored client credentials.
          </DialogDescription>
        </DialogHeader>

        {inUse ? (
          <Alert variant="destructive">
            <AlertTitle>
              This app backs {connections.length} connection
              {connections.length === 1 ? "" : "s"}
            </AlertTitle>
            <AlertDescription>
              <p>
                Removing it won&apos;t delete those connections, but they&apos;ll need to reconnect
                at their next token refresh.
              </p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {connections.map((connection: Connection) => (
                  <li
                    key={`${connection.owner}.${String(connection.integration)}.${String(connection.name)}`}
                    className="font-mono text-xs"
                  >
                    {String(connection.integration)} / {String(connection.name)}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={props.onConfirm}>
            Remove app
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
