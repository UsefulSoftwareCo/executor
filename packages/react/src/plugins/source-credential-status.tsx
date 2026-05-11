import { Badge } from "../components/badge";
import { Button } from "../components/button";
export {
  effectiveSourceCredentialBinding,
  missingSourceCredentialLabels,
  type SourceCredentialBindingRef,
  type SourceCredentialSlot,
} from "./source-credential-status-core";

export function SourceCredentialStatusBadge(props: { readonly missing: readonly string[] }) {
  if (props.missing.length === 0) {
    return (
      <Badge
        variant="outline"
        className="border-green-500/30 bg-green-500/5 text-[10px] text-green-700 dark:text-green-400"
      >
        Credentials ready
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-300"
    >
      Credentials needed
    </Badge>
  );
}

export function SourceCredentialNotice(props: {
  readonly missing: readonly string[];
  readonly onAction?: () => void;
}) {
  if (props.missing.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-border bg-muted/30 px-4 py-3">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Credentials need attention</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            Missing {props.missing.join(", ")}
          </div>
        </div>
        {props.onAction && (
          <Button size="sm" variant="outline" onClick={props.onAction}>
            Configure
          </Button>
        )}
      </div>
    </div>
  );
}
