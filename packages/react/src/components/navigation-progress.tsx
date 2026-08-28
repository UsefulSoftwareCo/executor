import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";

/**
 * A delayed, overlayed acknowledgement for route transitions. The delay keeps
 * fast navigations quiet while still making a slow route or data request feel
 * active instead of frozen.
 */
export function NavigationProgress() {
  const isLoading = useRouterState({ select: (state) => state.isLoading });
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      setVisible(false);
      return;
    }

    const timeout = globalThis.setTimeout(() => setVisible(true), 180);
    return () => globalThis.clearTimeout(timeout);
  }, [isLoading]);

  if (!visible) return null;

  return (
    <div
      aria-label="Loading page"
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-px bg-border/50"
      role="status"
    >
      <div className="navigation-progress-bar h-px w-1/3 bg-foreground/70" />
    </div>
  );
}
