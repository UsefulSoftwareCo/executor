/// <reference types="vite/client" />
/**
 * The fetch every dashboard API client uses. Browsers use the network. A server-rendered
 * document replaces it with an in-process fetch bound to that request; see `in-process.ts`.
 */
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Atom, AtomRegistry } from "effect/reactivity";
import { displayFormatAtom } from "@executor-js/ui/contracts/display";
import type { DocumentApi } from "./document.ts";

export { inProcessOrigin } from "@executor-js/ui/contracts/http";

/** Rendering on the server without a document's fetch is a composition bug. */
const missingDocumentFetch: typeof globalThis.fetch = () =>
  Promise.reject(new TypeError("This render has no in-process API fetch"));

/** Set per registry. The server's registry receives the document request's in-process fetch. */
const browserFetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);
export const apiFetchAtom = Atom.make((): typeof globalThis.fetch =>
  import.meta.env.SSR ? missingDocumentFetch : browserFetch,
).pipe(Atom.keepAlive);

/** Supplies the registry's fetch to Effect's Fetch HTTP client in dashboard atom runtimes. */
export const apiFetchLayer = Layer.effect(
  FetchHttpClient.Fetch,
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry;
    return registry.get(apiFetchAtom);
  }),
);

/**
 * Dashboard atoms run with the product's browser telemetry in the browser. On the server they
 * share nothing between registries, so no request's services or data reach another request.
 */
export const dashboardAtoms = (browser: Atom.RuntimeFactory): Atom.RuntimeFactory => {
  const atoms = import.meta.env.SSR ? Atom.context() : browser;
  atoms.addGlobalLayer(apiFetchLayer);
  return atoms;
};

/** Values every server registry starts from: the document's API and display format. */
export const documentValues = (document: DocumentApi) => [
  Atom.initialValue(apiFetchAtom, document.apiFetch),
  Atom.initialValue(displayFormatAtom, document.display),
];
