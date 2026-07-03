import { ExternalLink, GitCompare } from "lucide-react";
import { Button } from "@/components/ui/button";

type MergePrDialogActionsProps = {
  canViewDiff: boolean;
  canOpenPullRequest: boolean;
  onOpenPullRequest: () => void;
  onViewDiff?: () => void;
};

export function MergePrDialogActions({
  canViewDiff,
  canOpenPullRequest,
  onOpenPullRequest,
  onViewDiff,
}: MergePrDialogActionsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onOpenPullRequest}
        disabled={!canOpenPullRequest}
      >
        <ExternalLink className="mr-2 h-4 w-4" />
        View PR
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onViewDiff}
        disabled={!canViewDiff || !onViewDiff}
      >
        <GitCompare className="mr-2 h-4 w-4" />
        View Diff
      </Button>
    </div>
  );
}
