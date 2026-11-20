/**
 * Which route each app request of one incoming request takes on Cloud: the direct network, or a
 * relay object with its own connection limit.
 *
 * Cloudflare lets one incoming request have six connections waiting for response headers and queues
 * the rest until one is answered. Every app call that request makes counts against it, and so does
 * the host's own work for it (storage, service calls, build reads). A request to a Durable Object
 * waits on the object's own limit instead, at a cost: 10-15 ms on an object in use, 300-450 ms when
 * the object starts (measured on a test stage, November 2026).
 *
 * So a request goes direct while its incoming request has fewer than `directLimit` app requests
 * waiting for headers, which leaves the sixth connection to the host. Otherwise it waits for a
 * direct slot, holding no connection: against a fast service one frees within milliseconds. A
 * request still waiting after `relayAfter` goes through a relay object instead; it was going to
 * wait behind slow requests, so an object's start costs it little. While this isolate's direct
 * route is not known to be answering, it waits `relayColdAfter` instead (see there). At most
 * `relayLimit` requests of one incoming request are in relay objects at once; past that they wait
 * for either route.
 *
 * Requests are counted by the group the host names for the incoming request
 * (`AppInvocation.outboundGroup`), and only while that group lives: while a call of it runs, or a
 * request it counted still waits, for headers on either route or for a route. So a group app code
 * names itself counts for nothing and its requests go direct, as every request did before relays,
 * and a later call of an incoming request counts the requests an earlier call left waiting. Every
 * counted request is released however it ends.
 * Waiters are resumed through native promises, never Effect primitives, so each continues in its
 * own request's I/O context (see `handoff.ts` in the SDK).
 */

/** App requests one incoming request may have waiting for headers directly; Cloudflare allows six. */
export const directLimit = 5;
/** How long a request waits for a direct slot before it goes through a relay object, in ms. */
export const relayAfter = 50;
/**
 * How long a request waits for a direct slot instead, in ms, while this isolate's direct route is
 * not known to be answering: no direct request of it has had headers in the last `answeringFor`.
 * A slow first answer then is the Worker starting, not a slow service, and a relay object starting
 * (300-450 ms) would not answer sooner. After 60 s idle, programs of 6 to 10 calls to a 20 ms
 * service relayed in 6 of 6 with the 50 ms wait (slowest call 127-243 ms behind the fastest), and
 * in none of 20 with this one (at most 5 ms behind; test stages, November 2026).
 */
export const relayColdAfter = 500;
/** How long after a direct request's headers the direct route counts as answering, in ms. */
export const answeringFor = 30_000;
/** App requests one incoming request may have in relay objects at once. */
export const relayLimit = 50;

export type Route = "direct" | "relay";

/** A route taken; `release` once the request's headers arrive or it fails. */
export interface Taken {
  readonly route: Route;
  /** The relay object's slot, for a relayed request. */
  readonly slot: number | undefined;
  /** How long the request waited for its route, in milliseconds. */
  readonly waited: number;
  readonly release: () => void;
}

/**
 * Relay object slots of one AppData isolate. An object carries one request at a time until its
 * headers arrive (one object given ten at once answered them in four steps), so a freed slot is
 * reused before a new one is named.
 */
class Slots {
  readonly #free: Array<number> = [];
  #next = 0;
  acquire() {
    return this.#free.pop() ?? this.#next++;
  }
  release(slot: number) {
    this.#free.push(slot);
  }
}

interface Waiter {
  /** False for a request a relay cannot carry (a WebSocket upgrade). */
  readonly relayable: boolean;
  /** Waited `relayAfter` without a direct slot. */
  waited: boolean;
  readonly grant: (route: Route) => void;
}

/** The app requests of one incoming request. */
class Group {
  holds = 0;
  direct = 0;
  relayed = 0;
  readonly waiting: Array<Waiter> = [];

  constructor(
    readonly slots: Slots,
    /** Called whenever a count falls, so the group is forgotten once it is idle. */
    readonly settled: () => void,
  ) {}

  /** No call holds the group and none of its requests is counted. */
  get idle() {
    return this.holds === 0 && this.direct === 0 && this.relayed === 0 && this.waiting.length === 0;
  }

  take(route: Route, waited: number): Taken {
    const slot = route === "relay" ? this.slots.acquire() : undefined;
    if (slot === undefined) this.direct++;
    else this.relayed++;
    let released = false;
    return {
      route,
      slot,
      waited,
      release: () => {
        if (released) return;
        released = true;
        if (slot === undefined) {
          this.direct--;
          this.waiting.shift()?.grant("direct");
        } else {
          this.relayed--;
          this.slots.release(slot);
          this.relayWaiters();
        }
        this.settled();
      },
    };
  }

