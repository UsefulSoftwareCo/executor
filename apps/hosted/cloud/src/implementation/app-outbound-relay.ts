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

export interface Relay {
  send(request: Request, cancel: RelayCancel): Promise<Response>;
}

export interface RelayObjects {
  idFromName(name: string): unknown;
  get(id: unknown): Relay;
}

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

const relayName = (() => {
  let isolate: string | undefined;
  return (slot: number) => `${(isolate ??= crypto.randomUUID())}:${slot}`;
})();

export const relayed = (objects: RelayObjects, slot: number, request: Request) => {
  const unsignalled = new Request(request, { signal: null });
  return objects
    .get(objects.idFromName(relayName(slot)))
    .send(unsignalled, relayCancel(request.signal));
};
