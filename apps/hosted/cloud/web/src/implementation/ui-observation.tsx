import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/unstable/reactivity";
import { Profiler, useContext, useEffect, useMemo, type ReactNode } from "react";

const visible = (element: Element) =>
  element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
const text = (element: Element) =>
  (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 160);
const route = () => location.pathname.replace(/\/org\/[^/]+/, "/org/:organization");
const rect = (value: DOMRectReadOnly) => ({
  x: Math.round(value.x),
  y: Math.round(value.y),
  width: Math.round(value.width),
  height: Math.round(value.height),
});
const label = (element: Element) => {
  const aria = element.getAttribute("aria-label");
  if (aria) return aria;
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  ) {
    const associated = element.labels?.item(0);
    if (associated) return text(associated);
  }
  if (element.matches('h1,h2,button,label,[role="alert"]')) return text(element);
  return element.getAttribute("name") ?? element.tagName.toLowerCase();
};
const view = () => {
  const all = (selector: string) => Array.from(document.querySelectorAll(selector)).filter(visible);
  const occurrences = new Map<string, number>();
  const landmarks = all(
    'main,aside,nav,form,h1,h2,label,input,button,select,textarea,[role="status"],[role="alert"],[data-slot="skeleton"]',
  )
    .filter((element) => {
      const bounds = element.getBoundingClientRect();
      return (
        element instanceof HTMLElement &&
        bounds.width > 2 &&
        bounds.height > 2 &&
        getComputedStyle(element).opacity !== "0"
      );
    })
    .map((element) => {
      const name = label(element),
        role = element.getAttribute("role") ?? element.tagName.toLowerCase();
      const identity = element.id ? `id:${element.id}` : `${role}:${name}`;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      return {
        key: `${identity}:${occurrence}`,
        label: name,
        role,
        rect: rect(element.getBoundingClientRect()),
      };
    });
  return {
    route: route(),
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    landmarks,
    headings: all("h1,h2").map(text),
    statuses: all('[role="status"]').map(
      (element) => element.getAttribute("aria-label") ?? text(element),
    ),
    alerts: all('[role="alert"]').map(text),
    navigation: all("nav a").map(text),
    controls: all("input,button,select,textarea").map((element) => ({
      role: element.tagName.toLowerCase(),
      name:
        element.getAttribute("aria-label") ??
        element.getAttribute("name") ??
        element.getAttribute("placeholder") ??
        (element.tagName === "BUTTON" ? text(element) : ""),
      disabled: element.hasAttribute("disabled"),
      filled: element instanceof HTMLInputElement && element.value.length > 0,
      edited: element instanceof HTMLInputElement && element.value !== element.defaultValue,
    })),
  };
};

