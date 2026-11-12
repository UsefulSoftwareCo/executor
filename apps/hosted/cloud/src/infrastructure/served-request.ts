/**
 * The request a Worker event or Durable Object call serves, and the background work its close
 * waits for before the event exports its telemetry.
 *
 * Background work runs in the scope it is offered in, beside the resources that scope holds, and
 * that scope's close waits for it (`executor.ts`). Alchemy exports an event's telemetry after the
 * request's scope closes, so work offered in a nested scope, such as an MCP tool call's operation,
 * could end after the export: its spans then waited in the isolate for another event to export
 * them, or were lost with the isolate. The request's close therefore also waits for the work of
 * every nested scope that offered some while it ran.
 *
 * The request's close waits only while its response is buffered. A streamed response ends when
 * its request's scope has closed, so a wait there would hold the end of the body; that work's
 * spans leave with a later export, as before. Every wait of one request, its own scope's and the
 * nested scopes', shares one bound, so the event's export starts at most `backgroundWait` after
 * the request's close began, whatever was offered.
 */
import { isScopeEjected } from "alchemy/Http";
import { Clock, Context, Duration, Effect, Scope } from "effect";

/**
 * How long a request's close waits for its background work. Cloudflare stops an event's work 30 s
 * after its response; this leaves the event's own cleanup and its export the rest, as before.
 */
export const backgroundWait = Duration.seconds(20);

export class ServedRequest {
  #closing: number | undefined;
  readonly #waits = new Set<Effect.Effect<void>>();

  constructor(
    readonly scope: Scope.Scope,
    /** The other requests a Durable Object serves at the same time, if any. */
    readonly object: ObjectRequests | undefined,
  ) {}

  get open() {
    return this.scope.state._tag !== "Closed";
  }

  /** Wait for `drained` until `backgroundWait` after this request's close began. */
  bounded(drained: Effect.Effect<void>): Effect.Effect<void> {
    return Effect.flatMap(Clock.currentTimeMillis, (now) => {
      this.#closing ??= now;
      const left = this.#closing + Duration.toMillis(backgroundWait) - now;
      return left <= 0 ? Effect.void : Effect.asVoid(Effect.timeoutOption(drained, left));
    });
  }

  /**
   * Make an open request's close wait for a nested scope's `drained` too: this one, or once it
   * has closed, another request its object still serves. A tool call that waited for input
   * across two requests ends while the second is served, so that one exports its work.
   */
  join(drained: Effect.Effect<void>): Effect.Effect<void> {
    return Effect.suspend(() => {
      const request = this.open ? this : this.object?.serving();
      return request === undefined ? Effect.void : request.#wait(drained);
    });
  }

  #wait(drained: Effect.Effect<void>): Effect.Effect<void> {
    if (this.#waits.has(drained)) return Effect.void;
    this.#waits.add(drained);
    if (this.#waits.size > 1) return Effect.void;
    // Added while the scope is open, so it runs when the scope closes, never here.
    return Scope.addFinalizer(
      this.scope,
      Effect.suspend(() =>
        isScopeEjected(this.scope)
          ? Effect.void
          : this.bounded(
              Effect.forEach([...this.#waits], (wait) => wait, {
                concurrency: "unbounded",
                discard: true,
              }),
            ),
      ),
    );
  }
}

/** The requests one Durable Object is serving. */
export class ObjectRequests {
  #requests: Array<ServedRequest> = [];

  /** Serve a request in `scope`. */
  serve(scope: Scope.Scope) {
    this.#requests = this.#requests.filter((request) => request.open);
    const request = new ServedRequest(scope, this);
    this.#requests.push(request);
    return request;
  }

  /** The newest request still open. */
  serving() {
    this.#requests = this.#requests.filter((request) => request.open);
    return this.#requests.at(-1);
  }
}

/** The request the current fiber serves; each request entry sets it. */
export const CurrentRequest = Context.Reference<ServedRequest | undefined>(
  "executor/cloud/CurrentRequest",
  { defaultValue: () => undefined },
);

/** Serve `handler` as a request of its own, outside any Durable Object. */
export const servedRequest = <A, E, R>(handler: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.scope, (scope) =>
    Effect.provideService(handler, CurrentRequest, new ServedRequest(scope, undefined)),
  );

/** Serve `handler` as one of the requests `object` serves. */
export const objectRequest =
  (object: ObjectRequests) =>
  <A, E, R>(handler: Effect.Effect<A, E, R>) =>
    Effect.flatMap(Effect.scope, (scope) =>
      Effect.provideService(handler, CurrentRequest, object.serve(scope)),
    );
