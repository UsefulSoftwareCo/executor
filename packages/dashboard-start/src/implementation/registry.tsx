/// <reference types="vite/client" />
/**
 * One atom registry per router. On the server, a render that reads unresolved data suspends to
 * the nearest Suspense boundary, whose skeleton streams first; the content streams when the data
 * arrives. Every settled serializable atom streams to the browser ahead of the HTML that used it,
 * so hydration renders the same values without requesting them again. Reads started with a check
 * stream only once the check succeeds (`useGuardedPreload`).
 */
import { RegistryContext, scheduleTask, useAtomValue } from "@effect/atom-react";
import type { AnyRouter } from "@tanstack/react-router";
import { Cause } from "effect";
import { AsyncResult, Atom, AtomRegistry, Hydration } from "effect/reactivity";
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";

interface DehydratedAtoms {
  readonly initial: ReadonlyArray<Hydration.DehydratedAtom>;
  readonly stream: ReadableStream<ReadonlyArray<Hydration.DehydratedAtom>>;
}

/** A read in flight. An idle mutation is also `Initial`, but it is not waiting for anything. */
const pendingResult = (value: unknown) =>
  AsyncResult.isAsyncResult(value) && AsyncResult.isInitial(value) && value.waiting;

/**
 * A read that has not settled by then renders its loading state, like the browser would, and the
 * browser requests it after hydration. This bounds a hung dependency, not ordinary slow reads,
 * which already stream behind their skeletons.
 */
const renderDeadline = 10_000;

const nodeKey = (atom: Atom.Atom<unknown>) =>
  Atom.isSerializable(atom) ? atom[Atom.SerializableTypeId].key : atom;

/**
 * Reads whose values the document carries only once a check succeeds. A server render that
 * waits for a check before it renders a page can start the page's reads with the check; this
 * keeps the page's data out of the document unless the check succeeded, even when those reads
 * succeeded first.
 */
const documentGuards = (registry: AtomRegistry.AtomRegistry) => {
  const guards = new Map<
    Atom.Atom<unknown>,
    {
      /** The check's verdict, or `undefined` while it has no outcome. */
      readonly decide: () => boolean | undefined;
      readonly keys: Set<string>;
      allowed: boolean | undefined;
    }
  >();
  return {
    /**
     * Start `check`, then the reads it guards. The guard covers each read and every atom that
     * starting it created, such as the query a derived read wraps; a read can reach its source
     * without depending on it, so the registry's dependency graph does not name them all. Atoms
     * that already existed, such as the session or the check itself, belong to other parts of
     * the page and are not covered.
     */
    start: <A, E>(
      check: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
      reads: ReadonlyArray<Atom.Atom<unknown>>,
    ) => {
      const existing = guards.get(check);
      const guard = existing ?? {
        decide: () => {
          const outcome = registry.get(check);
          return AsyncResult.isInitial(outcome) ? undefined : AsyncResult.isSuccess(outcome);
        },
        keys: new Set<string>(),
        allowed: undefined,
      };
      if (existing === undefined) guards.set(check, guard);
      registry.mount(check);
      const cover = (atom: Atom.Atom<unknown>) => {
        const key = nodeKey(atom);
        if (typeof key === "string") guard.keys.add(key);
      };
      const notify = registry.onNodeAdded;
      registry.onNodeAdded = (node) => {
        cover(node.atom);
        notify?.(node);
      };
      try {
        for (const read of reads) {
          cover(read);
          registry.mount(read);
        }
      } finally {
        registry.onNodeAdded = notify;
      }
    },
    /**
     * Keys of values the document must not carry: every key a guard covers until its check
     * succeeds. A failed check withholds them for good; so does one that never answers, including
     * past the render deadline.
     */
    withheld: () => {
      const keys = new Set<string>();
      for (const guard of guards.values()) {
        guard.allowed ??= guard.decide();
        if (guard.allowed !== true) for (const key of guard.keys) keys.add(key);
      }
      return keys;
    },
  };
};
type DocumentGuards = ReturnType<typeof documentGuards>;

const DocumentGuardsContext = createContext<DocumentGuards | undefined>(undefined);

const subscribeNever = () => () => {};

/**
 * Start reads with `check` instead of after it. A page whose server render waits for an access
 * check uses this so its reads do not wait for the check. Only a successful `check` releases
 * them: until then the document carries none of their data, including reads that succeeded
 * first, and a refusal, a failure or no answer releases nothing.
 *
 * Returns whether the caller may render what the reads feed. On the server and while the browser
 * hydrates that document, only a successful `check` allows it, so both render the same markup.
 * Once hydrated the browser renders as it does on its own, starting its reads as it renders.
 */
