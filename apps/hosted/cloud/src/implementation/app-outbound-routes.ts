export const directLimit = 5;
export const relayAfter = 50;
export const relayColdAfter = 500;
export const answeringFor = 30_000;
export const relayLimit = 50;

export type Route = "direct" | "relay";

export interface Taken {
  readonly route: Route;
  readonly slot: number | undefined;
  readonly waited: number;
  readonly release: () => void;
}

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
  readonly relayable: boolean;
  waited: boolean;
  readonly grant: (route: Route) => void;
}

class Group {
  holds = 0;
  direct = 0;
  relayed = 0;
  readonly waiting: Array<Waiter> = [];

  constructor(
    readonly slots: Slots,
    readonly settled: () => void,
  ) {}

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

export interface Transport {
  readonly direct: (request: Request) => Promise<Response>;
  readonly relay: (slot: number, request: Request) => Promise<Response>;
}

export type Sent = Record<string, string | number | boolean>;

export const appOutboundRoutes = () => {
  const groups = new Map<string, Group>();
  const slots = new Slots();
  let answeredAt = Number.NEGATIVE_INFINITY;
  const directAnswering = () => Date.now() - answeredAt < answeringFor;
  const answered = () => {
    answeredAt = Date.now();
  };
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
    answered,
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
    send: async (
      name: string | null,
      request: Request,
      transport: Transport,
      sent: Array<Sent>,
    ): Promise<Response> => {
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
