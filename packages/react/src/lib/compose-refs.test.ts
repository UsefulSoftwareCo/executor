import { describe, expect, it } from "@effect/vitest";

import { composedRefCallback } from "./compose-refs";

/**
 * The contract under test: both refs always see the same node, across the
 * three shapes an incoming ref can take (object, plain callback, React 19
 * callback with cleanup). The cleanup case matters most — React never calls
 * the callback with `null` when a cleanup was returned, so clearing the local
 * ref has to happen inside the merged cleanup or it dangles forever.
 */
describe("composedRefCallback", () => {
  const node = { nodeName: "DIV" };

  it("tracks attach and detach in both an object ref and the local ref", () => {
    const outer: { current: typeof node | null } = { current: null };
    const local: { current: typeof node | null } = { current: null };
    const callback = composedRefCallback(outer, local);

    expect(callback(node)).toBeUndefined();
    expect(outer.current).toBe(node);
    expect(local.current).toBe(node);

    callback(null);
    expect(outer.current).toBeNull();
    expect(local.current).toBeNull();
  });

  it("forwards attach and detach to a plain callback ref", () => {
    const seen: Array<typeof node | null> = [];
    const local: { current: typeof node | null } = { current: null };
    const callback = composedRefCallback((value: typeof node | null) => {
      seen.push(value);
    }, local);

    expect(callback(node)).toBeUndefined();
    callback(null);
    expect(seen).toEqual([node, null]);
    expect(local.current).toBeNull();
  });

  it("preserves a React 19 cleanup and clears the local ref inside it", () => {
    let cleanedUp = false;
    const local: { current: typeof node | null } = { current: null };
    const callback = composedRefCallback(() => {
      return () => {
        cleanedUp = true;
      };
    }, local);

    const cleanup = callback(node);
    expect(local.current).toBe(node);
    expect(typeof cleanup).toBe("function");

    (cleanup as () => void)();
    expect(cleanedUp).toBe(true);
    expect(local.current).toBeNull();
  });

  it("still tracks the local ref when no outer ref is given", () => {
    const local: { current: typeof node | null } = { current: null };
    const callback = composedRefCallback(undefined, local);
    callback(node);
    expect(local.current).toBe(node);
    callback(null);
    expect(local.current).toBeNull();
  });
});
