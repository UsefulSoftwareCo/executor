/// <reference types="vite/client" />
import { RegistryContext, scheduleTask, useAtomValue } from "@effect/atom-react";
import type { AnyRouter, ParsedLocation, StaticDataRouteOption } from "@tanstack/react-router";
import { Cause, Schema } from "effect";
import { AsyncResult, Atom, AtomRegistry, Hydration } from "effect/reactivity";
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { nodeKey } from "./loaded-value.ts";

interface DehydratedAtoms {
  readonly initial: ReadonlyArray<Hydration.DehydratedAtom>;
  readonly stream: ReadableStream<ReadonlyArray<Hydration.DehydratedAtom>>;
}

const pendingResult = (value: unknown) =>
  AsyncResult.isAsyncResult(value) && AsyncResult.isInitial(value) && value.waiting;

const renderDeadline = 10_000;

const documentGuards = (registry: AtomRegistry.AtomRegistry) => {
  const guards = new Map<
    Atom.Atom<unknown>,
    {
      readonly decide: () => boolean | undefined;
      readonly keys: Set<string>;
      allowed: boolean | undefined;
    }
  >();
  return {
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

export const useGuardedPreload = <A, E>(
  check: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  reads: ReadonlyArray<Atom.Atom<unknown>>,
): boolean => {
  const guards = useContext(DocumentGuardsContext);
  if (guards !== undefined) guards.start(check, reads);
  const succeeded = AsyncResult.isSuccess(useAtomValue(check));
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => succeeded,
  );
};

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
    ensureNode: (atom) => registry.ensureNode(atom),
    get: (atom) => {
      if (!mounted.has(atom)) {
        mounted.add(atom);
        registry.mount(atom);
      }
      const value = registry.get(atom);
      if (pastDeadline) return value;
      if (pendingResult(value)) throw settle(atom);
      const dependencies = pendingDependencies(atom);
      if (dependencies.length > 0) throw Promise.all(dependencies.map(settle));
      return value;
    },
    mount: (atom) => registry.mount(atom),
    refresh: (atom) => registry.refresh(atom),
    set: (atom, value) => registry.set(atom, value),
    setSerializable: (key, encoded) => registry.setSerializable(key, encoded),
    get preloadedSerializable() {
      return registry.preloadedSerializable;
    },
    modify: (atom, f) => registry.modify(atom, f),
    update: (atom, f) => registry.update(atom, f),
    subscribe: (atom, f, options) => registry.subscribe(atom, f, options),
    reset: () => registry.reset(),
    dispose: () => {
      clearTimeout(deadline);
      registry.dispose();
    },
    scheduleNodeRemoval: (node) => registry.scheduleNodeRemoval(node),
  };
};

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
      (serverSsr) => serverSsr.onCleanup(dispose),
    ],
  };
  router.options.dehydrate = async () => {
    const dehydrated = await original?.();
    const sent = new Map<string, string>();
    const settled = () => {
      const values: Array<Hydration.DehydratedAtomValue> = [];
      const withheld = guards.withheld();
      for (const [key, node] of registry.getNodes()) {
        if (typeof key !== "string" || !Atom.isSerializable(node.atom) || withheld.has(key))
          continue;
        const value = node.value();
        if (
          AsyncResult.isAsyncResult(value) &&
          (AsyncResult.isInitial(value) ||
            (AsyncResult.isFailure(value) && Cause.hasInterruptsOnly(value.cause)))
        )
          continue;
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
      registry.set(
        atom,
        atom[Atom.SerializableTypeId].decode(Schema.decodeUnknownSync(Schema.Json)(entry.value)),
      );
      return false;
    }
    if (node.currentState() !== "valid") return true;
    const current = node.value();
    if (!AsyncResult.isAsyncResult(current) || !AsyncResult.isInitial(current)) return false;
    loading.push(atom);
    return true;
  });
  Hydration.hydrate(registry, fresh);
  for (const atom of loading) registry.get(atom);
};

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

export type RouteReads = (
  match: {
    readonly staticData: StaticDataRouteOption;
    readonly params: Readonly<Record<string, unknown>>;
  },
  get: <A>(atom: Atom.Atom<A>) => A,
) => ReadonlyArray<Atom.Atom<unknown>>;

const prefetchHold = 10_000;

const prefetchRouteReads = (
  router: AnyRouter,
  registry: AtomRegistry.AtomRegistry,
  reads: RouteReads,
) => {
  const start = (location: ParsedLocation) => {
    const get = <A,>(atom: Atom.Atom<A>) => registry.get(atom);
    for (const atom of router.matchRoutes(location).flatMap((match) => reads(match, get)))
      setTimeout(registry.mount(atom), prefetchHold);
  };
  const preload = router.preloadRoute;
  router.preloadRoute = (options) => {
    start(router.buildLocation(options as Parameters<typeof router.buildLocation>[0]));
    return preload(options);
  };
  router.subscribe("onBeforeLoad", ({ toLocation }) => start(toLocation));
};

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
    /** A server render starts its reads with the document; `reads` starts them in the browser. */
    connect: <R extends AnyRouter>(router: R, reads?: RouteReads): R => {
      if (guards === undefined) {
        hydrateAtoms(router, registry);
        if (reads !== undefined) prefetchRouteReads(router, registry, reads);
      } else streamAtoms(router, registry, () => view.dispose(), guards);
      return router;
    },
    Wrap: ({ children }: { readonly children: ReactNode }) => (
      <RegistryContext.Provider value={view}>
        <DocumentGuardsContext value={guards}>{children}</DocumentGuardsContext>
      </RegistryContext.Provider>
    ),
  };
};
