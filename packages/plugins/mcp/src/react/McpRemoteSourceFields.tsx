import { Badge } from "@executor-js/react/components/badge";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryField,
  CardStackEntryMedia,
  CardStackEntryTitle,
} from "@executor-js/react/components/card-stack";
import { FieldError } from "@executor-js/react/components/field";
import { Input } from "@executor-js/react/components/input";
import { Skeleton } from "@executor-js/react/components/skeleton";
import { SourceFavicon } from "@executor-js/react/components/source-favicon";
import { IOSSpinner } from "@executor-js/react/components/spinner";
import { Button } from "@executor-js/react/components/button";
import {
  SourceIdentityFieldRows,
  type SourceIdentity,
} from "@executor-js/react/plugins/source-identity";

export type McpRemoteSourcePreview = {
  readonly name: string;
  readonly serverName: string | null;
  readonly connected: boolean;
  readonly toolCount: number | null;
};

export function McpRemoteSourceFields(props: {
  readonly url: string;
  readonly onUrlChange: (url: string) => void;
  readonly identity: SourceIdentity;
  readonly preview: McpRemoteSourcePreview | null;
  readonly probing?: boolean;
  readonly error?: string | null;
  readonly onRetry?: () => void;
  readonly namespaceReadOnly?: boolean;
  readonly urlDisabled?: boolean;
}) {
  const previewDescription = props.preview
    ? props.preview.connected
      ? props.preview.toolCount === null
        ? null
        : `${props.preview.toolCount} tool${props.preview.toolCount !== 1 ? "s" : ""} available`
      : "OAuth required to discover tools"
    : null;

  if (props.preview) {
    return (
      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntry>
            <CardStackEntryMedia>
              <SourceFavicon url={props.url} size={32} />
            </CardStackEntryMedia>
            <CardStackEntryContent>
              <CardStackEntryTitle>
                {props.preview.serverName ?? props.preview.name}
              </CardStackEntryTitle>
              {previewDescription ? (
                <CardStackEntryDescription>{previewDescription}</CardStackEntryDescription>
              ) : null}
            </CardStackEntryContent>
            <CardStackEntryActions>
              {props.preview.connected ? (
                <Badge
                  variant="outline"
                  className="border-emerald-500/20 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400"
                >
                  Connected
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="border-amber-500/20 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-400"
                >
                  OAuth required
                </Badge>
              )}
            </CardStackEntryActions>
          </CardStackEntry>
          <SourceIdentityFieldRows
            identity={props.identity}
            namePlaceholder="e.g. Linear"
            namespaceReadOnly={props.namespaceReadOnly}
          />
          <CardStackEntryField label="Server URL">
            <Input
              value={props.url}
              onChange={(e) => props.onUrlChange((e.target as HTMLInputElement).value)}
              placeholder="https://mcp.example.com"
              className="w-full font-mono text-sm"
              disabled={props.urlDisabled}
            />
          </CardStackEntryField>
        </CardStackContent>
      </CardStack>
    );
  }

  if (props.probing) {
    return (
      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntry>
            <CardStackEntryMedia>
              <Skeleton className="size-4 rounded" />
            </CardStackEntryMedia>
            <CardStackEntryContent>
              <Skeleton className="h-4 w-40" />
              <Skeleton className="mt-1 h-3 w-32" />
            </CardStackEntryContent>
            <CardStackEntryActions>
              <Skeleton className="h-4 w-20 rounded-full" />
            </CardStackEntryActions>
          </CardStackEntry>
        </CardStackContent>
      </CardStack>
    );
  }

  return (
    <CardStack>
      <CardStackContent className="border-t-0">
        <CardStackEntryField label="Server URL">
          <div className="relative">
            <Input
              value={props.url}
              onChange={(e) => props.onUrlChange((e.target as HTMLInputElement).value)}
              placeholder="https://mcp.example.com"
              className="w-full pr-9 font-mono text-sm"
              aria-invalid={props.error ? true : undefined}
              disabled={props.urlDisabled}
            />
            {props.probing && (
              <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                <IOSSpinner className="size-4" />
              </div>
            )}
          </div>
          {props.error && (
            <div className="mt-2 space-y-2">
              <FieldError>{props.error}</FieldError>
              {props.onRetry && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={props.onRetry}
                  className="h-7 px-2 text-xs"
                >
                  Try again
                </Button>
              )}
            </div>
          )}
        </CardStackEntryField>
      </CardStackContent>
    </CardStack>
  );
}
