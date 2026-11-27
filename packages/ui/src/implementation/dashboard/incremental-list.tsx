import { useEffect, useRef, useState, type RefObject } from "react";

export function useIncrementalList(
  total: number,
  reset: string,
  step = 100,
  root?: RefObject<Element | null>,
) {
  const [state, setState] = useState({ reset, count: step });
  const count = state.reset === reset ? state.count : step;
  if (state.reset !== reset) setState({ reset, count: step });
  const sentinel = useRef<HTMLDivElement>(null);
  const more = count < total;
  useEffect(() => {
    const element = sentinel.current;
    if (!more || element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          setState((previous) => ({ reset: previous.reset, count: previous.count + step }));
      },
      { root: root?.current ?? null, rootMargin: "400px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [more, count, step, root]);
  return {
    count: Math.min(count, total),
    sentinel: more ? <div ref={sentinel} aria-hidden className="h-px" /> : null,
  };
}