// This observer wraps reads/subscriptions the app already performs. It never mounts
// an atom, reads a node's value itself, or adds a subscription for its own lifetime.
const observe = (registry: AtomRegistry.AtomRegistry) => {
  const names = new WeakMap<object, string>();
  const summaries = new WeakMap<object, string>();
  let nextId = 0,
    count = 0,
    frame: number | undefined,
    running = false;
  let previous = "";
  const reasons = new Set<string>();
  const write = (event: object) => {
    if (++count <= 4000) console.debug(`executor-ui-observation:${JSON.stringify(event)}`);
    else if (count === 4001)
      console.debug(
        `executor-ui-observation:${JSON.stringify({ kind: "audit", at: performance.timeOrigin + performance.now(), label: "Observation limit reached; capture is incomplete" })}`,
      );
  };
  const sample = () => {
    frame = undefined;
    const snapshot = view();
    const signature = JSON.stringify(snapshot);
    if (signature !== previous) {
      previous = signature;
      write({
        kind: "view",
        at: performance.timeOrigin + performance.now(),
        label: [...reasons].join(", "),
        view: snapshot,
      });
    }
    reasons.clear();
  };
  const schedule = (reason: string) => {
    reasons.add(reason);
    if (running && frame === undefined) frame = requestAnimationFrame(sample);
  };
  const signal = (
    kind: "atom" | "commit" | "input" | "audit",
    label: string,
    at = performance.now(),
  ) => {
    write({ kind, label, at: performance.timeOrigin + at });
    if (kind !== "audit") schedule(kind);
  };
  const atom = <A,>(source: Atom.Atom<A>, value: A) => {
    let name = names.get(source);
    if (name === undefined) {
      name = source.label?.[0].startsWith("ui.") ? source.label[0] : `atom-${++nextId}`;
      names.set(source, name);
    }
    const summary = AsyncResult.isAsyncResult(value)
      ? `${AsyncResult.isInitial(value) ? "initial" : AsyncResult.isSuccess(value) ? "success" : "failure"}${value.waiting ? " waiting" : ""}`
      : typeof value === "boolean"
        ? String(value)
        : typeof value;
    if (summaries.get(source) === summary) return;
    summaries.set(source, summary);
    signal("atom", `${name}: ${summary}`);
  };
  const listenerCount = () =>
    [...registry.getNodes().values()].reduce((sum, node) => sum + node.listeners.size, 0);
  const get: AtomRegistry.AtomRegistry["get"] = (source) => {
    const value = registry.get(source);
    atom(source, value);
    return value;
  };
  const subscribe: AtomRegistry.AtomRegistry["subscribe"] = (source, callback, options) => {
    const before = listenerCount();
    const cancel = registry.subscribe(
      source,
      (value) => {
        atom(source, value);
        callback(value);
      },
      options,
    );
    signal("audit", `app subscribe: listener delta ${listenerCount() - before}`);
    return () => {
      cancel();
      signal("audit", `app unsubscribe: ${listenerCount()} listeners remain`);
    };
  };
  const observed = new Proxy(registry, {
    get(target, property, receiver) {
      if (property === "get") return get;
      if (property === "subscribe") return subscribe;
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    registry: observed,
    commit: (phase: string, at: number) => signal("commit", phase, at),
    start: () => {
      running = true;
      const input = () => signal("input", "form input changed; value omitted");
      const layout = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (
            !("value" in entry) ||
            typeof entry.value !== "number" ||
            !("hadRecentInput" in entry) ||
            typeof entry.hadRecentInput !== "boolean"
          )
            continue;
          const items: readonly unknown[] =
            "sources" in entry && Array.isArray(entry.sources) ? entry.sources : [];
          const sources = items.flatMap((source) => {
            if (
              typeof source !== "object" ||
              source === null ||
              !("previousRect" in source) ||
              !(source.previousRect instanceof DOMRectReadOnly) ||
              !("currentRect" in source) ||
              !(source.currentRect instanceof DOMRectReadOnly)
            )
              return [];
            return [
              {
                label:
                  "node" in source && source.node instanceof Element
                    ? label(source.node)
                    : "Element",
                previous: rect(source.previousRect),
                current: rect(source.currentRect),
              },
            ];
          });
          write({
            kind: "layout-shift",
            at: performance.timeOrigin + entry.startTime,
            label: entry.hadRecentInput ? "Layout shifted after input" : "Layout shifted",
            shift: { value: entry.value, hadRecentInput: entry.hadRecentInput, sources },
          });
          schedule("layout shift");
        }
      });
      if (PerformanceObserver.supportedEntryTypes.includes("layout-shift"))
        layout.observe({ type: "layout-shift", buffered: true });
      const viewport = () => schedule("viewport");
      const validateCapture = () => schedule("capture validation");
      window.addEventListener("executor-ui-observation-sample", validateCapture);
      window.addEventListener("resize", viewport);
      window.addEventListener("scroll", viewport, true);
      const mutations = new MutationObserver(() => schedule("DOM"));
      mutations.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      document.addEventListener("input", input, true);
      schedule("observer mounted");
      return () => {
        running = false;
        mutations.disconnect();
        layout.disconnect();
        window.removeEventListener("resize", viewport);
        window.removeEventListener("executor-ui-observation-sample", validateCapture);
        window.removeEventListener("scroll", viewport, true);
        document.removeEventListener("input", input, true);
        if (frame !== undefined) cancelAnimationFrame(frame);
        frame = undefined;
      };
    },
  };
};

function Observed({ children }: { readonly children: ReactNode }) {
  const registry = useContext(RegistryContext);
  const observer = useMemo(() => observe(registry), [registry]);
  useEffect(() => observer.start(), [observer]);
  return (
    <RegistryContext.Provider value={observer.registry}>
      <Profiler
        id="executor"
        onRender={(_id, phase, _duration, _base, _start, commitTime) =>
          observer.commit(phase, commitTime)
        }
      >
        {children}
      </Profiler>
    </RegistryContext.Provider>
  );
}

/** Opt-in development exploration; ordinary and production builds retain the normal registry. */
export function UIObservation({ children }: { readonly children: ReactNode }) {
  return import.meta.env.DEV && import.meta.env.VITE_UI_OBSERVE === "1" ? (
    <Observed>{children}</Observed>
  ) : (
    children
  );
}
