/// <reference types="vite/client" />
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Atom, AtomRegistry } from "effect/reactivity";
import { displayFormatAtom } from "@executor-js/ui/contracts/display";
import type { DocumentApi } from "./document.ts";

export { inProcessOrigin } from "@executor-js/ui/contracts/http";

const missingDocumentFetch: typeof globalThis.fetch = () =>
  Promise.reject(new TypeError("This render has no in-process API fetch"));

const browserFetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);
export const apiFetchAtom = Atom.make((): typeof globalThis.fetch =>
  import.meta.env.SSR ? missingDocumentFetch : browserFetch,
).pipe(Atom.keepAlive);

export const apiFetchLayer = Layer.effect(
  FetchHttpClient.Fetch,
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry;
    return registry.get(apiFetchAtom);
  }),
);

export const dashboardAtoms = (browser: Atom.RuntimeFactory): Atom.RuntimeFactory => {
  const atoms = import.meta.env.SSR ? Atom.context() : browser;
  atoms.addGlobalLayer(apiFetchLayer);
  return atoms;
};

export const documentValues = (document: DocumentApi) => [
  Atom.initialValue(apiFetchAtom, document.apiFetch),
  Atom.initialValue(displayFormatAtom, document.display),
];
