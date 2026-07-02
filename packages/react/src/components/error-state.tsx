import { Button } from "./button";
import { cn } from "../lib/utils";

export function ErrorState(props: {
  readonly message: string;
  readonly onRetry: () => void;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3",
        props.className,
      )}
    >
      <p className="text-sm text-destructive">{props.message}</p>
      <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
        Retry
      </Button>
    </div>
  );
}