export const useGuardedPreload = <A, E>(
  check: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  reads: ReadonlyArray<Atom.Atom<unknown>>,
): boolean => {
  const guards = useContext(DocumentGuardsContext);
  if (guards !== undefined) guards.start(check, reads);
  const succeeded = AsyncResult.isSuccess(useAtomValue(check));
  // The verdict itself is the snapshot, so a document whose check succeeded does not re-render
  // here after hydration; that update would reach regions still waiting to hydrate.
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => succeeded,
  );
};

/**
 * React reads through this view of the request's registry. Atoms stay mounted until the request
 * ends so a resolved value cannot be discarded between React's suspension and its retry.
 */
const suspendingRegistry = (registry: AtomRegistry.AtomRegistry): AtomRegistry.AtomRegistry => {
  let pastDeadline = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    deadline = setTimeout(() => {
      pastDeadline = true;
      resolve();
    }, renderDeadline);
  });
  const mounted = new Set<Atom.Atom<unknown>>();
  const waiting = new Map<Atom.Atom<unknown>, Promise<void>>();
  const nodeOf = (atom: Atom.Atom<unknown>) => registry.getNodes().get(nodeKey(atom));
  /**
   * Reads in flight beneath an atom. A component may combine several queries in a derived atom
   * whose own value is not a result, so the render waits for what that atom depends on.
   */
  const pendingDependencies = (atom: Atom.Atom<unknown>) => {
    const pending: Array<Atom.Atom<unknown>> = [];
    const seen = new Set<AtomRegistry.Node<unknown>>();
    const visit = (node: AtomRegistry.Node<unknown> | undefined) => {
      if (node === undefined || seen.has(node)) return;
      seen.add(node);
      if (node.atom !== atom && pendingResult(node.value())) pending.push(node.atom);
      for (const parent of node.parents) visit(parent);
    };
    visit(nodeOf(atom));
    return pending;
  };
  const settle = (atom: Atom.Atom<unknown>) => {
    const existing = waiting.get(atom);
    if (existing !== undefined) return existing;
    const settled = new Promise<void>((resolve) => {
      const cancel = registry.subscribe(atom, (value) => {
        if (pendingResult(value)) return;
        cancel();
        resolve();
      });
    });
    const promise = Promise.race([expired, settled]).then(() => {
      waiting.delete(atom);
    });
    waiting.set(atom, promise);
    return promise;
  };
  return {
    [AtomRegistry.TypeId]: AtomRegistry.TypeId,
    get scheduler() {
      return registry.scheduler;
    },
    get schedulerAsync() {
      return registry.schedulerAsync;
    },
    getNodes: () => registry.getNodes(),
    get: (atom) => {
      if (!mounted.has(atom)) {
        mounted.add(atom);
        registry.mount(atom);
      }
      const value = registry.get(atom);
      if (pastDeadline) return value;
      // React retries the render once the reads settle; the boundary's fallback streams meanwhile.
      if (pendingResult(value)) throw settle(atom);
      const dependencies = pendingDependencies(atom);
      if (dependencies.length > 0) throw Promise.all(dependencies.map(settle));
      return value;
    },
    mount: (atom) => registry.mount(atom),
    refresh: (atom) => registry.refresh(atom),
    set: (atom, value) => registry.set(atom, value),
    setSerializable: (key, encoded) => registry.setSerializable(key, encoded),
    modify: (atom, f) => registry.modify(atom, f),
    update: (atom, f) => registry.update(atom, f),
    subscribe: (atom, f, options) => registry.subscribe(atom, f, options),
    reset: () => registry.reset(),
    dispose: () => {
      clearTimeout(deadline);
      registry.dispose();
    },
  };
};

