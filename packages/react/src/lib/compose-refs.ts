import * as React from "react";

/**
 * One callback ref that keeps an incoming ref and a local ref on the same node.
 *
 * A React 19 callback ref may return a cleanup function; when the incoming ref
 * does, React runs that cleanup instead of calling the callback again with
 * `null`, so the local ref must be cleared inside the cleanup too.
 */
export const composedRefCallback =
  <T>(outer: React.Ref<T> | undefined, local: React.RefObject<T | null>): React.RefCallback<T> =>
  (node) => {
    local.current = node;
    if (typeof outer === "function") {
      const cleanup = outer(node);
      if (typeof cleanup === "function") {
        return () => {
          local.current = null;
          cleanup();
        };
      }
      return undefined;
    }
    if (outer) outer.current = node;
    return undefined;
  };

/** `composedRefCallback`, kept stable across renders for stable inputs so the
 *  incoming ref is not detached and reattached on every render. */
export const useComposedRef = <T>(
  outer: React.Ref<T> | undefined,
  local: React.RefObject<T | null>,
): React.RefCallback<T> => React.useMemo(() => composedRefCallback(outer, local), [outer, local]);
