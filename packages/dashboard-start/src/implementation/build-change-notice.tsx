import { useSyncExternalStore } from "react";
import { Button } from "@executor-js/ui/components/button";
import { pageOutdated, subscribePageOutdated } from "./build-change.ts";

/**
 * Offers a reload once the server reports another build. It does not reload by itself: the page
 * may hold unsaved input, and its requests keep working where the API did not change.
 */
export function BuildChangeNotice() {
  const outdated = useSyncExternalStore(subscribePageOutdated, pageOutdated, () => false);
  if (!outdated) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-fit max-w-[calc(100%-2rem)] items-center gap-3 rounded-lg border bg-card px-4 py-2 text-sm text-card-foreground shadow-lg"
    >
      <span>Executor was updated. Reload to use the new version.</span>
      <Button size="sm" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}