/** Stream settled values after the first flush; values rendered in the shell go in the first one. */
const streamAtoms = (
  router: AnyRouter,
  registry: AtomRegistry.AtomRegistry,
  dispose: () => void,
  guards: DocumentGuards,
) => {
  const original = router.options.dehydrate;
  router.serverSsrLifecycle = {
    ...router.serverSsrLifecycle,
    onServerSsrAttach: [
      ...(router.serverSsrLifecycle?.onServerSsrAttach ?? []),
      // The request owns every atom fiber, including in-process reads still in flight.
      (serverSsr) => serverSsr.onCleanup(dispose),
    ],
  };
  router.options.dehydrate = async () => {
    const dehydrated = await original?.();
    // A value can change after it was sent, such as an organization target that a later access
    // check records. Send each settled value again whenever its encoding changes.
    const sent = new Map<string, string>();
    const settled = () => {
      const values: Array<Hydration.DehydratedAtomValue> = [];
      const withheld = guards.withheld();
      for (const [key, node] of registry.getNodes()) {
        if (typeof key !== "string" || !Atom.isSerializable(node.atom) || withheld.has(key))
          continue;
        const value = node.value();
        // Only outcomes are sent. An interrupted read ended with this request, not its data.
        if (
          AsyncResult.isAsyncResult(value) &&
          (AsyncResult.isInitial(value) ||
            (AsyncResult.isFailure(value) && Cause.hasInterruptsOnly(value.cause)))
        )
          continue;
        // A value outside the atom's codec, such as a transport failure, is read again by the
        // browser after hydration.
        let encoded: unknown;
        try {
          encoded = node.atom[Atom.SerializableTypeId].encode(value);
        } catch {
          continue;
        }
        const json = JSON.stringify(encoded);
        if (sent.get(key) === json) continue;
        sent.set(key, json);
        values.push({
          "~effect/reactivity/Hydration/DehydratedAtom": true,
          key,
          value: encoded,
          dehydratedAt: Date.now(),
        });
      }
      return values;
    };
    const initial = settled();
    let controller!: ReadableStreamDefaultController<ReadonlyArray<Hydration.DehydratedAtom>>;
    const stream = new ReadableStream<ReadonlyArray<Hydration.DehydratedAtom>>({
      start: (value) => {
        controller = value;
      },
    });
    let open = true;
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      if (!open) return;
      const values = settled();
      if (values.length > 0) controller.enqueue(values);
    };
    // Settled values are sent in the same task, before React retries the suspended render.
    const schedule = () => {
      if (scheduled || !open) return;
      scheduled = true;
      queueMicrotask(flush);
    };
    for (const node of registry.getNodes().values()) registry.subscribe(node.atom, schedule);
    registry.onNodeAdded = (node) => {
      registry.subscribe(node.atom, schedule);
    };
    router.serverSsr?.onRenderFinished(() => {
      flush();
      open = false;
      controller.close();
    });
    return { ...dehydrated, atoms: { initial, stream } satisfies DehydratedAtoms };
  };
};

/**
 * New values preload atoms before they are first read. A later value for an atom the page has
 * already created replaces its state, when that atom is writable state rather than a query. A
 * query the page started before its value arrived, such as one in a region the browser rendered
 * itself, takes the server's value while it is still loading; a value the browser already has
 * is newer than the page's.
 */
const applyAtoms = (
  registry: AtomRegistry.AtomRegistry,
  values: ReadonlyArray<Hydration.DehydratedAtom>,
) => {
  const nodes = registry.getNodes();
  const loading: Array<Atom.Atom<unknown>> = [];
  const fresh = Hydration.toValues(values).filter((entry) => {
    const node = nodes.get(entry.key);
    if (node === undefined || !Atom.isSerializable(node.atom)) return true;
    const atom = node.atom;
    if (Atom.isWritable(atom)) {
      registry.set(atom, atom[Atom.SerializableTypeId].decode(entry.value));
      return false;
    }
    // A node that has not been read yet takes the preloaded value when it is.
    if (node.currentState() !== "valid") return true;
    const current = node.value();
    if (!AsyncResult.isAsyncResult(current) || !AsyncResult.isInitial(current)) return false;
    loading.push(atom);
    return true;
  });
  Hydration.hydrate(registry, fresh);
  // Reading an existing node applies its preloaded value and notifies the components using it.
  for (const atom of loading) registry.get(atom);
};

/** Apply the server's values before hydration reaches the components that read them. */
const hydrateAtoms = (router: AnyRouter, registry: AtomRegistry.AtomRegistry) => {
  const original = router.options.hydrate;
  router.options.hydrate = async (dehydrated: { readonly atoms: DehydratedAtoms }) => {
    await original?.(dehydrated);
    applyAtoms(registry, dehydrated.atoms.initial);
    const reader = dehydrated.atoms.stream.getReader();
    void (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        applyAtoms(registry, value);
      }
    })().catch((error: unknown) => console.error("Dashboard data stream failed", error));
  };
};

/**
 * Create the registry for one router. `initialValues` are values known before rendering, such as
 * browser entry data or a server-verified session. `connect` joins it to Start's streaming.
 */
type InitialValues = NonNullable<
  NonNullable<Parameters<typeof AtomRegistry.make>[0]>["initialValues"]
>;

export const dashboardRegistry = (initialValues: InitialValues) => {
  const registry = import.meta.env.SSR
    ? AtomRegistry.make({ initialValues })
    : AtomRegistry.make({ initialValues, scheduleTask, defaultIdleTTL: 400 });
  const view = import.meta.env.SSR ? suspendingRegistry(registry) : registry;
  const guards = import.meta.env.SSR ? documentGuards(registry) : undefined;
  return {
    registry,
    connect: <R extends AnyRouter>(router: R): R => {
      if (guards === undefined) hydrateAtoms(router, registry);
      else streamAtoms(router, registry, () => view.dispose(), guards);
      return router;
    },
    Wrap: ({ children }: { readonly children: ReactNode }) => (
      <RegistryContext.Provider value={view}>
        <DocumentGuardsContext value={guards}>{children}</DocumentGuardsContext>
      </RegistryContext.Provider>
    ),
  };
};
