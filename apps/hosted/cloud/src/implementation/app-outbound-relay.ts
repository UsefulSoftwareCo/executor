/**
 * The relay objects AppData sends app requests through when no direct slot frees in time; see
 * `app-outbound-routes.ts`. It imports nothing, so a check can load it into workerd as it is.
 */

/**
 * `AppOutboundRelay`'s code: objects that send one app request each on the same network as
 * `AppOutbound`. A request to a Durable Object runs in that object's invocation, with its own limit
 * of six connections waiting for response headers, and the caller's wait for the object does not
 * count against the caller's six (measured on Cloudflare, November 2026); see
 * `app-outbound-routes.ts` for when a request goes this way.
 *
 * `send` takes the request without its signal, which RPC does not carry, and `cancel`, a function
 * of the caller's that settles when the app aborts the request and rejects once the caller is gone;
 * either stops the wait for headers. After the headers, cancelling the response body reaches the
 * service through the stream. The default entrypoint answers nothing.
 */
export const relayScript = `import { DurableObject } from "cloudflare:workers";
export default {
  fetch() { return new Response(null, { status: 404 }); }
};
export class AppOutboundRelay extends DurableObject {
  async send(request, cancel) {
    const controller = new AbortController();
    let answered = false;
    const stop = () => { if (!answered) controller.abort(); };
    cancel.aborted().then(stop, stop);
    const response = await fetch(new Request(request, { signal: controller.signal }));
    answered = true;
    return response;
  }
}`;

/** What a relay object answers: `send` in `relayScript`. */
export interface Relay {
  send(request: Request, cancel: RelayCancel): Promise<Response>;
}

/** The relay Worker's object namespace, as AppData binds it. */
export interface RelayObjects {
  idFromName(name: string): unknown;
  get(id: unknown): Relay;
}

/**
 * Settles when the app aborts its request; a relay object stops waiting for headers then. RPC
 * passes the function as a stub, so a lost caller rejects the object's call to it.
 */
export interface RelayCancel {
  readonly aborted: () => Promise<void>;
}
const relayCancel = (signal: AbortSignal): RelayCancel => ({
  aborted: () =>
    new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    }),
});

/** Relay objects are named by slot within this isolate, so no other isolate's requests share one. */
const relayName = (() => {
  // Named on first use: a Worker may not generate random values at startup.
  let isolate: string | undefined;
  return (slot: number) => `${(isolate ??= crypto.randomUUID())}:${slot}`;
})();

/** Send `request` through the relay object in `slot`. */
export const relayed = (objects: RelayObjects, slot: number, request: Request) => {
  // RPC carries no AbortSignal; the object hears of an abort through `RelayCancel`.
  const unsignalled = new Request(request, { signal: null });
  return objects
    .get(objects.idFromName(relayName(slot)))
    .send(unsignalled, relayCancel(request.signal));
};