  /** Relay the waiters that waited `relayAfter`, oldest first, while relay room remains. */
  relayWaiters() {
    let index = 0;
    while (index < this.waiting.length && this.relayed < relayLimit) {
      const waiter = this.waiting[index];
      if (waiter?.relayable === true && waiter.waited) {
        this.waiting.splice(index, 1);
        waiter.grant("relay");
      } else index++;
    }
  }
}

/** How a request is sent on each route. */
export interface Transport {
  readonly direct: (request: Request) => Promise<Response>;
  readonly relay: (slot: number, request: Request) => Promise<Response>;
}

/** How one request was sent, for its span: the route, the wait for it and the wait for headers. */
export type Sent = Record<string, string | number | boolean>;

/** The groups of one AppData isolate's outbound requests. */
export const appOutboundRoutes = () => {
  const groups = new Map<string, Group>();
  const slots = new Slots();
  /** When a direct request of this isolate last had headers (`Date.now()`). */
  let answeredAt = Number.NEGATIVE_INFINITY;
  const directAnswering = () => Date.now() - answeredAt < answeringFor;
  const answered = () => {
    answeredAt = Date.now();
  };
  /**
   * The route for one request of `group`, once it is free. A request whose group does not live
   * (no call holds it and none of its requests is counted) goes direct and is not counted. A request a relay cannot carry (`relayable` false) waits for a
   * direct slot however long that takes. Rejects with the signal's reason when the request is
   * cancelled while it waits.
   */
  const take = (name: string | null, relayable: boolean, signal: AbortSignal): Promise<Taken> => {
    const group = name === null ? undefined : groups.get(name);
    if (group === undefined)
      return Promise.resolve({
        route: "direct",
        slot: undefined,
        waited: 0,
        release: () => undefined,
      });
    if (group.waiting.length === 0 && group.direct < directLimit)
      return Promise.resolve(group.take("direct", 0));
    if (signal.aborted) return Promise.reject(signal.reason);
    const started = performance.now();
    return new Promise<Taken>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancelled = () => {
        clearTimeout(timer);
        const index = group.waiting.indexOf(waiter);
        if (index >= 0) group.waiting.splice(index, 1);
        group.settled();
        reject(signal.reason);
      };
      const waiter: Waiter = {
        relayable,
        waited: false,
        grant: (route) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", cancelled);
          resolve(group.take(route, performance.now() - started));
        },
      };
      group.waiting.push(waiter);
      signal.addEventListener("abort", cancelled, { once: true });
      if (relayable)
        timer = setTimeout(
          () => {
            waiter.waited = true;
            group.relayWaiters();
          },
          directAnswering() ? relayAfter : relayColdAfter,
        );
    });
  };
  return {
    /** A direct request has had its headers: the direct route is answering. */
    answered,
    /**
     * Count requests named `group` until the returned function is called. Calls of one incoming
     * request hold it together; once none holds it and none of its requests is counted, the name
     * is forgotten.
     */
    hold: (name: string) => {
      let group = groups.get(name);
      if (group === undefined) {
        const created = new Group(slots, () => {
          if (created.idle && groups.get(name) === created) groups.delete(name);
        });
        group = created;
        groups.set(name, group);
      }
      const held = group;
      held.holds++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held.holds--;
        held.settled();
      };
    },
    take,
    /**
     * Send one request of `group` on the route it takes, recording how in `sent`. Its route is
     * released once its headers arrive or it fails, however it fails: a send that throws before
     * returning a promise included.
     */
    send: async (
      name: string | null,
      request: Request,
      transport: Transport,
      sent: Array<Sent>,
    ): Promise<Response> => {
      // A relay cannot carry a WebSocket upgrade, so one waits for a direct slot.
      const taken = await take(name, !request.headers.has("upgrade"), request.signal);
      const record: Sent = { route: taken.route, wait_ms: Math.round(taken.waited) };
      sent.push(record);
      const started = performance.now();
      try {
        const response = await (taken.slot === undefined
          ? transport.direct(request)
          : transport.relay(taken.slot, request));
        record.headers_ms = Math.round(performance.now() - started);
        if (taken.route === "direct") answered();
        return response;
      } finally {
        taken.release();
      }
    },
  };
};
