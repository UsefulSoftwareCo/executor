/** Optional React bindings backed by Effect Atom. No Effect imports are needed in authored components. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Option } from "effect";
import { AtomRegistry, AsyncResult, type Atom } from "effect/reactivity";
import { queryCommitted } from "./implementation/query-commit.ts";
import { desktop } from "./implementation/desktop.ts";
import type { DesktopPermission, DesktopPermissionState } from "./contracts/desktop.ts";

/** Subscribe for the component lifetime. Each mount owns and disposes its registry, including StrictMode remounts. */
export const useAppQuery = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) => {
  const [state, setState] = useState<{
    atom: typeof atom;
    result: AsyncResult.AsyncResult<A, E>;
  }>();
  useEffect(() => {
    const registry = AtomRegistry.make();
    const stop = registry.subscribe(atom, (result) => setState({ atom, result }), {
      immediate: true,
    });
    return () => {
      stop();
      registry.dispose();
    };
  }, [atom]);
  const result = state?.atom === atom ? state.result : AsyncResult.initial<A, E>();
  useLayoutEffect(() => queryCommitted(result), [result]);
  const value = AsyncResult.value(result);
  return {
    data: Option.getOrUndefined(value),
    pending: result._tag === "Initial",
    error: result._tag === "Failure" ? "Could not load app data." : undefined,
  };
};

const shortcutTurns = new Map<string, Promise<void>>();
const inShortcutTurn = (accelerator: string, step: () => Promise<void>) => {
  const turn = (shortcutTurns.get(accelerator) ?? Promise.resolve()).then(step);
  shortcutTurns.set(accelerator, turn);
  void turn.then(() => {
    if (shortcutTurns.get(accelerator) === turn) shortcutTurns.delete(accelerator);
  });
};
const strandedShortcuts = new Map<string, Set<() => Promise<void>>>();
const removeShortcut = async (accelerator: string, remove: () => Promise<void>) => {
  const removed = await remove().then(
    () => true,
    () => false,
  );
  const stranded = strandedShortcuts.get(accelerator) ?? new Set();
  if (removed) stranded.delete(remove);
  else stranded.add(remove);
  if (stranded.size === 0) strandedShortcuts.delete(accelerator);
  else strandedShortcuts.set(accelerator, stranded);
};
const removeStranded = async (accelerator: string) => {
  for (const remove of strandedShortcuts.get(accelerator) ?? []) {
    await removeShortcut(accelerator, remove);
  }
};

/**
 * Hold a global desktop shortcut while the component is mounted, calling the latest `handler` on
 * each press. Does nothing outside an installed Executor desktop window. Registering and removing
 * one accelerator happen in order, so a remount or a changed accelerator never races its earlier
 * registration; a removal the desktop refused is tried again before the next registration. Returns
 * why the latest registration failed, such as `ShortcutTaken` or `DesktopPermissionDenied` from
 * `apps/client`, or `undefined`.
 */
export const useDesktopShortcut = (accelerator: string, handler: () => void): unknown => {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  const [failure, setFailure] = useState<{ accelerator: string; error: unknown }>();
  useEffect(() => {
    if (!desktop.available) return;
    let active = true;
    let remove: (() => Promise<void>) | undefined;
    inShortcutTurn(accelerator, async () => {
      if (!active) return;
      setFailure(undefined);
      await removeStranded(accelerator);
      await desktop.shortcuts
        .register(accelerator, () => {
          if (active) latest.current();
        })
        .then(
          (registered) => {
            remove = registered;
          },
          (error: unknown) => {
            if (active) setFailure({ accelerator, error });
          },
        );
    });
    return () => {
      active = false;
      inShortcutTurn(accelerator, async () => {
        if (remove !== undefined) await removeShortcut(accelerator, remove);
      });
    };
  }, [accelerator]);
  return failure?.accelerator === accelerator ? failure.error : undefined;
};

/**
 * The person's choice for one desktop permission, read when the component mounts and again each
 * time its window gains focus, since they can change it in the app's menu or the dashboard.
 * `undefined` until the first read; `"unavailable"` outside an installed Executor desktop window.
 */
export const useDesktopPermission = (
  name: DesktopPermission,
): DesktopPermissionState | undefined => {
  const [state, setState] = useState<{ name: DesktopPermission; value: DesktopPermissionState }>();
  useEffect(() => {
    let active = true;
    const read = () =>
      void desktop.permission(name).then(
        (value) => {
          if (active) setState({ name, value });
        },
        () => undefined,
      );
    read();
    const stop = desktop.window.onFocus(read);
    return () => {
      active = false;
      stop();
    };
  }, [name]);
  return state?.name === name ? state.value : undefined;
};

/**
 * Show `count` on the app's icon while the component is mounted (see `desktop.badge.set`), and
 * remove it on unmount. Does nothing outside an installed Executor desktop window. Returns why the
 * latest change failed, such as `DesktopInvalidInput` from `apps/client`, or `undefined`.
 */
export const useDesktopBadge = (count: number | null): unknown => {
  const [failure, setFailure] = useState<{ count: number | null; error: unknown }>();
  useEffect(() => {
    if (!desktop.available) return;
    let active = true;
    void desktop.badge.set(count).then(
      () => {
        if (active) setFailure(undefined);
      },
      (error: unknown) => {
        if (active) setFailure({ count, error });
      },
    );
    return () => {
      active = false;
    };
  }, [count]);
  useEffect(
    () => () => {
      if (desktop.available) void desktop.badge.set(null).catch(() => undefined);
    },
    [],
  );
  return failure?.count === count ? failure.error : undefined;
};

/**
 * Call the latest `handler` whenever this page's desktop window loses focus (`"blur"`) or gains
 * it (`"focus"`), while the component is mounted. Does nothing outside an installed Executor
 * desktop window. Hide a summoned window on blur with
 * `useDesktopWindowEvent("blur", () => void desktop.window.hide())`.
 */
export const useDesktopWindowEvent = (type: "focus" | "blur", handler: () => void): void => {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  useEffect(
    () =>
      type === "blur"
        ? desktop.window.onBlur(() => latest.current())
        : desktop.window.onFocus(() => latest.current()),
    [type],
  );
};
