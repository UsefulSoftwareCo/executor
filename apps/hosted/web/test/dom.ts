import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Install the DOM used by these tests. Node's fetch rejects a DOM AbortSignal
 * from another realm, so Node's own abort primitives stay in place; client
 * libraries then cancel real requests instead of failing every call.
 */
export const registerBrowser = (url: string): void => {
  const { AbortController, AbortSignal } = globalThis;
  GlobalRegistrator.register({ url });
  Object.defineProperty(globalThis, "AbortController", {
    configurable: true,
    value: AbortController,
  });
  Object.defineProperty(globalThis, "AbortSignal", { configurable: true, value: AbortSignal });
};
